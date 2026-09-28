// Clockify → Clockfy migration service.
// Reads the official Clockify API (see clockifyApi.js) and writes straight to the database preserving the
// original Clockify identifiers, so third-party integrations keep working after switching the base URL.
import { AsyncLocalStorage } from 'node:async_hooks';
import { one, rows, query, transaction } from '../../lib/db.js';
import { newId, isValidId, randomToken } from '../../lib/ids.js';
import { audit } from '../../lib/audit.js';
import { resolveRates } from '../../lib/rates.js';
import { isoToSeconds, secondsToIso } from '../../lib/duration.js';
import { toIso } from '../../lib/dates.js';
import { DEFAULT_USER_SETTINGS, DEFAULT_WORKSPACE_SETTINGS } from '../../lib/settings.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { createWorkspace } from '../workspaces/service.js';
import { normalizeValue } from '../customFields/index.js';
import { ClockifyClient, ClockifyApiError, ImportCancelledError } from './clockifyApi.js';

export const ENTITIES = ['workspace', 'users', 'userGroups', 'clients', 'projects', 'tasks', 'tags', 'customFields', 'timeEntries', 'expenses', 'holidays', 'timeOff', 'approvals', 'scheduling', 'invoices', 'webhooks'];
export const MODES = ['INTO_CURRENT', 'NEW_WORKSPACE'];
export const DEFAULT_SINCE = '2010-01-01';
export const MAX_LOG_LINES = 500;

const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN_SUBMISSION', 'WITHDRAWN_APPROVAL'];
const DAY_MS = 86400000;

// In-memory state of running jobs (the API key is never persisted).
const runtime = new Map(); // jobId -> { cancelled, promise }

// ---------------------------------------------------------------------------------------------------------------
// Job persistence
// ---------------------------------------------------------------------------------------------------------------

export function sanitizeOptions(options = {}) {
  const out = { ...options };
  delete out.apiKey;
  delete out.api_key;
  return out;
}

export function jobDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    source: row.source,
    status: row.status,
    options: sanitizeOptions(row.options || {}),
    progress: row.progress || {},
    log: row.log || [],
    error: row.error || null,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    createdAt: toIso(row.created_at),
    running: runtime.has(row.id),
  };
}

