// Import of time entries from CSV files exported by Clockify (detailed report, English or Portuguese headers)
// or filled in Clockify's time entry import template.
import { parse as parseCsv } from 'csv-parse/sync';
import { one, rows, query, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { badRequest } from '../../lib/errors.js';
import { isoToSeconds } from '../../lib/duration.js';
import { zonedTime, isValidTimeZone } from '../../lib/dates.js';
import { resolveRates } from '../../lib/rates.js';
import { audit } from '../../lib/audit.js';
import { DEFAULT_USER_SETTINGS } from '../../lib/settings.js';
import { createImportJob, MAX_LOG_LINES } from './service.js';

export const CSV_FORMATS = ['AUTO', 'DETAILED_REPORT', 'TIMESHEET_TEMPLATE'];
const MAX_ERRORS = 1000;
const COLORS = ['#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5', '#2196F3', '#03A9F4', '#00BCD4', '#009688', '#4CAF50', '#8BC34A', '#CDDC39', '#FFC107', '#FF9800', '#FF5722', '#795548', '#607D8B'];

// Normalized header (lower case, no accents, no parenthesised part) -> logical field
const HEADER_MAP = {
  project: 'project', projeto: 'project',
  client: 'client', cliente: 'client',
  description: 'description', descricao: 'description',
  task: 'task', tarefa: 'task',
  user: 'user', usuario: 'user', 'user name': 'user', 'nome do usuario': 'user',
  group: 'group', grupo: 'group',
  email: 'email', 'e mail': 'email', 'user email': 'email',
  tags: 'tags', tag: 'tags', etiquetas: 'tags', etiqueta: 'tags',
  billable: 'billable', faturavel: 'billable', cobravel: 'billable',
  'start date': 'startDate', 'data de inicio': 'startDate', 'data inicial': 'startDate',
  'start time': 'startTime', 'hora de inicio': 'startTime', 'hora inicial': 'startTime',
  'end date': 'endDate', 'data de termino': 'endDate', 'data de fim': 'endDate', 'data final': 'endDate',
  'end time': 'endTime', 'hora de termino': 'endTime', 'hora de fim': 'endTime', 'hora final': 'endTime',
  duration: 'duration', duracao: 'duration',
  'billable rate': 'billableRate', 'taxa faturavel': 'billableRate', 'taxa cobravel': 'billableRate',
  'billable amount': 'billableAmount', 'valor faturavel': 'billableAmount',
  start: 'start', inicio: 'start', end: 'end', fim: 'end', termino: 'end',
};
const PT_HINTS = ['projeto', 'usuario', 'descricao', 'etiquetas', 'faturavel', 'data de inicio', 'cliente', 'tarefa', 'duracao'];

// --- text decoding / dialect detection -------------------------------------------------------------------------

export function decodeCsv(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t; }
    return { text: new TextDecoder('utf-16le').decode(swapped), encoding: 'utf-16be' };
  }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; } catch { /* not valid utf-8 */ }
  return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
}

export function detectDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

