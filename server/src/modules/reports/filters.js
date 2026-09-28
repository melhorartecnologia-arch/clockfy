// Common report filter parsing (Clockify ReportFilterV1) and time entry loading for all report types.
import { rows } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { parse, z } from '../../lib/validate.js';
import { isValidTimeZone, resolveDateRange, zonedTime, parseDateOnly, localDateString, startOfWeek, zonedParts } from '../../lib/dates.js';
import { roundSeconds } from '../../lib/duration.js';
import { visibleUserIds } from '../../middleware/workspace.js';

export const CONTAINS = ['CONTAINS', 'DOES_NOT_CONTAIN', 'CONTAINS_ONLY'];
export const AMOUNT_TYPES = ['EARNED', 'COST', 'PROFIT'];
export const EXPORT_TYPES = ['JSON', 'JSON_V1', 'CSV', 'XLSX', 'PDF', 'ZIP'];

const containsFilter = z.object({
  ids: z.array(z.string()).nullable().optional(),
  contains: z.enum(CONTAINS).optional(),
  containedInTimeentry: z.enum(CONTAINS).optional(),
  status: z.string().optional(),
}).passthrough();

const customFieldFilter = z.object({
  id: z.string(),
  value: z.any().optional(),
  isEmpty: z.boolean().optional(),
  numberCondition: z.enum(['EQUAL', 'GREATER_THAN', 'LESS_THAN']).optional(),
  type: z.string().optional(),
}).passthrough();

export const commonFilterSchema = z.object({
  dateRangeStart: z.string().optional(),
  dateRangeEnd: z.string().optional(),
  dateRangeType: z.string().optional(),
  timeZone: z.string().optional(),
  weekStart: z.string().optional(),
  users: containsFilter.optional(),
  userGroups: containsFilter.optional(),
  clients: containsFilter.optional(),
  projects: containsFilter.optional(),
  tasks: containsFilter.optional(),
  tags: containsFilter.optional(),
  billable: z.boolean().nullable().optional(),
  description: z.string().nullable().optional(),
  withoutDescription: z.boolean().optional(),
  invoicingState: z.enum(['INVOICED', 'UNINVOICED', 'ALL']).optional(),
  approvalState: z.enum(['APPROVED', 'UNAPPROVED', 'ALL']).optional(),
  archived: z.boolean().nullable().optional(),
  customFields: z.array(customFieldFilter).optional(),
  amountShown: z.enum(['EARNED', 'COST', 'PROFIT', 'HIDE_AMOUNT', 'EXPORT']).optional(),
  amounts: z.array(z.enum(['EARNED', 'COST', 'PROFIT', 'HIDE_AMOUNT', 'EXPORT'])).optional(),
  rounding: z.boolean().optional(),
  sortOrder: z.enum(['ASCENDING', 'DESCENDING']).optional(),
  zoomLevel: z.enum(['WEEK', 'MONTH', 'YEAR']).optional(),
  exportType: z.enum(EXPORT_TYPES).optional(),
  dateFormat: z.string().optional(),
  timeFormat: z.string().optional(),
  userLocale: z.string().optional(),
}).passthrough();