export async function createImportJob({ workspaceId, userId, source, options = {}, status = 'PENDING' }) {
  return one(
    `INSERT INTO import_jobs (id, workspace_id, user_id, source, status, options, progress, log) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [newId(), workspaceId, userId, source, status, JSON.stringify(sanitizeOptions(options)), JSON.stringify({ stage: 'PENDING', counts: {} }), JSON.stringify([])],
  );
}

export async function getJob(workspaceId, id) {
  return one('SELECT * FROM import_jobs WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
}

export async function listJobs(workspaceId, { limit = 50 } = {}) {
  return rows('SELECT * FROM import_jobs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2', [workspaceId, limit]);
}

export async function requestCancel(jobId) {
  const state = runtime.get(jobId);
  if (state) state.cancelled = true;
  await query(`UPDATE import_jobs SET progress = COALESCE(progress, '{}'::jsonb) || '{"cancelRequested":true}'::jsonb WHERE id = $1 AND status IN ('PENDING','RUNNING')`, [jobId]);
  return !!state;
}

export function isJobRunning(jobId) { return runtime.has(jobId); }

export function runningJobsOfWorkspace(workspaceId) {
  return [...runtime.entries()].filter(([, s]) => s.workspaceId === workspaceId).map(([id]) => id);
}

export async function waitForRunningJobs() {
  await Promise.allSettled([...runtime.values()].map((s) => s.promise));
}

// Lists the Clockify workspaces an API key has access to (used by the UI to pick the source workspace).
export async function listWorkspacesForKey({ apiKey, baseUrl, fetchImpl } = {}) {
  if (!apiKey) throw badRequest('apiKey is required', 400);
  const client = new ClockifyClient({ apiKey, baseUrl, fetchImpl, maxRetries: 2 });
  let me;
  try { me = await client.me(); } catch (err) { throw mapAuthError(err); }
  const list = await client.workspaces();
  return {
    user: { id: me.id, email: me.email, name: me.name, activeWorkspace: me.activeWorkspace || null, defaultWorkspace: me.defaultWorkspace || null },
    workspaces: (Array.isArray(list) ? list : []).map((w) => ({
      id: w.id, name: w.name, imageUrl: w.imageUrl || '', memberships: (w.memberships || []).length,
      hourlyRate: w.hourlyRate || null, currencies: (w.currencies || []).map((c) => c.code), featureSubscriptionType: w.featureSubscriptionType?.addonSubscriptionPlan || w.featureSubscriptionType || null,
    })),
  };
}

function mapAuthError(err) {
  if (err instanceof ClockifyApiError && (err.status === 401 || err.status === 403)) return badRequest('Clockify rejected the API key (401/403). Generate a new key in Clockify > Profile settings > API.', 401);
  if (err instanceof ClockifyApiError) return badRequest(`Clockify API error: ${err.message}`, 502);
  return err;
}

// Starts an import in the background and returns the job row immediately.
export function startClockifyImport({ workspace, user, options = {}, apiKey, fetchImpl }) {
  if (!apiKey) throw badRequest('apiKey is required', 400);
  const opts = normalizeOptions(options);
  return createImportJob({ workspaceId: workspace.id, userId: user.id, source: 'CLOCKIFY_API', options: opts }).then((job) => {
    const state = { cancelled: false, workspaceId: workspace.id };
    state.promise = runClockifyImport(job, { apiKey, fetchImpl, state }).catch((err) => { console.error('[importer] job failed', job.id, err.message); }).finally(() => runtime.delete(job.id));
    runtime.set(job.id, state);
    return job;
  });
}

export function normalizeOptions(options = {}) {
  const out = sanitizeOptions(options);
  out.mode = MODES.includes(String(out.mode || '').toUpperCase()) ? String(out.mode).toUpperCase() : 'INTO_CURRENT';
  if (out.entities !== undefined && out.entities !== null) {
    const list = (Array.isArray(out.entities) ? out.entities : String(out.entities).split(',')).map((s) => String(s).trim()).filter(Boolean);
    const unknown = list.filter((e) => !ENTITIES.includes(e));
    if (unknown.length) throw badRequest(`Unknown entities: ${unknown.join(', ')}. Supported: ${ENTITIES.join(', ')}`, 400);
    out.entities = list.length ? list : undefined;
  }
  if (out.since) {
    const d = new Date(out.since);
    if (Number.isNaN(d.getTime())) throw badRequest('since must be a date (YYYY-MM-DD or ISO-8601)', 400);
    out.since = d.toISOString();
  }
  out.dryRun = !!out.dryRun;
  if (out.pageSize !== undefined && out.pageSize !== null) {
    const n = parseInt(out.pageSize, 10);
    if (Number.isNaN(n) || n < 1 || n > 5000) throw badRequest('pageSize must be between 1 and 5000', 400);
    out.pageSize = n;
  }
  if (out.ratePerSecond !== undefined && out.ratePerSecond !== null) {
    // Clockify allows ~10 req/s per key; higher values only make sense against a mirror/mock.
    const n = Number(out.ratePerSecond);
    if (Number.isNaN(n) || n < 1 || n > 100) throw badRequest('ratePerSecond must be between 1 and 100', 400);
    out.ratePerSecond = n;
  }
  if (out.sourceWorkspaceId && !isValidId(out.sourceWorkspaceId)) throw badRequest('sourceWorkspaceId must be a 24-char hex id', 400);
  if (out.baseUrl && !/^https?:\/\//.test(String(out.baseUrl))) throw badRequest('baseUrl must start with http:// or https://', 400);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------

class ImportRun {
  constructor(job, { apiKey, fetchImpl, state, onLog, onProgress }) {
    this.job = job;
    this.options = normalizeOptions(job.options || {});
    this.state = state || { cancelled: false };
    this.onLog = onLog || (() => {});
    this.onProgress = onProgress || (() => {});
    this.logLines = Array.isArray(job.log) ? [...job.log] : [];
    this.progress = { ...(job.progress || {}), stage: 'STARTING', current: 0, total: null, counts: {}, details: {}, stages: {}, cancelRequested: false };
    this.dryRun = !!this.options.dryRun;
    this.mode = this.options.mode;
    this.since = new Date(this.options.since || DEFAULT_SINCE);
    this.lastFlush = 0;
    this.flushTimer = null;
    this.startedAt = new Date().toISOString();
    this.runOutside = AsyncLocalStorage.snapshot();
    this.userMap = new Map();        // clockify user id -> local user id
    this.userTimeZone = new Map();   // clockify user id -> IANA tz
    this.map = { client: new Map(), project: new Map(), task: new Map(), tag: new Map(), group: new Map(), customField: new Map(), category: new Map(), policy: new Map() };
    this.local = { client: new Set(), project: new Set(), task: new Map(), tag: new Set(), group: new Set(), customField: new Map(), category: new Set(), policy: new Set(), users: new Set() };
    this.warned = new Set();
    this.ratesCache = new Map();
    this.pendingProjectManagers = [];
    this.pendingUserCustomFields = [];
    this.sourceProjects = null;
    this.client = new ClockifyClient({
      apiKey, baseUrl: this.options.baseUrl, reportsUrl: this.options.reportsUrl, fetchImpl, ratePerSecond: this.options.ratePerSecond || 8,
      log: (m) => this.log(m), shouldStop: () => this.state.cancelled,
    });
  }

  wants(entity) { return !this.options.entities || this.options.entities.includes(entity); }

  log(message) {
    const line = `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} ${message}`;
    this.logLines.push(line);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    try { this.onLog(message, line); } catch { /* ignore */ }
    this.scheduleFlush();
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(message);
  }

  count(entity, result) {
    const d = this.progress.details[entity] || (this.progress.details[entity] = { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 });
    if (result in d) d[result] += 1;
    this.progress.counts[entity] = d.created + d.updated;
  }

  fetched(entity, n = 1) {
    const d = this.progress.details[entity] || (this.progress.details[entity] = { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 });
    d.fetched += n;
    if (!(entity in this.progress.counts)) this.progress.counts[entity] = 0;
  }

  async setStage(stage, total = null) {
    this.progress.stage = stage;
    this.progress.current = 0;
    this.progress.total = total;
    await this.flush(true);
  }

  tick(current, total, extra) {
    this.progress.current = current;
    if (total !== undefined) this.progress.total = total;
    if (extra) this.progress.detail = extra;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    const wait = Math.max(0, 750 - (Date.now() - this.lastFlush));
    // The timer callback runs in the async context captured at construction time (outside any transaction),
    // so the progress UPDATE never rides on a batch transaction's connection.
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.runOutside(() => this.flush(true).catch(() => {})); }, wait);
    this.flushTimer.unref?.();
  }

  async flush(force = false) {
    if (!force && Date.now() - this.lastFlush < 750) return;
    this.lastFlush = Date.now();
    try { this.onProgress(this.progress); } catch { /* ignore */ }
    if (!this.job.id) return;
    await query('UPDATE import_jobs SET progress = $2, log = $3 WHERE id = $1', [this.job.id, JSON.stringify(this.progress), JSON.stringify(this.logLines)]);
  }

  async setStatus(status, { error, started, finished } = {}) {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.lastFlush = Date.now();
    try { this.onProgress(this.progress); } catch { /* ignore */ }
    if (!this.job.id) return null;
    return one(
      `UPDATE import_jobs SET status = $2, progress = $3, log = $4, error = $5, started_at = CASE WHEN $6::boolean THEN now() ELSE started_at END, finished_at = CASE WHEN $7::boolean THEN now() ELSE finished_at END WHERE id = $1 RETURNING *`,
      [this.job.id, status, JSON.stringify(this.progress), JSON.stringify(this.logLines), error || null, !!started, !!finished],
    );
  }

  async checkCancelled() {
    if (this.state.cancelled) throw new ImportCancelledError();
    if (this.job.id) {
      const r = await one(`SELECT (progress->>'cancelRequested')::boolean AS c FROM import_jobs WHERE id = $1`, [this.job.id]);
      if (r && r.c) { this.state.cancelled = true; throw new ImportCancelledError(); }
    }
  }

  // Runs `fn` as a stage: errors are logged and the run continues (authentication errors and cancellation abort).
  async stage(name, fn) {
    if (!this.wants(name)) { this.progress.stages[name] = { status: 'SKIPPED' }; this.log(`Etapa ${name}: ignorada (não selecionada)`); return; }
    await this.checkCancelled();
    await this.setStage(name);
    this.log(`Etapa ${name}: iniciando`);
    const startedAt = Date.now();
    try {
      await fn();
      this.progress.stages[name] = { status: 'DONE', ms: Date.now() - startedAt };
      const d = this.progress.details[name];
      this.log(`Etapa ${name}: concluída${d ? ` (lidos ${d.fetched}, criados ${d.created}, atualizados ${d.updated}, ignorados ${d.skipped}, erros ${d.errors})` : ''}`);
      if (!this.dryRun) {
        await audit({
          workspaceId: this.targetWorkspaceId, userId: this.job.user_id, action: name === 'timeEntries' ? 'CREATE_TIME_IMPORT' : `IMPORT_${camelToSnake(name)}`,
          entityType: 'IMPORT_JOB', entityId: this.job.id || null, content: { source: 'CLOCKIFY_API', stage: name, sourceWorkspaceId: this.sourceWorkspaceId, counts: d || null },
        });
      }
    } catch (err) {
      if (err instanceof ImportCancelledError) throw err;
      if (err instanceof ClockifyApiError && err.status === 401) throw err;
      this.progress.stages[name] = { status: 'FAILED', error: err.message, ms: Date.now() - startedAt };
      this.log(`Etapa ${name}: FALHOU – ${err.message}`);
    }
    await this.flush(true);
  }

  // Executes fn for each item in batches inside a transaction; on batch failure retries item by item so a
  // single bad record does not discard the whole batch.
  async writeBatch(entity, items, fn, { size = 250 } = {}) {
    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size);
      await this.checkCancelledFast();
      if (this.dryRun) {
        for (const item of chunk) { try { await fn(item); } catch (err) { this.count(entity, 'errors'); this.log(`Erro em ${entity} ${item?.id || ''}: ${err.message}`); } }
        continue;
      }
      const snapshot = JSON.stringify(this.progress.details[entity] || null);
      try {
        await transaction(async () => { for (const item of chunk) await fn(item); });
      } catch (batchErr) {
        if (snapshot !== 'null') this.progress.details[entity] = JSON.parse(snapshot);
        this.log(`Lote de ${entity} falhou (${batchErr.message}); reprocessando registro a registro`);
        for (const item of chunk) {
          try { await transaction(() => fn(item)); } catch (err) { this.count(entity, 'errors'); this.log(`Erro em ${entity} ${item?.id || ''}: ${err.message}`); }
        }
      }
    }
  }

  async checkCancelledFast() { if (this.state.cancelled) throw new ImportCancelledError(); }

  // Idempotent upsert preserving the id. Returns 'created' | 'updated' | 'skipped'.
  async upsert(table, row, updateCols, { conflict = 'id', scope = 'workspace_id', ignore = false } = {}) {
    if (this.dryRun) {
      const cols = conflict.split(',').map((c) => c.trim());
      const existing = await one(`SELECT 1 FROM ${table} WHERE ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(' AND ')}`, cols.map((c) => toParam(row[c])));
      return existing ? (ignore ? 'skipped' : 'updated') : 'created';
    }
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const cols = keys.map((k) => `"${k}"`).join(', ');
    const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
    const params = keys.map((k) => toParam(row[k]));
    let action;
    if (ignore) action = 'DO NOTHING';
    else {
      const sets = (updateCols || []).filter((k) => keys.includes(k)).map((k) => `"${k}" = EXCLUDED."${k}"`);
      if (!sets.length) sets.push(`"${conflict.split(',')[0].trim()}" = ${table}."${conflict.split(',')[0].trim()}"`);
      const where = scope && keys.includes(scope) ? ` WHERE ${table}."${scope}" = EXCLUDED."${scope}"` : '';
      action = `DO UPDATE SET ${sets.join(', ')}${where}`;
    }
    const r = await one(`INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT (${conflict}) ${action} RETURNING (xmax = 0) AS inserted`, params);
    if (!r) return 'skipped';
    return r.inserted ? 'created' : 'updated';
  }

  async exec(sql, params) {
    if (this.dryRun) return null;
    return query(sql, params);
  }

  // Resolves a Clockify id of `kind` to the local id (explicit mapping, or identity when it exists locally).
  resolve(kind, id) {
    if (!id) return null;
    if (this.map[kind].has(id)) return this.map[kind].get(id);
    return this.local[kind].has(id) ? id : null;
  }

  mapUser(id) { return id ? this.userMap.get(id) || null : null; }

  async refreshLocal() {
    const ws = this.targetWorkspaceId;
    this.local.client = new Set((await rows('SELECT id FROM clients WHERE workspace_id = $1', [ws])).map((r) => r.id));
    this.local.project = new Set((await rows('SELECT id FROM projects WHERE workspace_id = $1', [ws])).map((r) => r.id));
    this.local.task = new Map((await rows('SELECT id, project_id FROM tasks WHERE workspace_id = $1', [ws])).map((r) => [r.id, r.project_id]));
    this.local.tag = new Set((await rows('SELECT id FROM tags WHERE workspace_id = $1', [ws])).map((r) => r.id));
    this.local.group = new Set((await rows('SELECT id FROM user_groups WHERE workspace_id = $1', [ws])).map((r) => r.id));
    this.local.customField = new Map((await rows('SELECT * FROM custom_fields WHERE workspace_id = $1', [ws])).map((r) => [r.id, r]));
    this.local.category = new Set((await rows('SELECT id FROM expense_categories WHERE workspace_id = $1', [ws])).map((r) => r.id));
    this.local.policy = new Set((await rows('SELECT id FROM time_off_policies WHERE workspace_id = $1', [ws])).map((r) => r.id));
    this.local.users = new Set((await rows('SELECT user_id FROM workspace_members WHERE workspace_id = $1', [ws])).map((r) => r.user_id));
    for (const id of this.userMap.values()) this.local.users.add(id);
  }

  async ratesFor(userId, projectId, taskId) {
    const key = `${userId}|${projectId || ''}|${taskId || ''}`;
    if (!this.ratesCache.has(key)) this.ratesCache.set(key, await resolveRates({ workspaceId: this.targetWorkspaceId, userId, projectId, taskId }));
    return this.ratesCache.get(key);
  }
}

function camelToSnake(s) { return s.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(); }
function toParam(v) {
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}
const lower = (s) => String(s || '').trim().toLowerCase();
const cents = (rate) => (rate && rate.amount != null && !Number.isNaN(Number(rate.amount)) ? Math.round(Number(rate.amount)) : null);
const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);
const validDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const arr = (v) => (Array.isArray(v) ? v : []);
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k, v]) => keys.includes(k) && v !== undefined));

function* windows(from, to, days, overlapDays = 0) {
  let s = new Date(from);
  if (s >= to) return;
  for (;;) {
    const e = new Date(Math.min(to.getTime(), s.getTime() + days * DAY_MS));
    yield [s, e];
    if (e.getTime() >= to.getTime()) return;
    s = new Date(e.getTime() - overlapDays * DAY_MS);
  }
}

// Maps Clockify workspaceSettings onto the local settings column (same keys).
export function mapWorkspaceSettings(clockifySettings = {}, current = {}) {
  const out = { ...DEFAULT_WORKSPACE_SETTINGS, ...(current || {}) };
  for (const [k, v] of Object.entries(clockifySettings || {})) {
    if (v === undefined) continue;
    out[k] = v;
  }
  if (out.round && typeof out.round === 'object') out.round = { round: out.round.round || 'Round to nearest', minutes: String(out.round.minutes ?? '15') };
  if (!Array.isArray(out.workingDays)) out.workingDays = DEFAULT_WORKSPACE_SETTINGS.workingDays;
  return out;
}

export function mapUserSettings(settings = {}) {
  return { ...DEFAULT_USER_SETTINGS, ...pick(settings, Object.keys(DEFAULT_USER_SETTINGS)) };
}

// Normalizes the various shapes in which Clockify reports roles on a user object.
export function normalizeRoles(user) {
  const out = [];
  for (const r of arr(user?.roles)) {
    if (!r) continue;
    if (typeof r === 'string') { out.push({ role: r, entityIds: [] }); continue; }
    const roleName = typeof r.role === 'string' ? r.role : (r.role?.name || r.name || r.roleName);
    if (!roleName) continue;
    const entityIds = [];
    if (r.entityId) entityIds.push(r.entityId);
    if (r.role && typeof r.role === 'object' && r.role.entityId) entityIds.push(r.role.entityId);
    for (const e of arr(r.entities)) entityIds.push(typeof e === 'string' ? e : e?.id);
    for (const e of arr(r.entityIds)) entityIds.push(e);
    out.push({ role: String(roleName).toUpperCase(), entityIds: entityIds.filter(Boolean), sourceType: r.source?.type || r.role?.source?.type || r.sourceType || null });
  }
  return out;
}

// Creates (or validates) the local workspace that mirrors the Clockify one in NEW_WORKSPACE mode.
export async function prepareNewWorkspace({ sourceWorkspace, owner, dryRun = false }) {
  const id = sourceWorkspace.id;
  if (!isValidId(id)) throw badRequest('Source workspace id is not a valid 24-char hex id', 400);
  const existing = await one('SELECT * FROM workspaces WHERE id = $1', [id]);
  if (existing) {
    if (existing.owner_id !== owner.id) throw forbidden(`A local workspace with id ${id} already exists and belongs to another user`, 403);
    return existing;
  }
  const defaultCurrency = arr(sourceWorkspace.currencies).find((c) => c.isDefault)?.code || sourceWorkspace.hourlyRate?.currency || 'USD';
  if (dryRun) return { id, name: sourceWorkspace.name, owner_id: owner.id, settings: mapWorkspaceSettings(sourceWorkspace.workspaceSettings), hourly_rate_currency: defaultCurrency, dryRun: true };
  const ws = await createWorkspace({ id, name: sourceWorkspace.name || 'Clockify workspace', owner, settings: mapWorkspaceSettings(sourceWorkspace.workspaceSettings), currency: defaultCurrency });
  await query('UPDATE workspaces SET hourly_rate_amount = $2, hourly_rate_currency = $3, cost_rate_amount = $4, image_url = $5 WHERE id = $1',
    [id, cents(sourceWorkspace.hourlyRate) ?? 0, defaultCurrency, cents(sourceWorkspace.costRate) ?? 0, sourceWorkspace.imageUrl || null]);
  await query('UPDATE users SET active_workspace_id = COALESCE(active_workspace_id, $2), default_workspace_id = COALESCE(default_workspace_id, $2) WHERE id = $1', [owner.id, id]);
  return one('SELECT * FROM workspaces WHERE id = $1', [id]);
}

// Main entry point. `job` is an import_jobs row (or an object with the same shape). Returns the final job row.
export async function runClockifyImport(job, { apiKey, fetchImpl, state, onLog, onProgress } = {}) {
  const run = new ImportRun(job, { apiKey, fetchImpl, state, onLog, onProgress });
  await run.setStatus('RUNNING', { started: true });
  run.log(`Importação iniciada (modo ${run.mode}${run.dryRun ? ', simulação/dryRun' : ''}, desde ${run.since.toISOString().slice(0, 10)})`);
  try {
    await prepare(run);
    await run.stage('workspace', () => importWorkspace(run));
    await run.stage('users', () => importUsers(run));
    if (!run.wants('users')) await buildUserMap(run);
    await run.refreshLocal();
    await run.stage('userGroups', () => importUserGroups(run));
    await run.stage('clients', () => importClients(run));
    await run.stage('projects', () => importProjects(run));
    await run.stage('tasks', () => importTasks(run));
    await run.stage('tags', () => importTags(run));
    await run.stage('customFields', () => importCustomFields(run));
    await flushPending(run);
    await run.stage('timeEntries', () => importTimeEntries(run));
    await run.stage('expenses', () => importExpenses(run));
    await run.stage('holidays', () => importHolidays(run));
    await run.stage('timeOff', () => importTimeOff(run));
    await run.stage('approvals', () => importApprovals(run));
    await run.stage('scheduling', () => importScheduling(run));
    await run.stage('invoices', () => importInvoices(run));
    await run.stage('webhooks', () => importWebhooks(run));
    run.progress.stage = 'DONE';
    run.progress.syncedAt = run.startedAt;
    run.progress.requests = run.client.stats;
    const failed = Object.entries(run.progress.stages).filter(([, s]) => s.status === 'FAILED').map(([n]) => n);
    run.log(`Importação concluída em ${Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000)}s – ${run.client.stats.requests} requisições à API do Clockify${failed.length ? `; etapas com falha: ${failed.join(', ')}` : ''}`);
    run.log(`Para sincronização incremental use since=${run.startedAt.slice(0, 10)} na próxima execução`);
    return await run.setStatus('DONE', { finished: true });
  } catch (err) {
    run.progress.requests = run.client.stats;
    if (err instanceof ImportCancelledError) {
      run.progress.stage = 'CANCELLED';
      run.progress.cancelled = true;
      run.log('Importação cancelada pelo usuário');
      return await run.setStatus('CANCELLED', { error: 'Import cancelled by user', finished: true });
    }
    run.progress.stage = 'FAILED';
    run.log(`Importação falhou: ${err.message}`);
    return await run.setStatus('FAILED', { error: err.message, finished: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Preparation: authenticate, pick the source workspace, resolve the target workspace
// ---------------------------------------------------------------------------------------------------------------

async function prepare(run) {
  let me;
  try { me = await run.client.me(); } catch (err) { throw mapAuthError(err); }
  run.log(`Autenticado no Clockify como ${me.name || ''} <${me.email}> (id ${me.id})`);
  run.progress.sourceUser = { id: me.id, email: me.email, name: me.name };
  const list = arr(await run.client.workspaces());
  let sourceId = run.options.sourceWorkspaceId;
  if (!sourceId) {
    if (list.length === 1) sourceId = list[0].id;
    else if (list.some((w) => w.id === me.activeWorkspace)) sourceId = me.activeWorkspace;
    else if (list.length) sourceId = list[0].id;
  }
  if (!sourceId) throw badRequest('sourceWorkspaceId is required (the API key has access to no workspace)', 400);
  if (!list.some((w) => w.id === sourceId)) throw badRequest(`The API key has no access to workspace ${sourceId}. Available: ${list.map((w) => `${w.id} (${w.name})`).join(', ')}`, 400);
  run.sourceWorkspaceId = sourceId;
  run.sourceWorkspace = await run.client.workspace(sourceId);
  run.progress.sourceWorkspaceId = sourceId;
  run.progress.sourceWorkspaceName = run.sourceWorkspace.name;
  run.log(`Workspace de origem: ${run.sourceWorkspace.name} (${sourceId})`);

  run.importer = await one('SELECT * FROM users WHERE id = $1', [run.job.user_id]);
  if (!run.importer) throw notFound('Importing user not found', 404);
  if (run.mode === 'NEW_WORKSPACE') {
    const ws = await prepareNewWorkspace({ sourceWorkspace: run.sourceWorkspace, owner: run.importer, dryRun: run.dryRun });
    run.targetWorkspaceId = ws.id;
    run.targetWorkspace = ws;
    run.log(ws.dryRun ? `Simulação: o workspace local ${ws.id} seria criado` : `Workspace local de destino: ${ws.name} (${ws.id}) – mesmo id do Clockify`);
  } else {
    run.targetWorkspaceId = run.job.workspace_id;
    run.targetWorkspace = await one('SELECT * FROM workspaces WHERE id = $1', [run.targetWorkspaceId]);
    if (!run.targetWorkspace) throw notFound('Target workspace not found', 404);
    run.log(`Workspace local de destino: ${run.targetWorkspace.name} (${run.targetWorkspaceId})`);
  }
  run.progress.targetWorkspaceId = run.targetWorkspaceId;
  run.progress.mode = run.mode;
  run.progress.dryRun = run.dryRun;
  await loadCurrencies(run);
}

async function loadCurrencies(run) {
  const list = await rows('SELECT id, code, is_default FROM workspace_currencies WHERE workspace_id = $1', [run.targetWorkspaceId]);
  run.currencyIdByCode = new Map(list.map((c) => [String(c.code).toUpperCase(), c.id]));
  run.currencyIds = new Set(list.map((c) => c.id));
  run.defaultCurrency = list.find((c) => c.is_default)?.code || run.targetWorkspace?.hourly_rate_currency || 'USD';
}

// ---------------------------------------------------------------------------------------------------------------
// Workspace settings, rates and currencies
// ---------------------------------------------------------------------------------------------------------------

async function importWorkspace(run) {
  const ws = run.sourceWorkspace;
  run.fetched('workspace');
  const settings = mapWorkspaceSettings(ws.workspaceSettings, run.targetWorkspace?.settings);
  if (Array.isArray(ws.features)) settings.features = ws.features;
  const defaultCurrency = arr(ws.currencies).find((c) => c.isDefault)?.code || ws.hourlyRate?.currency || run.defaultCurrency;
  await run.exec('UPDATE workspaces SET settings = $2, hourly_rate_amount = COALESCE($3, hourly_rate_amount), hourly_rate_currency = $4, cost_rate_amount = COALESCE($5, cost_rate_amount), image_url = COALESCE($6, image_url) WHERE id = $1',
    [run.targetWorkspaceId, JSON.stringify(settings), cents(ws.hourlyRate), defaultCurrency, cents(ws.costRate), ws.imageUrl || null]);
  for (const c of arr(ws.currencies)) {
    if (!c.code) continue;
    try {
      await run.exec(`INSERT INTO workspace_currencies (id, workspace_id, code, is_default) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, code) DO UPDATE SET is_default = EXCLUDED.is_default`,
        [isValidId(c.id) && !run.currencyIds.has(c.id) ? c.id : newId(), run.targetWorkspaceId, String(c.code).toUpperCase(), !!c.isDefault]);
    } catch (err) { run.log(`Moeda ${c.code} não importada: ${err.message}`); }
  }
  if (arr(ws.currencies).some((c) => c.isDefault)) await run.exec('UPDATE workspace_currencies SET is_default = (code = $2) WHERE workspace_id = $1', [run.targetWorkspaceId, String(defaultCurrency).toUpperCase()]);
  await loadCurrencies(run);
  run.count('workspace', run.mode === 'NEW_WORKSPACE' ? 'created' : 'updated');
  run.log(`Configurações do workspace aplicadas (${Object.keys(ws.workspaceSettings || {}).length} chaves, moeda padrão ${defaultCurrency})`);
}

// ---------------------------------------------------------------------------------------------------------------
// Users, memberships and roles
// ---------------------------------------------------------------------------------------------------------------

async function fetchSourceUsers(run) {
  if (run.sourceUsers) return run.sourceUsers;
  run.sourceUsers = await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/users`, { query: { 'include-roles': true, status: 'ALL', memberships: 'ALL' }, pageSize: 200 });
  run.log(`${run.sourceUsers.length} usuário(s) encontrado(s) no Clockify`);
  return run.sourceUsers;
}