export function normalizeHeader(h) {
  return String(h || '').replace(/^﻿/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function parenthesised(h) {
  const m = /\(([^)]*)\)/.exec(String(h || ''));
  return m ? m[1].trim() : '';
}

// Maps the header row to logical columns. Returns { columns: {field: index}, language, format, currency }.
export function mapHeaders(headers, format = 'AUTO') {
  const columns = {};
  let currency = null;
  let language = 'en';
  headers.forEach((raw, idx) => {
    const norm = normalizeHeader(raw);
    if (!norm) return;
    if (PT_HINTS.includes(norm)) language = 'pt';
    let field = HEADER_MAP[norm];
    if (!field) {
      const key = Object.keys(HEADER_MAP).find((k) => norm.startsWith(`${k} `));
      if (key) field = HEADER_MAP[key];
    }
    if (!field) return;
    const paren = parenthesised(raw).toLowerCase();
    if (field === 'duration' && paren === 'decimal') field = 'durationDecimal';
    if (field === 'billableRate' && paren && /^[a-z]{3}$/.test(paren)) currency = paren.toUpperCase();
    if (columns[field] === undefined) columns[field] = idx;
  });
  let detected = String(format || 'AUTO').toUpperCase();
  if (!CSV_FORMATS.includes(detected)) throw badRequest(`format must be one of ${CSV_FORMATS.join(', ')}`, 400);
  if (detected === 'AUTO') detected = (columns.user !== undefined || columns.group !== undefined || columns.billableRate !== undefined) ? 'DETAILED_REPORT' : 'TIMESHEET_TEMPLATE';
  return { columns, language, format: detected, currency };
}

// --- value parsing ------------------------------------------------------------------------------------------------

export function parseBillable(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (!s) return def;
  if (['yes', 'y', 'sim', 's', 'true', '1', 'x', 'billable', 'faturavel', 'faturável'].includes(s)) return true;
  if (['no', 'n', 'nao', 'não', 'false', '0', 'non-billable', 'nao faturavel', 'não faturável'].includes(s)) return false;
  return def;
}

function parseDateParts(str, dateFormat, defaultMonthFirst) {
  const s = String(str || '').trim();
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return { y: +m[1], mo: +m[2], d: +m[3], rest: s.slice(m[0].length) };
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) {
    const a = +m[1]; const b = +m[2]; let y = +m[3];
    if (y < 100) y += 2000;
    const fmt = String(dateFormat || '').toUpperCase().replace(/[^A-Z]/g, '');
    let monthFirst;
    if (fmt.startsWith('MM')) monthFirst = true;
    else if (fmt.startsWith('DD')) monthFirst = false;
    else if (a > 12) monthFirst = false;
    else if (b > 12) monthFirst = true;
    else monthFirst = defaultMonthFirst;
    if (monthFirst && a > 12 && b <= 12) monthFirst = false;
    if (!monthFirst && b > 12 && a <= 12) monthFirst = true;
    return monthFirst ? { y, mo: a, d: b, rest: s.slice(m[0].length) } : { y, mo: b, d: a, rest: s.slice(m[0].length) };
  }
  throw new Error(`Invalid date "${s}"`);
}

function parseTimeParts(str) {
  const s = String(str || '').trim().replace(/\s+/g, ' ');
  if (!s) return { h: 0, mi: 0, se: 0 };
  const m = /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:[.,](\d+))?\s*([AaPp]\.?[Mm]\.?)?$/.exec(s);
  if (!m) throw new Error(`Invalid time "${s}"`);
  let h = +m[1]; const mi = +(m[2] || 0); const se = +(m[3] || 0);
  const ampm = m[5] ? m[5].toLowerCase().replace(/\./g, '') : null;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 24 || mi > 59 || se > 59) throw new Error(`Invalid time "${s}"`);
  return { h, mi, se };
}

export function parseDateTime(dateStr, timeStr, { dateFormat, timeZone = 'UTC', defaultMonthFirst = false } = {}) {
  if (!dateStr && !timeStr) return null;
  let d;
  if (dateStr) {
    d = parseDateParts(dateStr, dateFormat, defaultMonthFirst);
    if (!timeStr && d.rest && d.rest.trim()) timeStr = d.rest.trim().replace(/^[T ]/, '');
  } else {
    throw new Error('Missing date');
  }
  const t = parseTimeParts(timeStr);
  return zonedTime(timeZone, d.y, d.mo, d.d, t.h, t.mi, t.se);
}

export function parseDurationSeconds(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.includes(':')) return isoToSeconds(s);
  const n = Number(s.replace(',', '.'));
  if (Number.isNaN(n)) throw new Error(`Invalid duration "${s}"`);
  return Math.round(n * 3600);
}

function splitTags(v) {
  return String(v || '').split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
}

function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// --- main -------------------------------------------------------------------------------------------------------