// Parses a Clockify date string. Values without a zone are interpreted in `timeZone`.
export function parseReportDate(value, timeZone, { endOfDay = false, field = 'date' } = {}) {
  const str = String(value || '').trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (dateOnly) {
    const d = parseDateOnly(str);
    return endOfDay ? new Date(zonedTime(timeZone, d.year, d.month, d.day + 1).getTime() - 1) : zonedTime(timeZone, d.year, d.month, d.day);
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(str);
  if (local) {
    const [, y, m, d, h, mi, s, frac] = local;
    const base = zonedTime(timeZone, Number(y), Number(m), Number(d), Number(h), Number(mi), Number(s || 0));
    const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
    return new Date(base.getTime() + Math.min(ms, 999));
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid ${field}: ${value}`, 400);
  return d;
}

export function resolveTimeZone(ctx, tz) {
  if (tz) {
    if (!isValidTimeZone(tz)) throw badRequest(`Invalid timeZone: ${tz}`, 400);
    return tz;
  }
  const userTz = ctx.user?.settings?.timeZone;
  return userTz && isValidTimeZone(userTz) ? userTz : 'UTC';
}

export function resolveWeekStart(ctx, ws) {
  return String(ws || ctx.member?.week_start || ctx.user?.settings?.weekStart || 'MONDAY').toUpperCase();
}

// Normalizes the common part of every report filter.
export function parseCommonFilter(ctx, body, { now = new Date() } = {}) {
  const b = parse(commonFilterSchema, body || {});
  const timeZone = resolveTimeZone(ctx, b.timeZone);
  const weekStart = resolveWeekStart(ctx, b.weekStart);
  let start; let end;
  const type = String(b.dateRangeType || 'ABSOLUTE').toUpperCase();
  const resolved = type !== 'ABSOLUTE' ? resolveDateRange(type, now, timeZone, weekStart) : null;
  if (resolved) {
    [start, end] = resolved;
    end = new Date(end.getTime() - 1);
  } else {
    if (!b.dateRangeStart || !b.dateRangeEnd) throw badRequest('dateRangeStart and dateRangeEnd are required', 400);
    start = parseReportDate(b.dateRangeStart, timeZone, { field: 'dateRangeStart' });
    end = parseReportDate(b.dateRangeEnd, timeZone, { endOfDay: true, field: 'dateRangeEnd' });
  }
  if (end < start) throw badRequest('dateRangeEnd must be after dateRangeStart', 400);
  const amountTypes = resolveAmountTypes(b);
  const showRates = ctx.isAdmin || !ctx.settings.onlyAdminsSeeBillableRates;
  const round = b.rounding ? ctx.settings.round || null : null;
  return {
    ...b,
    start, end, timeZone, weekStart, dateRangeType: type,
    amountTypes, primaryAmount: amountTypes[0] || null, hideAmounts: amountTypes.length === 0,
    showRates, round,
    sortOrder: b.sortOrder || null,
    exportType: String(b.exportType || 'JSON').toUpperCase(),
    dateFormat: b.dateFormat || ctx.user?.settings?.dateFormat || 'YYYY-MM-DD',
    timeFormat: b.timeFormat || ctx.user?.settings?.timeFormat || 'HOUR24',
  };
}

export function resolveAmountTypes(b) {
  let list = Array.isArray(b.amounts) && b.amounts.length ? b.amounts : (b.amountShown ? [b.amountShown] : ['EARNED']);
  if (list.includes('HIDE_AMOUNT')) return [];
  list = list.filter((a) => AMOUNT_TYPES.includes(a));
  if (b.amountShown && AMOUNT_TYPES.includes(b.amountShown) && list.includes(b.amountShown)) list = [b.amountShown, ...list.filter((a) => a !== b.amountShown)];
  return [...new Set(list)];
}

// Who the caller can see, according to roles and workspace settings.
export async function visibilityScope(ctx) {
  if (ctx.isAdmin) return { userIds: null, projectIds: null };
  const s = ctx.settings;
  let userIds = s.onlyAdminsSeeAllTimeEntries === false ? null : await visibleUserIds(ctx);
  let projectIds = null;
  if (s.onlyAdminsSeePublicProjectsEntries) {
    const member = await rows(
      `SELECT DISTINCT pm.project_id FROM project_members pm WHERE (pm.target_type = 'USER' AND pm.target_id = $1) OR (pm.target_type = 'USERGROUP' AND pm.target_id IN (SELECT group_id FROM user_group_members WHERE user_id = $1))`,
      [ctx.user.id],
    );
    projectIds = [...new Set([...member.map((r) => r.project_id), ...ctx.managedProjects])];
  }
  if (userIds && !userIds.includes(ctx.user.id)) userIds = [ctx.user.id, ...userIds];
  return { userIds, projectIds };
}

function containsClause(conds, params, f, expr, { multi } = {}) {
  const ids = (f?.ids || []).filter(Boolean);
  if (!ids.length) return;
  const mode = f.containedInTimeentry || f.contains || 'CONTAINS';
  params.push(ids);
  const p = `$${params.length}`;
  if (!multi) {
    conds.push(mode === 'DOES_NOT_CONTAIN' ? `NOT COALESCE(${expr} = ANY(${p}), false)` : `${expr} = ANY(${p})`);
    return;
  }
  // multi-valued relations: expr is a sub-select returning the related ids of the entry
  if (mode === 'DOES_NOT_CONTAIN') conds.push(`NOT EXISTS (SELECT 1 FROM (${expr}) x WHERE x.id = ANY(${p}))`);
  else if (mode === 'CONTAINS_ONLY') conds.push(`(SELECT COALESCE(array_agg(DISTINCT x.id::text ORDER BY x.id::text), '{}') FROM (${expr}) x) = (SELECT COALESCE(array_agg(DISTINCT y ORDER BY y), '{}') FROM unnest(${p}::text[]) y)`);
  else conds.push(`EXISTS (SELECT 1 FROM (${expr}) x WHERE x.id = ANY(${p}))`);
}

function customFieldClause(conds, params, cf, field) {
  const base = `SELECT 1 FROM custom_field_values v WHERE v.entity_type = 'TIMEENTRY' AND v.entity_id = e.id AND v.custom_field_id = $`;
  params.push(cf.id);
  const idParam = params.length;
  const nonEmpty = `v.value IS NOT NULL AND v.value <> 'null'::jsonb AND v.value <> '[]'::jsonb AND v.value <> '""'::jsonb`;
  if (cf.isEmpty) { conds.push(`NOT EXISTS (${base}${idParam} AND ${nonEmpty})`); return; }
  if (cf.value === undefined || cf.value === null || cf.value === '') { conds.push(`EXISTS (${base}${idParam} AND ${nonEmpty})`); return; }
  const type = (field?.type || cf.type || 'TXT').toUpperCase();
  let cond;
  if (type === 'NUMBER') {
    params.push(Number(cf.value));
    const op = { GREATER_THAN: '>', LESS_THAN: '<' }[cf.numberCondition] || '=';
    cond = `jsonb_typeof(v.value) = 'number' AND (v.value#>>'{}')::numeric ${op} $${params.length}`;
  } else if (type === 'CHECKBOX') {
    params.push(cf.value === true || cf.value === 'true');
    cond = `(v.value#>>'{}')::boolean = $${params.length}`;
  } else if (type === 'DROPDOWN_SINGLE' || type === 'DROPDOWN_MULTIPLE') {
    params.push((Array.isArray(cf.value) ? cf.value : [cf.value]).map(String));
    cond = `((jsonb_typeof(v.value) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v.value) el WHERE el = ANY($${params.length}))) OR v.value#>>'{}' = ANY($${params.length}))`;
  } else {
    params.push(`%${String(cf.value).toLowerCase()}%`);
    cond = `lower(v.value#>>'{}') LIKE $${params.length}`;
  }
  conds.push(`EXISTS (${base}${idParam} AND ${cond})`);
}

// Builds the WHERE clause for time entries matching the filter (alias `e`, users `u`, projects `p`, clients `c`, tasks `t`).
export async function buildEntryWhere(ctx, f, scope) {
  const conds = ['e.workspace_id = $1', 'e.deleted_at IS NULL'];
  const params = [ctx.workspace.id];
  params.push(f.start); conds.push(`e.start_time >= $${params.length}`);
  params.push(f.end); conds.push(`e.start_time <= $${params.length}`);
  if (scope.userIds) { params.push(scope.userIds); conds.push(`e.user_id = ANY($${params.length})`); }
  if (scope.projectIds) { params.push(ctx.user.id, scope.projectIds); conds.push(`(e.user_id = $${params.length - 1} OR e.project_id = ANY($${params.length}))`); }

  containsClause(conds, params, f.users, 'e.user_id');
  const userStatus = String(f.users?.status || 'ALL').toUpperCase();
  if (userStatus !== 'ALL') {
    const statuses = userStatus === 'ACTIVE_WITH_PENDING' ? ['ACTIVE', 'PENDING'] : [userStatus];
    params.push(statuses); conds.push(`EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = e.workspace_id AND wm.user_id = e.user_id AND wm.status = ANY($${params.length}))`);
  }
  containsClause(conds, params, f.userGroups, 'SELECT gm.group_id AS id FROM user_group_members gm JOIN user_groups ug ON ug.id = gm.group_id WHERE gm.user_id = e.user_id AND ug.workspace_id = e.workspace_id', { multi: true });
  containsClause(conds, params, f.projects, 'e.project_id');
  const projectStatus = String(f.projects?.status || 'ALL').toUpperCase();
  if (projectStatus === 'ACTIVE') conds.push('(p.id IS NULL OR p.archived = false)');
  if (projectStatus === 'ARCHIVED') conds.push('p.archived = true');
  containsClause(conds, params, f.clients, 'p.client_id');
  const clientStatus = String(f.clients?.status || 'ALL').toUpperCase();
  if (clientStatus === 'ACTIVE') conds.push('(c.id IS NULL OR c.archived = false)');
  if (clientStatus === 'ARCHIVED') conds.push('c.archived = true');
  containsClause(conds, params, f.tasks, 'e.task_id');
  const taskStatus = String(f.tasks?.status || 'ALL').toUpperCase();
  if (taskStatus === 'ACTIVE') conds.push('(t.id IS NULL OR t.status = \'ACTIVE\')');
  if (taskStatus === 'DONE' || taskStatus === 'ARCHIVED') conds.push('t.status = \'DONE\'');
  containsClause(conds, params, f.tags, 'SELECT tt.tag_id AS id FROM time_entry_tags tt WHERE tt.time_entry_id = e.id', { multi: true });
  const tagStatus = String(f.tags?.status || 'ALL').toUpperCase();
  if (tagStatus === 'ACTIVE') conds.push('NOT EXISTS (SELECT 1 FROM time_entry_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.time_entry_id = e.id AND tg.archived)');
  if (tagStatus === 'ARCHIVED') conds.push('EXISTS (SELECT 1 FROM time_entry_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.time_entry_id = e.id AND tg.archived)');

  if (f.billable === true || f.billable === false) { params.push(f.billable); conds.push(`e.billable = $${params.length}`); }
  if (f.withoutDescription) conds.push("e.description = ''");
  else if (f.description) { params.push(`%${String(f.description).toLowerCase()}%`); conds.push(`lower(e.description) LIKE $${params.length}`); }
  if (f.invoicingState === 'INVOICED') conds.push('e.invoiced = true');
  if (f.invoicingState === 'UNINVOICED') conds.push('e.invoiced = false');
  if (f.approvalState === 'APPROVED') conds.push("e.approval_status = 'APPROVED'");
  if (f.approvalState === 'UNAPPROVED') conds.push("(e.approval_status IS NULL OR e.approval_status <> 'APPROVED')");
  if (f.archived === true) conds.push('p.archived = true');
  if (f.archived === false) conds.push('(p.id IS NULL OR p.archived = false)');
  if (f.customFields?.length) {
    const fields = await rows('SELECT id, type FROM custom_fields WHERE workspace_id = $1', [ctx.workspace.id]);
    for (const cf of f.customFields) customFieldClause(conds, params, cf, fields.find((x) => x.id === cf.id));
  }
  const audit = f.auditFilter;
  if (audit?.withoutProject) conds.push('e.project_id IS NULL');
  if (audit?.withoutTask) conds.push('e.task_id IS NULL');
  if (audit?.duration != null) {
    params.push(Number(audit.duration) * 3600);
    conds.push(`EXTRACT(EPOCH FROM (COALESCE(e.end_time, now()) - e.start_time)) ${audit.durationShorter ? '<=' : '>='} $${params.length}`);
  }
  return { where: conds.join(' AND '), params };
}

export const ENTRY_SELECT = `SELECT e.*, u.name AS user_name, u.email AS user_email, u.profile_picture AS user_image, u.status AS user_status,
    p.name AS project_name, p.color AS project_color, p.archived AS project_archived, p.is_public AS project_public, p.client_id AS client_id,
    c.name AS client_name, t.name AS task_name,
    COALESCE((SELECT json_agg(json_build_object('_id', tg.id, 'name', tg.name) ORDER BY lower(tg.name)) FROM time_entry_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.time_entry_id = e.id), '[]'::json) AS tags,
    COALESCE((SELECT json_agg(json_build_object('customFieldId', v.custom_field_id, 'name', f.name, 'type', f.type, 'value', v.value, 'sourceType', v.source_type) ORDER BY f.created_at) FROM custom_field_values v JOIN custom_fields f ON f.id = v.custom_field_id WHERE v.entity_type = 'TIMEENTRY' AND v.entity_id = e.id), '[]'::json) AS custom_fields`;
export const ENTRY_FROM = `FROM time_entries e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN tasks t ON t.id = e.task_id`;

export const DETAILED_SORT = {
  ID: ['e.id'], DESCRIPTION: ['lower(e.description)', 'e.start_time'], USER: ['lower(u.name)', 'e.start_time'], USER_DATE: ['lower(u.name)', 'e.start_time'],
  DURATION: ['(COALESCE(e.end_time, now()) - e.start_time)', 'e.start_time'], DATE: ['e.start_time', 'e.id'], ZONED_DATE: ['e.start_time', 'e.id'], NATURAL: ['e.start_time', 'e.id'],
};

export function orderBy(columns, order) {
  const dir = order === 'DESCENDING' ? 'DESC' : 'ASC';
  return columns.map((c) => `${c} ${dir}`).join(', ');
}

// Loads the entry rows matching the filter; `sort`/`limit`/`offset` are optional.
export async function loadEntries(ctx, f, scope, { sortColumn = 'DATE', sortOrder = 'ASCENDING', limit, offset } = {}) {
  const { where, params } = await buildEntryWhere(ctx, f, scope);
  let sql = `${ENTRY_SELECT} ${ENTRY_FROM} WHERE ${where} ORDER BY ${orderBy(DETAILED_SORT[sortColumn] || DETAILED_SORT.DATE, sortOrder)}`;
  if (limit != null) { params.push(limit, offset || 0); sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`; }
  const list = await rows(sql, params);
  return list.map((e) => decorate(ctx, f, e));
}

// Slim rows for totals over the whole filtered set (no pagination)
export async function loadEntriesForTotals(ctx, f, scope) {
  const { where, params } = await buildEntryWhere(ctx, f, scope);
  const list = await rows(`SELECT e.id, e.user_id, e.billable, e.type, e.start_time, e.end_time, e.hourly_rate_amount, e.cost_rate_amount, e.hourly_rate_currency ${ENTRY_FROM} WHERE ${where}`, params);
  return list.map((e) => decorate(ctx, f, e));
}

export async function countEntries(ctx, f, scope) {
  const { where, params } = await buildEntryWhere(ctx, f, scope);
  const r = await rows(`SELECT count(*)::int AS c ${ENTRY_FROM} WHERE ${where}`, params);
  return r[0]?.c || 0;
}

// Attaches computed fields: duration (rounded when requested), amounts in currency units, rate visibility.
export function decorate(ctx, f, e) {
  const start = new Date(e.start_time);
  const end = e.end_time ? new Date(e.end_time) : null;
  let seconds = Math.max(0, Math.round(((end || new Date()) - start) / 1000));
  if (f.round) seconds = roundSeconds(seconds, f.round.round, f.round.minutes);
  const regular = (e.type || 'REGULAR') === 'REGULAR';
  const ratesVisible = f.showRates || e.user_id === ctx.user.id;
  const hours = seconds / 3600;
  const earned = regular && e.billable && ratesVisible ? hours * (Number(e.hourly_rate_amount) || 0) / 100 : 0;
  const cost = regular && ratesVisible ? hours * (Number(e.cost_rate_amount) || 0) / 100 : 0;
  e.seconds = seconds;
  e.billableSeconds = regular && e.billable ? seconds : 0;
  e.ratesVisible = ratesVisible;
  e.earned = round2(earned);
  e.cost = round2(cost);
  e.profit = round2(earned - cost);
  e.running = !e.end_time;
  return e;
}

export function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

export function amountOf(e, type) {
  if (type === 'COST') return e.cost;
  if (type === 'PROFIT') return e.profit;
  return e.earned;
}

export function amountsDto(f, agg) {
  return f.amountTypes.map((type) => ({ type, value: round2(agg[type.toLowerCase()] || 0) }));
}

// Aggregates a list of decorated entries into a Clockify "totals" object.
export function aggregate(entries) {
  const agg = { totalTime: 0, totalBillableTime: 0, entriesCount: 0, earned: 0, cost: 0, profit: 0 };
  for (const e of entries) {
    agg.totalTime += e.seconds;
    agg.totalBillableTime += e.billableSeconds;
    agg.entriesCount += 1;
    agg.earned += e.earned;
    agg.cost += e.cost;
    agg.profit += e.profit;
  }
  agg.earned = round2(agg.earned); agg.cost = round2(agg.cost); agg.profit = round2(agg.profit);
  return agg;
}

export function totalsDto(f, entries, id) {
  const agg = aggregate(entries);
  return {
    _id: id || null,
    totalTime: agg.totalTime,
    totalBillableTime: agg.totalBillableTime,
    entriesCount: agg.entriesCount,
    totalAmount: f.primaryAmount ? round2(agg[f.primaryAmount.toLowerCase()]) : 0,
    amounts: amountsDto(f, agg),
  };
}

// user id → [{id, name}] groups (for USERGROUP grouping and export columns)
export async function loadUserGroups(workspaceId) {
  const list = await rows('SELECT gm.user_id, g.id, g.name FROM user_group_members gm JOIN user_groups g ON g.id = gm.group_id WHERE g.workspace_id = $1 ORDER BY lower(g.name)', [workspaceId]);
  const map = new Map();
  for (const r of list) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push({ id: r.id, name: r.name });
  }
  return map;
}

export function localDate(e, f) { return localDateString(new Date(e.start_time), f.timeZone); }
export function localWeek(e, f) { return localDateString(startOfWeek(new Date(e.start_time), f.timeZone, f.weekStart), f.timeZone); }
export function localMonth(e, f) { const p = zonedParts(new Date(e.start_time), f.timeZone); return `${p.year}-${String(p.month).padStart(2, '0')}`; }
export function localYear(e, f) { return String(zonedParts(new Date(e.start_time), f.timeZone).year); }

// All local dates (YYYY-MM-DD) covered by the filter range, capped to `max` days
export function rangeDays(f, max = 400) {
  const out = [];
  let d = new Date(f.start);
  const endStr = localDateString(f.end, f.timeZone);
  while (out.length < max) {
    const s = localDateString(d, f.timeZone);
    out.push(s);
    if (s >= endStr) break;
    const p = parseDateOnly(s);
    d = zonedTime(f.timeZone, p.year, p.month, p.day + 1);
  }
  return out;
}