// Decides the local id for every Clockify user (existing local account by e-mail, otherwise the Clockify id).
async function planUsers(run) {
  if (run.userPlan) return run.userPlan;
  const users = await fetchSourceUsers(run);
  const plan = [];
  for (const u of users) {
    const email = lower(u.email);
    if (!email) { run.log(`Usuário ${u.id} sem e-mail – ignorado`); continue; }
    const local = await one('SELECT id, email, name, active_workspace_id FROM users WHERE lower(email) = $1', [email]);
    let localId; let create = false;
    if (local) localId = local.id;
    else {
      const byId = isValidId(u.id) ? await one('SELECT id FROM users WHERE id = $1', [u.id]) : null;
      localId = byId || !isValidId(u.id) ? newId() : u.id;
      create = true;
      if (byId) run.log(`O id ${u.id} já pertence a outro usuário local; ${email} receberá o id ${localId}`);
    }
    plan.push({ source: u, email, localId, create, existing: local });
    run.userMap.set(u.id, localId);
    if (u.settings?.timeZone) run.userTimeZone.set(u.id, u.settings.timeZone);
  }
  run.userPlan = plan;
  run.progress.userMap = Object.fromEntries(run.userMap);
  return plan;
}

// Used when the users stage is not selected: map users but do not write anything.
async function buildUserMap(run) {
  const plan = await planUsers(run);
  const missing = plan.filter((p) => p.create);
  // Without the users stage only users that already exist locally can receive data
  for (const p of missing) run.userMap.delete(p.source.id);
  run.progress.userMap = Object.fromEntries(run.userMap);
  if (missing.length) run.log(`${missing.length} usuário(s) do Clockify não existem localmente e a etapa "users" não foi selecionada – seus registros serão ignorados`);
}