export async function importCsv({ workspace, user, ctx, buffer, fileName, options = {} }) {
  if (!buffer || !buffer.length) throw badRequest('file is required (multipart field "file")', 400);
  const { text, encoding } = decodeCsv(buffer);
  const delimiter = detectDelimiter(text);
  let records;
  try {
    records = parseCsv(text, { delimiter, columns: false, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true, bom: true });
  } catch (err) {
    throw badRequest(`Could not parse CSV: ${err.message}`, 400);
  }
  if (!records.length) throw badRequest('CSV file is empty', 400);
  const headers = records[0];
  const { columns, language, format, currency: headerCurrency } = mapHeaders(headers, options.format);
  const hasStart = columns.startDate !== undefined || columns.start !== undefined;
  if (!hasStart) throw badRequest(`Could not find the start date column. Headers found: ${headers.join(' | ')}`, 400);
  const timeZone = options.timeZone && isValidTimeZone(options.timeZone) ? options.timeZone : (user.settings?.timeZone && isValidTimeZone(user.settings.timeZone) ? user.settings.timeZone : DEFAULT_USER_SETTINGS.timeZone);
  const dateFormat = options.dateFormat || (language === 'pt' ? 'DD/MM/YYYY' : 'MM/DD/YYYY');
  const createMissing = options.createMissing !== false;
  const dryRun = !!options.dryRun;
  const wsId = workspace.id;
  const defaultCurrency = workspace.hourly_rate_currency || 'USD';

  const job = await createImportJob({ workspaceId: wsId, userId: user.id, source: 'CLOCKIFY_CSV', status: 'RUNNING', options: { fileName: fileName || null, format, delimiter, encoding, timeZone, dateFormat, timeFormat: options.timeFormat || null, createMissing, dryRun } });
  await query('UPDATE import_jobs SET started_at = now() WHERE id = $1', [job.id]);
  const log = [];
  const addLog = (m) => { log.push(`${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} ${m}`); if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES); };
  const errors = [];
  const counts = { rows: records.length - 1, created: 0, skipped: 0, errors: 0, users: 0, clients: 0, projects: 0, tasks: 0, tags: 0 };
  const cache = { users: new Map(), usersByName: null, clients: new Map(), projects: new Map(), tasks: new Map(), tags: new Map(), rates: new Map() };
  addLog(`Arquivo ${fileName || '(sem nome)'}: ${counts.rows} linha(s), formato ${format}, delimitador "${delimiter === '\t' ? 'TAB' : delimiter}", codificação ${encoding}, idioma ${language}, fuso ${timeZone}, datas ${dateFormat}${dryRun ? ' (simulação)' : ''}`);

  const cell = (row, field) => (columns[field] === undefined ? '' : String(row[columns[field]] ?? '').trim());

  async function ensureUser(row) {
    const email = cell(row, 'email').toLowerCase();
    const name = cell(row, 'user');
    if (email) {
      if (cache.users.has(email)) return cache.users.get(email);
      let u = await one('SELECT id, name, password_hash FROM users WHERE lower(email) = $1', [email]);
      if (!u) {
        if (!createMissing) throw new Error(`User ${email} not found`);
        u = { id: newId(), name: name || email.split('@')[0] };
        if (!dryRun) {
          await query(`INSERT INTO users (id, email, name, status, settings, active_workspace_id, default_workspace_id) VALUES ($1,$2,$3,'PENDING_EMAIL_VERIFICATION','{}'::jsonb,$4,$4)`, [u.id, email, u.name, wsId]);
        }
        counts.users += 1;
        addLog(`Usuário criado: ${email} (${u.id})`);
      }
      const member = await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsId, u.id]);
      if (!member && !dryRun) await query(`INSERT INTO workspace_members (workspace_id, user_id, status, invited_at) VALUES ($1,$2,'ACTIVE',now()) ON CONFLICT DO NOTHING`, [wsId, u.id]);
      cache.users.set(email, u.id);
      return u.id;
    }
    if (name) {
      if (!cache.usersByName) {
        const list = await rows('SELECT u.id, u.name, u.email FROM users u JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1', [wsId]);
        cache.usersByName = new Map(list.map((u) => [String(u.name).trim().toLowerCase(), u.id]));
      }
      const id = cache.usersByName.get(name.toLowerCase());
      if (!id) throw new Error(`User "${name}" not found in this workspace (add an e-mail column to create users)`);
      return id;
    }
    return user.id;
  }

  async function ensureClient(name) {
    if (!name) return null;
    const key = name.toLowerCase();
    if (cache.clients.has(key)) return cache.clients.get(key);
    let c = await one('SELECT id FROM clients WHERE workspace_id = $1 AND lower(name) = $2', [wsId, key]);
    if (!c) {
      if (!createMissing) throw new Error(`Client "${name}" not found`);
      c = { id: newId() };
      if (!dryRun) await query('INSERT INTO clients (id, workspace_id, name) VALUES ($1,$2,$3)', [c.id, wsId, name]);
      counts.clients += 1;
      addLog(`Cliente criado: ${name}`);
    }
    cache.clients.set(key, c.id);
    return c.id;
  }

  async function ensureProject(name, clientId, billable) {
    if (!name) return null;
    const key = `${name.toLowerCase()}|${clientId || ''}`;
    if (cache.projects.has(key)) return cache.projects.get(key);
    let p = await one('SELECT id, billable FROM projects WHERE workspace_id = $1 AND lower(name) = $2 AND client_id IS NOT DISTINCT FROM $3', [wsId, name.toLowerCase(), clientId]);
    if (!p && clientId) p = await one('SELECT id, billable FROM projects WHERE workspace_id = $1 AND lower(name) = $2 ORDER BY (client_id IS NULL) DESC LIMIT 1', [wsId, name.toLowerCase()]);
    if (!p) {
      if (!createMissing) throw new Error(`Project "${name}" not found`);
      p = { id: newId(), billable: !!billable };
      if (!dryRun) await query('INSERT INTO projects (id, workspace_id, name, client_id, color, billable, is_public) VALUES ($1,$2,$3,$4,$5,$6,$7)', [p.id, wsId, name, clientId, colorFor(name), !!billable, ctx?.settings?.isProjectPublicByDefault !== false]);
      counts.projects += 1;
      addLog(`Projeto criado: ${name}`);
    }
    cache.projects.set(key, p.id);
    return p.id;
  }

  async function ensureTask(name, projectId) {
    if (!name || !projectId) return null;
    const key = `${projectId}|${name.toLowerCase()}`;
    if (cache.tasks.has(key)) return cache.tasks.get(key);
    let t = await one('SELECT id FROM tasks WHERE project_id = $1 AND lower(name) = $2', [projectId, name.toLowerCase()]);
    if (!t) {
      if (!createMissing) throw new Error(`Task "${name}" not found`);
      t = { id: newId() };
      if (!dryRun) await query('INSERT INTO tasks (id, workspace_id, project_id, name) VALUES ($1,$2,$3,$4)', [t.id, wsId, projectId, name]);
      counts.tasks += 1;
      addLog(`Tarefa criada: ${name}`);
    }
    cache.tasks.set(key, t.id);
    return t.id;
  }

  async function ensureTag(name) {
    const key = name.toLowerCase();
    if (cache.tags.has(key)) return cache.tags.get(key);
    let t = await one('SELECT id FROM tags WHERE workspace_id = $1 AND lower(name) = $2', [wsId, key]);
    if (!t) {
      if (!createMissing) throw new Error(`Tag "${name}" not found`);
      t = { id: newId() };
      if (!dryRun) await query('INSERT INTO tags (id, workspace_id, name) VALUES ($1,$2,$3)', [t.id, wsId, name]);
      counts.tags += 1;
      addLog(`Etiqueta criada: ${name}`);
    }
    cache.tags.set(key, t.id);
    return t.id;
  }

  async function ratesFor(userId, projectId, taskId) {
    const key = `${userId}|${projectId || ''}|${taskId || ''}`;
    if (!cache.rates.has(key)) cache.rates.set(key, dryRun ? { hourlyRate: { amount: 0, currency: defaultCurrency }, costRate: { amount: 0 } } : await resolveRates({ workspaceId: wsId, userId, projectId, taskId }));
    return cache.rates.get(key);
  }

  const defaultMonthFirst = language !== 'pt';
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const line = i + 1;
    if (!row.some((v) => String(v ?? '').trim())) continue;
    try {
      const startDate = cell(row, 'startDate') || cell(row, 'start');
      const start = parseDateTime(startDate, cell(row, 'startTime'), { dateFormat, timeZone, defaultMonthFirst });
      if (!start) throw new Error('Missing start date');
      const endDate = cell(row, 'endDate') || cell(row, 'end');
      const endTime = cell(row, 'endTime');
      const durationSeconds = parseDurationSeconds(cell(row, 'duration')) ?? parseDurationSeconds(cell(row, 'durationDecimal'));
      let end = null;
      if (endDate || endTime) {
        end = parseDateTime(endDate || startDate, endTime, { dateFormat, timeZone, defaultMonthFirst });
        if (!endDate && end < start) end = new Date(end.getTime() + 86400000);
      }
      if ((!end || end <= start) && durationSeconds != null && durationSeconds > 0) end = new Date(start.getTime() + durationSeconds * 1000);
      if (!end) throw new Error('Missing end date/time and duration');
      if (end <= start) throw new Error('End must be after start');

      const userId = await ensureUser(row);
      const clientId = await ensureClient(cell(row, 'client'));
      const billable = parseBillable(cell(row, 'billable'), false);
      const projectId = await ensureProject(cell(row, 'project'), clientId, billable);
      const taskId = await ensureTask(cell(row, 'task'), projectId);
      const tagIds = [];
      for (const name of splitTags(cell(row, 'tags'))) { const id = await ensureTag(name); if (id && !tagIds.includes(id)) tagIds.push(id); }
      const description = cell(row, 'description').slice(0, 3000);

      const dup = await one(
        `SELECT id FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND start_time = $3 AND end_time = $4 AND description = $5 AND project_id IS NOT DISTINCT FROM $6 AND deleted_at IS NULL LIMIT 1`,
        [wsId, userId, start, end, description, projectId],
      );
      if (dup) { counts.skipped += 1; continue; }

      const rateCell = cell(row, 'billableRate');
      const rateNum = rateCell ? Number(rateCell.replace(/[^0-9.,-]/g, '').replace(',', '.')) : NaN;
      const rates = await ratesFor(userId, projectId, taskId);
      const hourly = !Number.isNaN(rateNum) && rateCell ? Math.round(rateNum * 100) : rates.hourlyRate.amount;
      const currencyCode = headerCurrency || rates.hourlyRate.currency || defaultCurrency;
      if (!dryRun) {
        await transaction(async () => {
          const id = newId();
          await query(
            `INSERT INTO time_entries (id, workspace_id, user_id, project_id, task_id, description, start_time, end_time, billable, type, hourly_rate_amount, hourly_rate_currency, cost_rate_amount, time_zone, origin)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'REGULAR',$10,$11,$12,$13,'IMPORT')`,
            [id, wsId, userId, projectId, taskId, description, start, end, billable, hourly, currencyCode, rates.costRate.amount, timeZone],
          );
          for (const t of tagIds) await query('INSERT INTO time_entry_tags (time_entry_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, t]);
        });
      }
      counts.created += 1;
    } catch (err) {
      counts.errors += 1;
      if (errors.length < MAX_ERRORS) errors.push({ line, message: err.message });
      addLog(`Linha ${line}: ${err.message}`);
    }
  }

  addLog(`Concluído: ${counts.created} criado(s), ${counts.skipped} duplicado(s) ignorado(s), ${counts.errors} erro(s)`);
  const progress = { stage: 'DONE', current: counts.rows, total: counts.rows, counts, format, delimiter, encoding, timeZone, dateFormat, dryRun };
  await query(`UPDATE import_jobs SET status = 'DONE', progress = $2, log = $3, finished_at = now() WHERE id = $1`, [job.id, JSON.stringify(progress), JSON.stringify(log)]);
  if (!dryRun) {
    await audit({ workspaceId: wsId, userId: user.id, action: 'CREATE_TIME_IMPORT', entityType: 'IMPORT_JOB', entityId: job.id, content: { source: 'CLOCKIFY_CSV', fileName: fileName || null, counts } });
  }
  return { jobId: job.id, format, delimiter, encoding, timeZone, dateFormat, dryRun, created: counts.created, skipped: counts.skipped, errors, counts };
}