async function importUsers(run) {
  const plan = await planUsers(run);
  const ws = run.targetWorkspaceId;
  run.fetched('users', plan.length);
  let i = 0;
  for (const p of plan) {
    run.tick(++i, plan.length, p.email);
    const u = p.source;
    const membership = arr(u.memberships).find((m) => m.membershipType === 'WORKSPACE' && (!m.targetId || m.targetId === run.sourceWorkspaceId)) || arr(u.memberships).find((m) => m.membershipType === 'WORKSPACE') || {};
    const status = ['ACTIVE', 'INACTIVE', 'PENDING', 'DECLINED'].includes(membership.membershipStatus) ? membership.membershipStatus : 'ACTIVE';
    try {
      if (p.create) {
        await run.exec(
          `INSERT INTO users (id, email, name, profile_picture, status, settings, active_workspace_id, default_workspace_id) VALUES ($1,$2,$3,$4,'PENDING_EMAIL_VERIFICATION',$5,$6,$6) ON CONFLICT (id) DO NOTHING`,
          [p.localId, p.email, u.name || p.email.split('@')[0], u.profilePicture || null, JSON.stringify(mapUserSettings(u.settings)), ws],
        );
        run.count('users', 'created');
        run.log(`Usuário criado: ${p.email} (id ${p.localId}, sem senha – usar "esqueci a senha"/convite)`);
      } else {
        run.count('users', 'updated');
        if (p.localId !== u.id) run.log(`Usuário ${p.email} mapeado para a conta local ${p.localId} (Clockify ${u.id})`);
        if (!p.existing?.active_workspace_id) await run.exec('UPDATE users SET active_workspace_id = $2, default_workspace_id = COALESCE(default_workspace_id, $2) WHERE id = $1', [p.localId, ws]);
      }
      const isImporter = p.localId === run.importer.id || p.localId === run.targetWorkspace?.owner_id;
      const profile = await memberProfile(run, u.id);
      await run.exec(
        `INSERT INTO workspace_members (workspace_id, user_id, status, hourly_rate_amount, hourly_rate_currency, cost_rate_amount, week_start, working_days, work_capacity, invited_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET
           status = CASE WHEN $10::boolean THEN workspace_members.status ELSE EXCLUDED.status END,
           hourly_rate_amount = COALESCE(EXCLUDED.hourly_rate_amount, workspace_members.hourly_rate_amount),
           hourly_rate_currency = COALESCE(EXCLUDED.hourly_rate_currency, workspace_members.hourly_rate_currency),
           cost_rate_amount = COALESCE(EXCLUDED.cost_rate_amount, workspace_members.cost_rate_amount),
           week_start = COALESCE(EXCLUDED.week_start, workspace_members.week_start),
           working_days = COALESCE(EXCLUDED.working_days, workspace_members.working_days),
           work_capacity = COALESCE(EXCLUDED.work_capacity, workspace_members.work_capacity)`,
        [ws, p.localId, isImporter ? 'ACTIVE' : status, cents(membership.hourlyRate), membership.hourlyRate?.currency || null, cents(membership.costRate),
          profile.weekStart || u.weekStart || null, profile.workingDays ? JSON.stringify(profile.workingDays) : (Array.isArray(u.workingDays) ? JSON.stringify(u.workingDays) : null), profile.workCapacity || u.workCapacity || null, isImporter],
      );
      run.local.users.add(p.localId);
      for (const cf of arr(u.customFields)) if (cf.customFieldId) run.pendingUserCustomFields.push({ userId: p.localId, customFieldId: cf.customFieldId, value: cf.value });
      await importUserRoles(run, u, p.localId);
    } catch (err) {
      run.count('users', 'errors');
      run.log(`Erro ao importar usuário ${p.email}: ${err.message}`);
    }
  }
  run.progress.userMap = Object.fromEntries(run.userMap);
}

async function memberProfile(run, sourceUserId) {
  if (run.options.memberProfiles === false) return {};
  try {
    const p = await run.client.get(`/workspaces/${run.sourceWorkspaceId}/member-profile/${sourceUserId}`);
    return { weekStart: p?.weekStart || null, workingDays: Array.isArray(p?.workingDays) ? p.workingDays : (typeof p?.workingDays === 'string' ? [p.workingDays] : null), workCapacity: p?.workCapacity || null };
  } catch (err) {
    run.warnOnce('member-profile', `Perfis de membro (member-profile) indisponíveis: ${err.message}`);
    return {};
  }
}

async function importUserRoles(run, u, localId) {
  const ws = run.targetWorkspaceId;
  for (const r of normalizeRoles(u)) {
    if (r.role === 'OWNER' || r.role === 'WORKSPACE_ADMIN') {
      if (localId === run.targetWorkspace?.owner_id) continue;
      await run.exec(`INSERT INTO roles (id, workspace_id, user_id, role, entity_id, source_type) VALUES ($1,$2,$3,'WORKSPACE_ADMIN',$2,$4) ON CONFLICT DO NOTHING`, [newId(), ws, localId, r.sourceType]);
    } else if (r.role === 'TEAM_MANAGER') {
      for (const eid of r.entityIds) {
        const target = run.mapUser(eid) || eid; // user id (mapped) or group id (preserved)
        if (!isValidId(target)) continue;
        await run.exec(`INSERT INTO roles (id, workspace_id, user_id, role, entity_id, source_type) VALUES ($1,$2,$3,'TEAM_MANAGER',$4,$5) ON CONFLICT DO NOTHING`, [newId(), ws, localId, target, r.sourceType]);
      }
    } else if (r.role === 'PROJECT_MANAGER') {
      for (const eid of r.entityIds) run.pendingProjectManagers.push({ userId: localId, projectId: eid, sourceType: r.sourceType });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// User groups
// ---------------------------------------------------------------------------------------------------------------

async function importUserGroups(run) {
  const ws = run.targetWorkspaceId;
  const groups = await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/user-groups`, { pageSize: 200, query: { includeTeamManagers: true } });
  run.fetched('userGroups', groups.length);
  const byName = new Map((await rows('SELECT id, name FROM user_groups WHERE workspace_id = $1', [ws])).map((g) => [lower(g.name), g.id]));
  await run.writeBatch('userGroups', groups, async (g) => {
    let id = g.id;
    if (!run.local.group.has(id) && byName.has(lower(g.name))) { id = byName.get(lower(g.name)); run.map.group.set(g.id, id); run.log(`Grupo "${g.name}" já existe localmente (${id}) – mapeado`); }
    if (!isValidId(id)) id = newId();
    const res = await run.upsert('user_groups', { id, workspace_id: ws, name: g.name || 'Grupo' }, ['name']);
    run.count('userGroups', res);
    if (res === 'skipped') { run.log(`Grupo ${g.id} pertence a outro workspace local – ignorado`); return; }
    run.local.group.add(id);
    if (id !== g.id) run.map.group.set(g.id, id);
    for (const uid of arr(g.userIds)) {
      const local = run.mapUser(uid);
      if (!local) continue;
      await run.exec('INSERT INTO user_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, local]);
    }
    for (const tm of arr(g.teamManagers)) {
      const local = run.mapUser(typeof tm === 'string' ? tm : tm?.id);
      if (!local) continue;
      await run.exec(`INSERT INTO roles (id, workspace_id, user_id, role, entity_id) VALUES ($1,$2,$3,'TEAM_MANAGER',$4) ON CONFLICT DO NOTHING`, [newId(), ws, local, id]);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------------------------

async function importClients(run) {
  const ws = run.targetWorkspaceId;
  const list = [];
  for (const archived of [false, true]) list.push(...await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/clients`, { pageSize: 200, query: { archived } }));
  const clients = dedupeById(list);
  run.fetched('clients', clients.length);
  const byName = new Map((await rows('SELECT id, name FROM clients WHERE workspace_id = $1', [ws])).map((c) => [lower(c.name), c.id]));
  await run.writeBatch('clients', clients, async (c) => {
    let id = c.id;
    if (!run.local.client.has(id) && byName.has(lower(c.name))) { id = byName.get(lower(c.name)); run.log(`Cliente "${c.name}" já existe localmente (${id}) – mapeado`); }
    if (!isValidId(id)) id = newId();
    const currencyId = c.currencyCode ? run.currencyIdByCode.get(String(c.currencyCode).toUpperCase()) || null : (c.currencyId && run.currencyIds.has(c.currencyId) ? c.currencyId : null);
    const res = await run.upsert('clients', {
      id, workspace_id: ws, name: c.name || 'Cliente', address: c.address || null, email: c.email || null, cc_emails: arr(c.ccEmails), note: c.note || null, currency_id: currencyId, archived: !!c.archived,
    }, ['name', 'address', 'email', 'cc_emails', 'note', 'currency_id', 'archived']);
    run.count('clients', res);
    if (res === 'skipped') { run.log(`Cliente ${c.id} pertence a outro workspace local – ignorado`); return; }
    run.local.client.add(id);
    if (id !== c.id) run.map.client.set(c.id, id);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Projects, memberships, estimates
// ---------------------------------------------------------------------------------------------------------------

async function fetchSourceProjects(run, { hydrated }) {
  if (run.sourceProjects) return run.sourceProjects;
  const list = [];
  for (const archived of [false, true]) {
    for (const template of [false, true]) {
      list.push(...await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/projects`, { pageSize: 200, query: { hydrated: !!hydrated, archived, 'is-template': template } }));
    }
  }
  run.sourceProjects = dedupeById(list);
  return run.sourceProjects;
}

function timeEstimateOf(p) {
  const te = p.timeEstimate || {};
  const est = te.estimate ?? p.estimate?.estimate ?? 'PT0S';
  return { estimate: typeof est === 'number' ? secondsToIso(est) : (est || 'PT0S'), type: te.type || p.estimate?.type || 'AUTO', active: !!te.active, includeNonBillable: te.includeNonBillable !== false, resetOption: te.resetOption || null };
}

function budgetEstimateOf(p) {
  const be = p.budgetEstimate || {};
  return { estimate: Number(be.estimate || 0), type: be.type || 'AUTO', active: !!be.active, includeExpenses: !!be.includeExpenses, resetOption: be.resetOption || null };
}

async function importProjects(run) {
  const ws = run.targetWorkspaceId;
  const projects = await fetchSourceProjects(run, { hydrated: true });
  run.fetched('projects', projects.length);
  run.log(`${projects.length} projeto(s) encontrado(s) no Clockify`);
  const byKey = new Map((await rows('SELECT id, name, client_id FROM projects WHERE workspace_id = $1', [ws])).map((p) => [`${lower(p.name)}|${p.client_id || ''}`, p.id]));
  let i = 0;
  await run.writeBatch('projects', projects, async (p) => {
    run.tick(++i, projects.length, p.name);
    const clientId = run.resolve('client', p.clientId);
    if (p.clientId && !clientId) run.warnOnce(`client:${p.clientId}`, `Cliente ${p.clientId} (${p.clientName || ''}) não existe localmente – projetos ficarão sem cliente`);
    let id = p.id;
    const key = `${lower(p.name)}|${clientId || ''}`;
    if (!run.local.project.has(id) && byKey.has(key)) { id = byKey.get(key); run.log(`Projeto "${p.name}" já existe localmente (${id}) – mapeado`); }
    if (!isValidId(id)) id = newId();
    const currency = p.hourlyRate?.currency || p.costRate?.currency || null;
    const res = await run.upsert('projects', {
      id, workspace_id: ws, name: p.name || 'Projeto', client_id: clientId, color: p.color || '#03A9F4', note: p.note || null, billable: !!p.billable,
      is_public: p.public ?? p.isPublic ?? true, archived: !!p.archived, is_template: !!(p.template ?? p.isTemplate),
      hourly_rate_amount: cents(p.hourlyRate), hourly_rate_currency: currency, cost_rate_amount: cents(p.costRate),
      estimate_type: p.timeEstimate?.type || p.estimate?.type || 'AUTO', time_estimate: timeEstimateOf(p), budget_estimate: budgetEstimateOf(p), estimate_reset: p.estimateReset || null,
    }, ['name', 'client_id', 'color', 'note', 'billable', 'is_public', 'archived', 'is_template', 'hourly_rate_amount', 'hourly_rate_currency', 'cost_rate_amount', 'estimate_type', 'time_estimate', 'budget_estimate', 'estimate_reset']);
    run.count('projects', res);
    if (res === 'skipped') { run.log(`Projeto ${p.id} pertence a outro workspace local – ignorado`); return; }
    run.local.project.add(id);
    if (id !== p.id) run.map.project.set(p.id, id);
    for (const m of arr(p.memberships)) {
      const isGroup = m.membershipType === 'USERGROUP';
      const targetId = isGroup ? run.resolve('group', m.userGroupId || m.groupId || m.userId) : run.mapUser(m.userId);
      if (!targetId) continue;
      await run.exec(
        `INSERT INTO project_members (project_id, target_type, target_id, hourly_rate_amount, hourly_rate_currency, cost_rate_amount, status) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (project_id, target_type, target_id) DO UPDATE SET hourly_rate_amount = EXCLUDED.hourly_rate_amount, hourly_rate_currency = EXCLUDED.hourly_rate_currency, cost_rate_amount = EXCLUDED.cost_rate_amount, status = EXCLUDED.status`,
        [id, isGroup ? 'USERGROUP' : 'USER', targetId, cents(m.hourlyRate), m.hourlyRate?.currency || null, cents(m.costRate), ['ACTIVE', 'INACTIVE', 'PENDING', 'DECLINED'].includes(m.membershipStatus) ? m.membershipStatus : 'ACTIVE'],
      );
    }
    // hydrated projects carry their tasks; keep them for the tasks stage
    if (Array.isArray(p.tasks) && p.tasks.length) run.hydratedTasks = (run.hydratedTasks || new Map()).set(p.id, p.tasks);
  });
  await applyProjectManagers(run);
}

async function applyProjectManagers(run) {
  const ws = run.targetWorkspaceId;
  for (const pm of run.pendingProjectManagers.splice(0)) {
    const projectId = run.resolve('project', pm.projectId) || pm.projectId;
    if (!isValidId(projectId)) continue;
    await run.exec(`INSERT INTO roles (id, workspace_id, user_id, role, entity_id, source_type) VALUES ($1,$2,$3,'PROJECT_MANAGER',$4,$5) ON CONFLICT DO NOTHING`, [newId(), ws, pm.userId, projectId, pm.sourceType || null]);
  }
  await run.exec(`UPDATE project_members pm SET is_manager = true FROM roles r WHERE r.workspace_id = $1 AND r.role = 'PROJECT_MANAGER' AND r.entity_id = pm.project_id AND pm.target_type = 'USER' AND pm.target_id = r.user_id AND pm.is_manager = false`, [ws]);
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------------------------

async function importTasks(run) {
  const ws = run.targetWorkspaceId;
  const projects = await fetchSourceProjects(run, { hydrated: false });
  const byKey = new Map((await rows('SELECT id, project_id, name FROM tasks WHERE workspace_id = $1', [ws])).map((t) => [`${t.project_id}|${lower(t.name)}`, t.id]));
  let i = 0;
  for (const p of projects) {
    run.tick(++i, projects.length, p.name);
    const projectId = run.resolve('project', p.id);
    if (!projectId) { run.warnOnce(`project:${p.id}`, `Projeto ${p.id} (${p.name}) não existe localmente – tarefas ignoradas`); continue; }
    let tasks = [];
    try {
      for (const active of [true, false]) tasks.push(...await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/projects/${p.id}/tasks`, { pageSize: 200, query: { 'is-active': active } }));
    } catch (err) {
      run.log(`Tarefas do projeto ${p.name}: ${err.message}`);
    }
    if (run.hydratedTasks?.has(p.id)) tasks.push(...run.hydratedTasks.get(p.id));
    tasks = dedupeById(tasks);
    run.fetched('tasks', tasks.length);
    await run.writeBatch('tasks', tasks, async (t) => {
      let id = t.id;
      const key = `${projectId}|${lower(t.name)}`;
      if (!run.local.task.has(id) && byKey.has(key)) { id = byKey.get(key); }
      if (!isValidId(id)) id = newId();
      const res = await run.upsert('tasks', {
        id, workspace_id: ws, project_id: projectId, name: t.name || 'Tarefa', status: t.status === 'DONE' ? 'DONE' : 'ACTIVE',
        estimate_seconds: t.estimate ? safeSeconds(t.estimate) : null, budget_estimate: t.budgetEstimate ?? null, billable: t.billable ?? null,
        hourly_rate_amount: cents(t.hourlyRate), hourly_rate_currency: t.hourlyRate?.currency || null, cost_rate_amount: cents(t.costRate),
      }, ['project_id', 'name', 'status', 'estimate_seconds', 'budget_estimate', 'billable', 'hourly_rate_amount', 'hourly_rate_currency', 'cost_rate_amount']);
      run.count('tasks', res);
      if (res === 'skipped') { run.log(`Tarefa ${t.id} pertence a outro workspace local – ignorada`); return; }
      run.local.task.set(id, projectId);
      if (id !== t.id) run.map.task.set(t.id, id);
      const assignees = arr(t.assigneeIds).length ? t.assigneeIds : (t.assigneeId ? [t.assigneeId] : []);
      for (const uid of assignees) {
        const local = run.mapUser(uid);
        if (local) await run.exec('INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, local]);
      }
      for (const gid of arr(t.userGroupIds)) {
        const local = run.resolve('group', gid);
        if (local) await run.exec('INSERT INTO task_user_groups (task_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, local]);
      }
    });
  }
}

function safeSeconds(v) { try { return isoToSeconds(v); } catch { return null; } }

// ---------------------------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------------------------

async function importTags(run) {
  const ws = run.targetWorkspaceId;
  const list = [];
  for (const archived of [false, true]) list.push(...await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/tags`, { pageSize: 200, query: { archived } }));
  const tags = dedupeById(list);
  run.fetched('tags', tags.length);
  const byName = new Map((await rows('SELECT id, name FROM tags WHERE workspace_id = $1', [ws])).map((t) => [lower(t.name), t.id]));
  await run.writeBatch('tags', tags, async (t) => {
    let id = t.id;
    if (!run.local.tag.has(id) && byName.has(lower(t.name))) { id = byName.get(lower(t.name)); run.log(`Etiqueta "${t.name}" já existe localmente (${id}) – mapeada`); }
    if (!isValidId(id)) id = newId();
    const res = await run.upsert('tags', { id, workspace_id: ws, name: t.name || 'tag', archived: !!t.archived }, ['name', 'archived']);
    run.count('tags', res);
    if (res === 'skipped') { run.log(`Etiqueta ${t.id} pertence a outro workspace local – ignorada`); return; }
    run.local.tag.add(id);
    if (id !== t.id) run.map.tag.set(t.id, id);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Custom fields (+ project defaults, + pending user values)
// ---------------------------------------------------------------------------------------------------------------

async function importCustomFields(run) {
  const ws = run.targetWorkspaceId;
  const fields = arr(await run.client.get(`/workspaces/${run.sourceWorkspaceId}/custom-fields`));
  run.fetched('customFields', fields.length);
  const byKey = new Map([...run.local.customField.values()].map((f) => [`${lower(f.name)}|${f.entity_type}`, f.id]));
  await run.writeBatch('customFields', fields, async (f) => {
    let id = f.id;
    const entityType = f.entityType === 'USER' ? 'USER' : 'TIMEENTRY';
    const key = `${lower(f.name)}|${entityType}`;
    if (!run.local.customField.has(id) && byKey.has(key)) { id = byKey.get(key); run.log(`Campo personalizado "${f.name}" já existe localmente (${id}) – mapeado`); }
    if (!isValidId(id)) id = newId();
    const row = {
      id, workspace_id: ws, name: f.name || 'Campo', type: f.type || 'TXT', entity_type: entityType, placeholder: f.placeholder || null, description: f.description || null,
      allowed_values: arr(f.allowedValues), workspace_default_value: f.workspaceDefaultValue === undefined ? null : JSON.stringify(f.workspaceDefaultValue ?? null),
      status: ['VISIBLE', 'INVISIBLE', 'INACTIVE'].includes(f.status) ? f.status : 'VISIBLE', required: !!f.required, only_admin_can_edit: !!f.onlyAdminCanEdit,
    };
    const res = await run.upsert('custom_fields', row, ['name', 'type', 'entity_type', 'placeholder', 'description', 'allowed_values', 'workspace_default_value', 'status', 'required', 'only_admin_can_edit']);
    run.count('customFields', res);
    if (res === 'skipped') { run.log(`Campo personalizado ${f.id} pertence a outro workspace local – ignorado`); return; }
    run.local.customField.set(id, { ...row, allowed_values: row.allowed_values });
    if (id !== f.id) run.map.customField.set(f.id, id);
    for (const d of arr(f.projectDefaultValues)) {
      const projectId = run.resolve('project', d.projectId);
      if (!projectId) continue;
      await run.exec(`INSERT INTO custom_field_project_defaults (custom_field_id, project_id, value, status) VALUES ($1,$2,$3,$4) ON CONFLICT (custom_field_id, project_id) DO UPDATE SET value = EXCLUDED.value, status = EXCLUDED.status`,
        [id, projectId, JSON.stringify(d.value ?? null), d.status || 'VISIBLE']);
    }
  });
}

// Writes deferred records that depend on several stages (user custom field values, project manager roles).
async function flushPending(run) {
  const ws = run.targetWorkspaceId;
  for (const v of run.pendingUserCustomFields.splice(0)) {
    const fieldId = run.resolve('customField', v.customFieldId);
    if (!fieldId) continue;
    try {
      await run.exec(`INSERT INTO custom_field_values (entity_type, entity_id, custom_field_id, workspace_id, value, source_type) VALUES ('USER',$1,$2,$3,$4,'USER') ON CONFLICT (entity_type, entity_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value`,
        [v.userId, fieldId, ws, JSON.stringify(v.value ?? null)]);
    } catch (err) { run.log(`Valor de campo personalizado do usuário ${v.userId} não importado: ${err.message}`); }
  }
  if (run.pendingProjectManagers.length) await applyProjectManagers(run);
}

// ---------------------------------------------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------------------------------------------

async function importTimeEntries(run) {
  const seen = new Set();
  const users = [...run.userMap.entries()];
  const now = new Date(Date.now() + DAY_MS);
  let ui = 0; let processed = 0;
  run.timeEntryIds = new Set();
  for (const [sourceUid, localUid] of users) {
    ui += 1;
    const label = `usuário ${ui}/${users.length}`;
    run.tick(processed, null, label);
    const write = async (items) => {
      const fresh = items.filter((e) => e && e.id && !seen.has(e.id));
      fresh.forEach((e) => seen.add(e.id));
      run.fetched('timeEntries', fresh.length);
      await run.writeBatch('timeEntries', fresh, (e) => writeTimeEntry(run, e, localUid), { size: 250 });
      processed += fresh.length;
      run.tick(processed, null, label);
    };
    try {
      for (const [start, end] of windows(run.since, now, 366, 2)) {
        await run.checkCancelledFast();
        await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/user/${sourceUid}/time-entries`, {
          pageSize: run.options.pageSize || 1000, collect: false, query: { hydrated: false, start: toIso(start), end: toIso(end) }, onPage: write,
        });
      }
      // running timer (may be excluded by the end filter)
      const running = arr(await run.client.get(`/workspaces/${run.sourceWorkspaceId}/user/${sourceUid}/time-entries`, { hydrated: false, 'in-progress': true, 'page-size': 50 }));
      await write(running);
    } catch (err) {
      if (err instanceof ImportCancelledError) throw err;
      run.count('timeEntries', 'errors');
      run.log(`Registros de tempo do usuário ${sourceUid}: ${err.message}`);
    }
  }
  run.log(`${processed} registro(s) de tempo processado(s)`);
}

async function writeTimeEntry(run, e, localUid) {
  const ws = run.targetWorkspaceId;
  const userId = run.mapUser(e.userId) || localUid;
  if (!userId) { run.count('timeEntries', 'skipped'); return; }
  const start = validDate(e.timeInterval?.start);
  const end = e.timeInterval?.end ? validDate(e.timeInterval.end) : null;
  if (!start) throw new Error(`invalid start ${e.timeInterval?.start}`);
  if (end && end <= start) throw new Error(`end (${e.timeInterval.end}) is not after start (${e.timeInterval.start})`);
  const projectId = run.resolve('project', e.projectId);
  if (e.projectId && !projectId) run.warnOnce(`project:${e.projectId}`, `Projeto ${e.projectId} não existe localmente – registros ficarão sem projeto`);
  let taskId = run.resolve('task', e.taskId);
  if (taskId && projectId && run.local.task.get(taskId) !== projectId) taskId = null;
  if (!projectId) taskId = null;
  const id = isValidId(e.id) ? e.id : newId();
  if (!end && !run.dryRun) {
    const running = await one('SELECT id FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND end_time IS NULL AND deleted_at IS NULL', [ws, userId]);
    if (running && running.id !== id) { run.count('timeEntries', 'skipped'); run.log(`Timer em andamento ${e.id} ignorado: já existe um timer local em execução para o usuário`); return; }
  }
  let hourly = cents(e.hourlyRate); let cost = cents(e.costRate); let currency = e.hourlyRate?.currency || null;
  if (hourly == null || cost == null) {
    const r = run.dryRun ? { hourlyRate: { amount: 0, currency: run.defaultCurrency }, costRate: { amount: 0 } } : await run.ratesFor(userId, projectId, taskId);
    if (hourly == null) { hourly = r.hourlyRate.amount; currency = currency || r.hourlyRate.currency; }
    if (cost == null) cost = r.costRate.amount;
  }
  const res = await run.upsert('time_entries', {
    id, workspace_id: ws, user_id: userId, project_id: projectId, task_id: taskId, description: String(e.description || '').slice(0, 3000), start_time: start, end_time: end,
    billable: !!e.billable, type: ['REGULAR', 'BREAK', 'HOLIDAY', 'TIME_OFF'].includes(e.type) ? e.type : 'REGULAR', locked: !!(e.isLocked ?? e.locked), kiosk_id: isValidId(e.kioskId) ? e.kioskId : null,
    hourly_rate_amount: hourly, hourly_rate_currency: currency || run.defaultCurrency, cost_rate_amount: cost, time_zone: run.userTimeZone.get(e.userId) || null, origin: 'IMPORT', deleted_at: null,
  }, ['user_id', 'project_id', 'task_id', 'description', 'start_time', 'end_time', 'billable', 'type', 'locked', 'kiosk_id', 'hourly_rate_amount', 'hourly_rate_currency', 'cost_rate_amount', 'time_zone', 'deleted_at']);
  run.count('timeEntries', res);
  if (res === 'skipped') { run.warnOnce(`entry-other-ws:${id}`, `Registro ${id} pertence a outro workspace local – ignorado`); return; }
  run.timeEntryIds.add(id);
  const tagIds = [...new Set(arr(e.tagIds).map((t) => run.resolve('tag', t)).filter(Boolean))];
  await run.exec('DELETE FROM time_entry_tags WHERE time_entry_id = $1', [id]);
  for (const t of tagIds) await run.exec('INSERT INTO time_entry_tags (time_entry_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, t]);
  for (const v of arr(e.customFieldValues)) {
    const fieldId = run.resolve('customField', v.customFieldId);
    if (!fieldId) continue;
    const cf = run.local.customField.get(fieldId);
    let value = v.value;
    if (cf) { try { value = normalizeValue(cf, v.value); } catch { value = v.value; } }
    await run.exec(`INSERT INTO custom_field_values (entity_type, entity_id, custom_field_id, workspace_id, value, source_type) VALUES ('TIMEENTRY',$1,$2,$3,$4,$5) ON CONFLICT (entity_type, entity_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value, source_type = EXCLUDED.source_type`,
      [id, fieldId, ws, JSON.stringify(value ?? null), v.sourceType || 'TIMEENTRY']);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Expenses (+ categories, receipts)
// ---------------------------------------------------------------------------------------------------------------

async function importExpenses(run) {
  const ws = run.targetWorkspaceId;
  const catList = [];
  for (const archived of [false, true]) {
    catList.push(...await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/expenses/categories`, { pageSize: 200, query: { archived }, extract: (r) => (Array.isArray(r) ? r : r?.categories) }));
  }
  const categories = dedupeById(catList);
  run.fetched('expenseCategories', categories.length);
  const catByName = new Map((await rows('SELECT id, name FROM expense_categories WHERE workspace_id = $1', [ws])).map((c) => [lower(c.name), c.id]));
  await run.writeBatch('expenseCategories', categories, async (c) => {
    let id = c.id;
    if (!run.local.category.has(id) && catByName.has(lower(c.name))) id = catByName.get(lower(c.name));
    if (!isValidId(id)) id = newId();
    const res = await run.upsert('expense_categories', { id, workspace_id: ws, name: c.name || 'Categoria', has_unit_price: !!c.hasUnitPrice, unit: c.unit || null, price_in_cents: Math.round(Number(c.priceInCents || 0)), archived: !!c.archived }, ['name', 'has_unit_price', 'unit', 'price_in_cents', 'archived']);
    run.count('expenseCategories', res);
    if (res === 'skipped') return;
    run.local.category.add(id);
    if (id !== c.id) run.map.category.set(c.id, id);
  });

  const seen = new Set();
  const users = [...run.userMap.entries()];
  let ui = 0; let processed = 0;
  for (const [sourceUid, localUid] of users) {
    ui += 1;
    run.tick(processed, null, `usuário ${ui}/${users.length}`);
    try {
      await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/expenses`, {
        pageSize: 200, collect: false, query: { 'user-id': sourceUid }, extract: extractExpenses,
        onPage: async (items) => {
          const fresh = items.filter((x) => x && x.id && !seen.has(x.id));
          fresh.forEach((x) => seen.add(x.id));
          run.fetched('expenses', fresh.length);
          await run.writeBatch('expenses', fresh, (x) => writeExpense(run, x, localUid), { size: 50 });
          processed += fresh.length;
          run.tick(processed, null, `usuário ${ui}/${users.length}`);
        },
      });
    } catch (err) {
      if (err instanceof ImportCancelledError) throw err;
      run.count('expenses', 'errors');
      run.log(`Despesas do usuário ${sourceUid}: ${err.message}`);
    }
  }
}

function extractExpenses(r) {
  if (Array.isArray(r)) return r;
  if (Array.isArray(r?.expenses)) return r.expenses;
  if (Array.isArray(r?.expenses?.expenses)) return r.expenses.expenses;
  return [];
}

async function writeExpense(run, x, localUid) {
  const ws = run.targetWorkspaceId;
  const userId = run.mapUser(x.userId) || localUid;
  const projectId = run.resolve('project', x.projectId || x.project?.id);
  let taskId = run.resolve('task', x.taskId || x.task?.id);
  if (!projectId || (taskId && run.local.task.get(taskId) !== projectId)) taskId = null;
  const categoryId = run.resolve('category', x.categoryId || x.category?.id);
  const id = isValidId(x.id) ? x.id : newId();
  let fileId = null;
  if (x.fileId && !run.dryRun) fileId = await importReceipt(run, x, userId);
  const date = dateOnly(x.date) || new Date().toISOString().slice(0, 10);
  const res = await run.upsert('expenses', {
    id, workspace_id: ws, user_id: userId, project_id: projectId, task_id: taskId, category_id: categoryId, date, notes: x.notes || null,
    quantity: x.quantity == null ? 1 : Number(x.quantity), total: Number(x.total || 0), billable: !!x.billable, file_id: fileId, locked: !!(x.locked ?? x.isLocked),
    approval_request_id: isValidId(x.approvalRequestId) ? x.approvalRequestId : null, approval_status: x.approvalStatus && x.approvalStatus !== 'UNSUBMITTED' ? x.approvalStatus : null, deleted_at: null,
  }, ['user_id', 'project_id', 'task_id', 'category_id', 'date', 'notes', 'quantity', 'total', 'billable', 'file_id', 'locked', 'deleted_at']);
  run.count('expenses', res);
}

async function importReceipt(run, x, userId) {
  const ws = run.targetWorkspaceId;
  const fileId = isValidId(x.fileId) ? x.fileId : newId();
  const existing = await one('SELECT id FROM files WHERE id = $1', [fileId]);
  if (existing) return fileId;
  try {
    const dl = await run.client.download(`/workspaces/${run.sourceWorkspaceId}/expenses/${x.id}/files/${x.fileId}`);
    await query('INSERT INTO files (id, workspace_id, user_id, name, mime_type, size, data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
      [fileId, ws, userId, x.fileName || dl.fileName || `receipt-${x.id}`, dl.contentType.split(';')[0], dl.data.length, dl.data]);
    run.count('receipts', 'created');
    return fileId;
  } catch (err) {
    run.count('receipts', 'errors');
    run.log(`Recibo da despesa ${x.id} não baixado: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------------------------------------------

async function importHolidays(run) {
  const ws = run.targetWorkspaceId;
  const list = arr(await run.client.get(`/workspaces/${run.sourceWorkspaceId}/holidays`));
  run.fetched('holidays', list.length);
  await run.writeBatch('holidays', list, async (h) => {
    const id = isValidId(h.id) ? h.id : newId();
    const startDate = dateOnly(h.datePeriod?.startDate || h.datePeriod?.start || h.startDate);
    const endDate = dateOnly(h.datePeriod?.endDate || h.datePeriod?.end || h.endDate) || startDate;
    if (!startDate) throw new Error('holiday without start date');
    const projectId = run.resolve('project', h.projectId || h.automaticTimeEntryCreation?.defaultEntities?.projectId);
    const taskId = run.resolve('task', h.taskId || h.automaticTimeEntryCreation?.defaultEntities?.taskId);
    const auto = typeof h.automaticTimeEntryCreation === 'object' && h.automaticTimeEntryCreation
      ? h.automaticTimeEntryCreation
      : { enabled: !!h.automaticTimeEntryCreation, defaultEntities: { projectId: projectId || null, taskId: taskId || null } };
    const res = await run.upsert('holidays', {
      id, workspace_id: ws, name: h.name || 'Feriado', color: h.color || null, start_date: startDate, end_date: endDate, occurs_annually: !!h.occursAnnually,
      everyone_including_new: h.everyoneIncludingNew !== false, automatic_time_entry_creation: auto, project_id: projectId, task_id: projectId ? taskId : null,
    }, ['name', 'color', 'start_date', 'end_date', 'occurs_annually', 'everyone_including_new', 'automatic_time_entry_creation', 'project_id', 'task_id']);
    run.count('holidays', res);
    if (res === 'skipped') return;
    for (const uid of arr(h.userIds)) { const local = run.mapUser(uid); if (local) await run.exec('INSERT INTO holiday_users (holiday_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, local]); }
    for (const gid of arr(h.userGroupIds)) { const local = run.resolve('group', gid); if (local) await run.exec('INSERT INTO holiday_groups (holiday_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, local]); }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Time off: policies, balances and requests
// ---------------------------------------------------------------------------------------------------------------

async function importTimeOff(run) {
  const ws = run.targetWorkspaceId;
  const policies = dedupeById(await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/time-off/policies`, { pageSize: 200, query: { status: 'ALL' } }));
  run.fetched('timeOffPolicies', policies.length);
  await run.writeBatch('timeOffPolicies', policies, async (p) => {
    const id = isValidId(p.id) ? p.id : newId();
    const projectId = run.resolve('project', p.projectId || p.automaticTimeEntryCreation?.defaultEntities?.projectId);
    const taskId = run.resolve('task', p.automaticTimeEntryCreation?.defaultEntities?.taskId);
    const auto = p.automaticTimeEntryCreation ? { enabled: !!p.automaticTimeEntryCreation.enabled, defaultEntities: { projectId: projectId || null, taskId: projectId ? taskId : null } } : null;
    const res = await run.upsert('time_off_policies', {
      id, workspace_id: ws, name: p.name || 'Política', color: p.color || null, icon: p.icon || null, time_unit: p.timeUnit === 'HOURS' ? 'HOURS' : 'DAYS',
      allow_half_day: !!p.allowHalfDay, allow_negative_balance: !!p.allowNegativeBalance, negative_balance: p.negativeBalance || null,
      approve: p.approve ? { requiresApproval: !!p.approve.requiresApproval, teamManagers: !!p.approve.teamManagers, specificMembers: !!p.approve.specificMembers, userIds: arr(p.approve.userIds).map((u) => run.mapUser(u)).filter(Boolean) } : undefined,
      automatic_accrual: p.automaticAccrual || null, automatic_time_entry_creation: auto, everyone_including_new: !!p.everyoneIncludingNew, archived: !!p.archived,
    }, ['name', 'color', 'icon', 'time_unit', 'allow_half_day', 'allow_negative_balance', 'negative_balance', 'approve', 'automatic_accrual', 'automatic_time_entry_creation', 'everyone_including_new', 'archived']);
    run.count('timeOffPolicies', res);
    if (res === 'skipped') return;
    run.local.policy.add(id);
    if (id !== p.id) run.map.policy.set(p.id, id);
    for (const uid of arr(p.userIds)) { const local = run.mapUser(uid); if (local) await run.exec('INSERT INTO time_off_policy_users (policy_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, local]); }
    for (const gid of arr(p.userGroupIds)) { const local = run.resolve('group', gid); if (local) await run.exec('INSERT INTO time_off_policy_groups (policy_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, local]); }
  });

  // balances
  for (const p of policies) {
    const policyId = run.resolve('policy', p.id);
    if (!policyId) continue;
    let balances = [];
    try {
      balances = await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/time-off/balance/policy/${p.id}`, { pageSize: 200, extract: (r) => (Array.isArray(r) ? r : r?.balances) });
    } catch (err) { run.log(`Saldos da política ${p.name}: ${err.message}`); continue; }
    run.fetched('timeOffBalances', balances.length);
    await run.writeBatch('timeOffBalances', balances, async (b) => {
      const userId = run.mapUser(b.userId);
      if (!userId) { run.count('timeOffBalances', 'skipped'); return; }
      const res = await run.upsert('time_off_balances', { id: isValidId(b.id) ? b.id : newId(), workspace_id: ws, policy_id: policyId, user_id: userId, total: Number(b.total || 0), used: Number(b.used || 0) }, ['total', 'used'], { conflict: 'policy_id, user_id', scope: null });
      run.count('timeOffBalances', res);
    });
  }

  // requests (POST listing, yearly windows)
  const seen = new Set();
  const now = new Date(Date.now() + 366 * DAY_MS);
  for (const [start, end] of windows(run.since, now, 366, 0)) {
    let requests = [];
    try {
      requests = await run.client.postAll(`/workspaces/${run.sourceWorkspaceId}/time-off/requests`, { statuses: ['ALL'], start: toIso(start), end: toIso(end) }, { pageSize: 200, extract: (r) => (Array.isArray(r) ? r : r?.requests) });
    } catch (err) { run.log(`Solicitações de folga (${toIso(start).slice(0, 10)}..${toIso(end).slice(0, 10)}): ${err.message}`); continue; }
    const fresh = requests.filter((r) => r && r.id && !seen.has(r.id));
    fresh.forEach((r) => seen.add(r.id));
    run.fetched('timeOffRequests', fresh.length);
    await run.writeBatch('timeOffRequests', fresh, async (r) => {
      const policyId = run.resolve('policy', r.policyId);
      const userId = run.mapUser(r.userId);
      if (!policyId || !userId) { run.count('timeOffRequests', 'skipped'); return; }
      const period = r.timeOffPeriod?.period || r.timeOffPeriod || {};
      const s = validDate(period.start); const e = validDate(period.end) || s;
      if (!s) throw new Error('time off request without period');
      const statusObj = r.status && typeof r.status === 'object' ? r.status : { statusType: r.status };
      let status = String(statusObj.statusType || 'PENDING').toUpperCase();
      if (!['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'].includes(status)) status = status.startsWith('WITHDRAWN') ? 'WITHDRAWN' : 'PENDING';
      const timeUnit = r.timeUnit === 'HOURS' ? 'HOURS' : 'DAYS';
      const balanceDiff = Number(r.balanceDiff || 0);
      const days = timeUnit === 'DAYS' ? Math.abs(balanceDiff) || Math.max(1, Math.round((e - s) / DAY_MS)) : null;
      const res = await run.upsert('time_off_requests', {
        id: isValidId(r.id) ? r.id : newId(), workspace_id: ws, policy_id: policyId, user_id: userId, requester_user_id: run.mapUser(r.requesterUserId) || userId,
        start_time: s, end_time: e, days, half_day: !!r.timeOffPeriod?.halfDay, half_day_period: r.timeOffPeriod?.halfDayPeriod || null, time_unit: timeUnit, balance_diff: balanceDiff,
        note: r.note || null, status, status_note: statusObj.note || null, status_changed_by: run.mapUser(statusObj.changedByUserId), status_changed_at: validDate(statusObj.changedAt), created_at: validDate(r.createdAt) || undefined,
      }, ['policy_id', 'user_id', 'requester_user_id', 'start_time', 'end_time', 'days', 'half_day', 'half_day_period', 'time_unit', 'balance_diff', 'note', 'status', 'status_note', 'status_changed_by', 'status_changed_at']);
      run.count('timeOffRequests', res);
    });
  }
  const d = run.progress.details;
  run.progress.counts.timeOff = (d.timeOffPolicies?.created || 0) + (d.timeOffPolicies?.updated || 0) + (d.timeOffRequests?.created || 0) + (d.timeOffRequests?.updated || 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Approval requests
// ---------------------------------------------------------------------------------------------------------------

async function importApprovals(run) {
  const ws = run.targetWorkspaceId;
  const seen = new Set();
  for (const status of APPROVAL_STATUSES) {
    let list = [];
    try { list = await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/approval-requests`, { pageSize: 200, query: { status } }); } catch (err) { run.log(`Aprovações ${status}: ${err.message}`); continue; }
    const fresh = list.map((item) => ({ item, ar: item?.approvalRequest || item })).filter(({ ar }) => ar && ar.id && !seen.has(ar.id));
    fresh.forEach(({ ar }) => seen.add(ar.id));
    run.fetched('approvals', fresh.length);
    await run.writeBatch('approvals', fresh, async ({ item, ar }) => {
      const ownerId = run.mapUser(ar.owner?.userId || ar.userId);
      if (!ownerId) { run.count('approvals', 'skipped'); return; }
      const s = validDate(ar.dateRange?.start); const e = validDate(ar.dateRange?.end);
      if (!s || !e) throw new Error('approval request without date range');
      const state = APPROVAL_STATUSES.includes(ar.status?.state) ? ar.status.state : status;
      const daysLen = Math.round((e - s) / DAY_MS);
      const period = daysLen <= 8 ? 'WEEKLY' : daysLen <= 17 ? 'SEMI_MONTHLY' : 'MONTHLY';
      const id = isValidId(ar.id) ? ar.id : newId();
      const res = await run.upsert('approval_requests', {
        id, workspace_id: ws, owner_user_id: ownerId, creator_user_id: run.mapUser(ar.creator?.userId) || ownerId, period, date_start: s, date_end: e, state,
        note: ar.status?.note || null, updated_by: run.mapUser(ar.status?.updatedBy), updated_at: validDate(ar.status?.updatedAt) || undefined,
      }, ['owner_user_id', 'creator_user_id', 'period', 'date_start', 'date_end', 'state', 'note', 'updated_by', 'updated_at']);
      run.count('approvals', res);
      if (res === 'skipped') return;
      const entryIds = arr(item.entries).map((x) => x?.id).filter(isValidId);
      if (entryIds.length) await run.exec('UPDATE time_entries SET approval_request_id = $1, approval_status = $2 WHERE workspace_id = $3 AND id = ANY($4)', [id, state, ws, entryIds]);
      const expenseIds = arr(item.expenses).map((x) => x?.id).filter(isValidId);
      if (expenseIds.length) await run.exec('UPDATE expenses SET approval_request_id = $1, approval_status = $2 WHERE workspace_id = $3 AND id = ANY($4)', [id, state, ws, expenseIds]);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scheduling assignments
// ---------------------------------------------------------------------------------------------------------------

async function importScheduling(run) {
  const ws = run.targetWorkspaceId;
  const seen = new Set();
  const horizon = new Date(Date.now() + 730 * DAY_MS);
  for (const [start, end] of windows(run.since, horizon, 92, 0)) {
    let list = [];
    try {
      list = await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/scheduling/assignments/all`, { pageSize: 200, query: { start: toIso(start), end: toIso(end) } });
    } catch (err) { run.log(`Agenda (${toIso(start).slice(0, 10)}..${toIso(end).slice(0, 10)}): ${err.message}`); continue; }
    const fresh = list.filter((a) => a && a.id && !seen.has(a.id));
    fresh.forEach((a) => seen.add(a.id));
    run.fetched('scheduling', fresh.length);
    await run.writeBatch('scheduling', fresh, async (a) => {
      const projectId = run.resolve('project', a.projectId);
      const userId = run.mapUser(a.userId);
      if (!projectId || !userId) { run.count('scheduling', 'skipped'); return; }
      let taskId = run.resolve('task', a.taskId);
      if (taskId && run.local.task.get(taskId) !== projectId) taskId = null;
      const startDate = dateOnly(a.period?.start); const endDate = dateOnly(a.period?.end) || startDate;
      if (!startDate) throw new Error('assignment without period');
      const res = await run.upsert('scheduling_assignments', {
        id: isValidId(a.id) ? a.id : newId(), workspace_id: ws, project_id: projectId, task_id: taskId, user_id: userId, start_date: startDate, end_date: endDate,
        hours_per_day: Number(a.hoursPerDay ?? 8), start_time: a.startTime || null, include_non_working_days: !!a.includeNonWorkingDays, note: a.note || null,
        billable: a.billable ?? null, published: a.published ?? true, series_id: isValidId(a.recurring?.seriesId) ? a.recurring.seriesId : null, recurring_weeks: a.recurring?.weeks ?? null, recurring_repeat: !!a.recurring?.repeat,
      }, ['project_id', 'task_id', 'user_id', 'start_date', 'end_date', 'hours_per_day', 'start_time', 'include_non_working_days', 'note', 'billable', 'published', 'series_id', 'recurring_weeks', 'recurring_repeat']);
      run.count('scheduling', res);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Invoices (+ items and payments)
// ---------------------------------------------------------------------------------------------------------------

async function importInvoices(run) {
  const ws = run.targetWorkspaceId;
  const list = dedupeById(await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/invoices`, { pageSize: 200, extract: (r) => (Array.isArray(r) ? r : r?.invoices) }));
  run.fetched('invoices', list.length);
  let i = 0;
  for (const summary of list) {
    run.tick(++i, list.length, summary.number);
    try {
      let inv = summary;
      try { inv = { ...summary, ...(await run.client.get(`/workspaces/${run.sourceWorkspaceId}/invoices/${summary.id}`)) }; } catch (err) { run.log(`Detalhe da fatura ${summary.number}: ${err.message}`); }
      let payments = [];
      try { payments = await run.client.getAll(`/workspaces/${run.sourceWorkspaceId}/invoices/${summary.id}/payments`, { pageSize: 200 }); } catch (err) { run.log(`Pagamentos da fatura ${summary.number}: ${err.message}`); }
      await run.writeBatch('invoices', [inv], async (x) => {
        const id = isValidId(x.id) ? x.id : newId();
        const issued = dateOnly(x.issuedDate) || new Date().toISOString().slice(0, 10);
        const res = await run.upsert('invoices', {
          id, workspace_id: ws, number: String(x.number || id), client_id: run.resolve('client', x.clientId), user_id: run.mapUser(x.userId), issued_date: issued, due_date: dateOnly(x.dueDate) || issued,
          currency: x.currency || run.defaultCurrency, status: ['UNSENT', 'SENT', 'PAID', 'PARTIALLY_PAID', 'VOID', 'OVERDUE'].includes(x.status) ? x.status : 'UNSENT', subject: x.subject || null, note: x.note || null,
          bill_from: x.billFrom || null, client_address: x.clientAddress || null, discount_percent: Number(x.discount || 0), tax_percent: Number(x.tax || 0), tax2_percent: Number(x.tax2 || 0),
          tax_type: ['SIMPLE', 'COMPOUND', 'NONE'].includes(x.taxType) ? x.taxType : 'SIMPLE', calculation_type: x.calculationType || 'NET', visible_zero_fields: x.visibleZeroFields ?? [],
        }, ['number', 'client_id', 'user_id', 'issued_date', 'due_date', 'currency', 'status', 'subject', 'note', 'bill_from', 'client_address', 'discount_percent', 'tax_percent', 'tax2_percent', 'tax_type', 'calculation_type', 'visible_zero_fields']);
        run.count('invoices', res);
        if (res === 'skipped') return;
        if (Array.isArray(x.items)) {
          await run.exec('DELETE FROM invoice_items WHERE invoice_id = $1', [id]);
          let pos = 0;
          for (const it of x.items) {
            const entryIds = arr(it.timeEntryIds).filter(isValidId); const expenseIds = arr(it.expenseIds).filter(isValidId);
            await run.exec(`INSERT INTO invoice_items (id, invoice_id, position, item_type, description, quantity, unit_price, apply_taxes, import_type, time_entry_ids, expense_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [newId(), id, it.order ?? pos, it.itemType || 'Service', it.description || '', Number(it.quantity ?? 1), Math.round(Number(it.unitPrice || 0)), it.applyTaxes || 'NONE', it.importType || 'NOT_IMPORTED', JSON.stringify(entryIds), JSON.stringify(expenseIds)]);
            pos += 1;
            if (entryIds.length) await run.exec('UPDATE time_entries SET invoiced = true, invoice_id = $1 WHERE workspace_id = $2 AND id = ANY($3)', [id, ws, entryIds]);
            if (expenseIds.length) await run.exec('UPDATE expenses SET invoiced = true, invoice_id = $1 WHERE workspace_id = $2 AND id = ANY($3)', [id, ws, expenseIds]);
          }
        }
        for (const p of payments) {
          if (!p) continue;
          await run.exec(`INSERT INTO invoice_payments (id, invoice_id, amount, date, note, author_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET amount = EXCLUDED.amount, date = EXCLUDED.date, note = EXCLUDED.note`,
            [isValidId(p.id) ? p.id : newId(), id, Math.round(Number(p.amount || 0)), dateOnly(p.date) || issued, p.note || null, run.mapUser(p.author)]);
        }
      });
    } catch (err) {
      if (err instanceof ImportCancelledError) throw err;
      run.count('invoices', 'errors');
      run.log(`Fatura ${summary.number || summary.id}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Webhooks (re-created disabled so nothing fires during/after the migration)
// ---------------------------------------------------------------------------------------------------------------

async function importWebhooks(run) {
  const ws = run.targetWorkspaceId;
  let payload;
  try { payload = await run.client.get(`/workspaces/${run.sourceWorkspaceId}/webhooks`); } catch (err) {
    if (err instanceof ClockifyApiError && err.status === 400) payload = await run.client.get(`/workspaces/${run.sourceWorkspaceId}/webhooks`, { type: 'USER_CREATED' });
    else throw err;
  }
  const list = Array.isArray(payload) ? payload : arr(payload?.webhooks);
  run.fetched('webhooks', list.length);
  await run.writeBatch('webhooks', list, async (w) => {
    const res = await run.upsert('webhooks', {
      id: isValidId(w.id) ? w.id : newId(), workspace_id: ws, user_id: run.mapUser(w.userId) || run.importer.id, name: w.name || null, url: w.url, event: w.webhookEvent || w.event || 'NEW_TIME_ENTRY',
      trigger_source: arr(w.triggerSource), trigger_source_type: w.triggerSourceType || 'WORKSPACE_ID', auth_token: w.authToken || randomToken(24), enabled: false, delivery_enabled: false,
    }, [], { ignore: true });
    run.count('webhooks', res);
  });
  if (list.length) run.log(`${list.length} webhook(s) recriado(s) desabilitados – habilite manualmente após validar a migração`);
}

// ---------------------------------------------------------------------------------------------------------------

function dedupeById(list) {
  const seen = new Set(); const out = [];
  for (const item of list) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id); out.push(item);
  }
  return out;
}
