// Summary, detailed and weekly time entry reports (Clockify Reports API v1).
import { rows } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { parse, z } from '../../lib/validate.js';
import { toIso } from '../../lib/dates.js';
import { newId } from '../../lib/ids.js';
import {
  parseCommonFilter, visibilityScope, loadEntries, loadEntriesForTotals, countEntries, loadUserGroups, DETAILED_SORT,
  aggregate, amountsDto, totalsDto, amountOf, round2, localDate, localWeek, localMonth, localYear, rangeDays,
} from './filters.js';

export const GROUP_TYPES = ['PROJECT', 'CLIENT', 'USER', 'TASK', 'TAG', 'DATE', 'WEEK', 'MONTH', 'YEAR', 'USERGROUP', 'USER_GROUP', 'TIMEENTRY', 'BILLABILITY'];

const summarySchema = z.object({
  summaryFilter: z.object({
    groups: z.array(z.string()).min(1).max(3),
    sortColumn: z.enum(['GROUP', 'DURATION', 'AMOUNT', 'EARNED', 'COST', 'PROFIT']).optional(),
    summaryChartType: z.enum(['BILLABILITY', 'PROJECT']).optional(),
  }).passthrough(),
}).passthrough();

const detailedSchema = z.object({
  detailedFilter: z.object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(5000).optional(),
    sortColumn: z.enum(Object.keys(DETAILED_SORT)).optional(),
    options: z.object({ totals: z.enum(['CALCULATE', 'EXCLUDE']).optional() }).passthrough().optional(),
    auditFilter: z.object({ duration: z.number().optional(), durationShorter: z.boolean().optional(), withoutProject: z.boolean().optional(), withoutTask: z.boolean().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const weeklySchema = z.object({
  weeklyFilter: z.object({
    group: z.enum(['PROJECT', 'USER']).optional(),
    subgroup: z.enum(['TIME', 'EARNINGS']).optional(),
    includeUsersWithoutTime: z.boolean().optional(),
  }).passthrough().optional(),
  includeUsersWithoutTime: z.boolean().optional(),
}).passthrough();

// ---- grouping ------------------------------------------------------------------
// Returns the buckets an entry belongs to for a group type: [{key, name, extra}]
function bucketsFor(e, type, f, ctx) {
  switch (type) {
    case 'PROJECT': return [{ key: e.project_id || '', name: e.project_name || 'Without project', extra: { color: e.project_color || null, clientName: e.client_name || '', clientId: e.client_id || null } }];
    case 'CLIENT': return [{ key: e.client_id || '', name: e.client_name || 'Without client' }];
    case 'USER': return [{ key: e.user_id, name: e.user_name || '', extra: { userEmail: e.user_email } }];
    case 'TASK': return [{ key: e.task_id || '', name: e.task_name || 'Without task', extra: { projectId: e.project_id || null } }];
    case 'TAG': return e.tags?.length ? e.tags.map((t) => ({ key: t._id, name: t.name })) : [{ key: '', name: 'Without tag' }];
    case 'DATE': { const d = localDate(e, f); return [{ key: d, name: d }]; }
    case 'WEEK': { const d = localWeek(e, f); return [{ key: d, name: d }]; }
    case 'MONTH': { const d = localMonth(e, f); return [{ key: d, name: d }]; }
    case 'YEAR': { const d = localYear(e, f); return [{ key: d, name: d }]; }
    case 'USERGROUP': case 'USER_GROUP': {
      const groups = ctx.userGroups.get(e.user_id) || [];
      return groups.length ? groups.map((g) => ({ key: g.id, name: g.name })) : [{ key: '', name: 'Without group' }];
    }
    case 'TIMEENTRY': return [{ key: e.id, name: e.description || 'Without description', extra: {
      timeInterval: { start: toIso(e.start_time), end: toIso(e.end_time), duration: e.seconds }, userId: e.user_id, userName: e.user_name, projectId: e.project_id || null, projectName: e.project_name || '', taskId: e.task_id || null, billable: !!e.billable, type: e.type || 'REGULAR', tags: e.tags || [],
    } }];
    case 'BILLABILITY': return e.billable && (e.type || 'REGULAR') === 'REGULAR' ? [{ key: 'BILLABLE', name: 'Billable' }] : [{ key: 'NON_BILLABLE', name: 'Non-billable' }];
    default: {
      // custom field id: group by its value(s)
      const cf = (e.custom_fields || []).find((c) => c.customFieldId === type);
      const v = cf?.value;
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return [{ key: '', name: 'Without value' }];
      const values = Array.isArray(v) ? v : [v];
      return values.map((x) => ({ key: String(x), name: String(x) }));
    }
  }
}

function sortGroups(groups, f, sortColumn) {
  const dir = f.sortOrder === 'DESCENDING' ? -1 : 1;
  const col = sortColumn || 'GROUP';
  groups.sort((a, b) => {
    let r = 0;
    if (col === 'DURATION') r = a.duration - b.duration;
    else if (col === 'AMOUNT') r = a.amount - b.amount;
    else if (['EARNED', 'COST', 'PROFIT'].includes(col)) r = (a.amounts.find((x) => x.type === col)?.value || 0) - (b.amounts.find((x) => x.type === col)?.value || 0);
    else r = a.nameLowerCase.localeCompare(b.nameLowerCase);
    return r * dir;
  });
  return groups;
}

function groupEntries(entries, types, level, f, ctx, sortColumn) {
  const type = types[level];
  if (!type) return undefined;
  const map = new Map();
  for (const e of entries) {
    for (const b of bucketsFor(e, type, f, ctx)) {
      if (!map.has(b.key)) map.set(b.key, { key: b.key, name: b.name, extra: b.extra, entries: [] });
      map.get(b.key).entries.push(e);
    }
  }
  const out = [];
  for (const g of map.values()) {
    const agg = aggregate(g.entries);
    const dto = {
      _id: g.key || null,
      name: g.name,
      nameLowerCase: String(g.name).toLowerCase(),
      duration: agg.totalTime,
      amount: f.primaryAmount ? round2(agg[f.primaryAmount.toLowerCase()]) : 0,
      amounts: amountsDto(f, agg),
      ...(g.extra || {}),
    };
    const children = groupEntries(g.entries, types, level + 1, f, ctx, sortColumn);
    if (children) dto.children = children;
    out.push(dto);
  }
  return sortGroups(out, f, sortColumn);
}

function chartFor(entries, f, chartType) {
  const byDay = new Map();
  const perMonth = f.zoomLevel === 'YEAR';
  for (const e of entries) {
    const key = perMonth ? localMonth(e, f) : localDate(e, f);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }
  const keys = perMonth ? [...byDay.keys()].sort() : rangeDays(f);
  return keys.map((date) => {
    const list = byDay.get(date) || [];
    const agg = aggregate(list);
    const item = { id: date, date, totalTime: agg.totalTime, totalBillableTime: agg.totalBillableTime, totalAmount: f.primaryAmount ? round2(agg[f.primaryAmount.toLowerCase()]) : 0, earned: agg.earned };
    const groups = groupEntries(list, [chartType === 'BILLABILITY' ? 'BILLABILITY' : 'PROJECT'], 0, f, { userGroups: new Map() }, 'DURATION');
    item.groups = (groups || []).map((g) => ({ _id: g._id, name: g.name, color: g.color, duration: g.duration, amount: g.amount }));
    return item;
  });
}

function validateGroups(groups) {
  for (const g of groups) {
    if (!GROUP_TYPES.includes(g) && !/^[a-f0-9]{24}$/i.test(g)) throw badRequest(`Invalid summary group: ${g}`, 400);
  }
}

// ---- Summary ------------------------------------------------------------------
export async function summaryReport(ctx, body, { now } = {}) {
  const b = parse(summarySchema, body || {});
  const groups = b.summaryFilter.groups.map((g) => (GROUP_TYPES.includes(String(g).toUpperCase()) ? String(g).toUpperCase() : g));
  validateGroups(groups);
  const f = parseCommonFilter(ctx, body, { now });
  const scope = await visibilityScope(ctx);
  const entries = await loadEntries(ctx, f, scope, { sortColumn: 'DATE', sortOrder: 'ASCENDING' });
  const gctx = { userGroups: groups.some((g) => g === 'USERGROUP' || g === 'USER_GROUP') ? await loadUserGroups(ctx.workspace.id) : new Map() };
  const groupOne = groupEntries(entries, groups, 0, f, gctx, b.summaryFilter.sortColumn) || [];
  const out = { totals: [totalsDto(f, entries, newId())], groupOne };
  if (b.summaryFilter.summaryChartType) out.chart = chartFor(entries, f, b.summaryFilter.summaryChartType);
  return { result: out, filter: f, entries, groups };
}

// ---- Detailed -----------------------------------------------------------------
export function entryReportDto(e, f, ctx) {
  const amounts = e.ratesVisible ? f.amountTypes.map((type) => ({ type, value: amountOf(e, type) })) : [];
  return {
    _id: e.id,
    description: e.description || '',
    userId: e.user_id,
    userName: e.user_name || '',
    userEmail: e.user_email || '',
    projectId: e.project_id || null,
    projectName: e.project_name || '',
    projectColor: e.project_color || null,
    clientId: e.client_id || null,
    clientName: e.client_name || '',
    taskId: e.task_id || null,
    taskName: e.task_name || '',
    tags: (e.tags || []).map((t) => ({ _id: t._id, name: t.name })),
    billable: !!e.billable,
    timeInterval: { start: toIso(e.start_time), end: toIso(e.end_time), duration: e.seconds },
    hourlyRate: e.ratesVisible ? Number(e.hourly_rate_amount) || 0 : null,
    costRate: e.ratesVisible ? Number(e.cost_rate_amount) || 0 : null,
    currency: e.hourly_rate_currency || ctx.workspace.hourly_rate_currency || 'USD',
    earnedAmount: e.ratesVisible ? e.earned : null,
    costAmount: e.ratesVisible ? e.cost : null,
    profitAmount: e.ratesVisible ? e.profit : null,
    amounts,
    customFields: (e.custom_fields || []).map((c) => ({ customFieldId: c.customFieldId, name: c.name, type: c.type, value: c.value, sourceType: c.sourceType || 'TIMEENTRY' })),
    approvalRequestId: e.approval_request_id || null,
    approvalStatus: e.approval_status || null,
    isLocked: !!e.locked,
    locked: !!e.locked,
    type: e.type || 'REGULAR',
    invoicingInfo: e.invoiced || e.invoice_id ? { invoiceId: e.invoice_id || null, manuallyInvoiced: !!e.invoiced && !e.invoice_id } : null,
    kioskId: e.kiosk_id || null,
    userGroups: ctx.userGroups ? (ctx.userGroups.get(e.user_id) || []).map((g) => g.name) : undefined,
  };
}

export async function detailedReport(ctx, body, { now, forExport = false } = {}) {
  const b = parse(detailedSchema, body || {});
  const df = b.detailedFilter || {};
  const f = parseCommonFilter(ctx, body, { now });
  if (!f.sortOrder) f.sortOrder = 'DESCENDING';
  const scope = await visibilityScope(ctx);
  const page = df.page || 1;
  const pageSize = forExport ? null : Math.min(df.pageSize || 50, 5000);
  f.auditFilter = df.auditFilter || null;
  const opts = { sortColumn: df.sortColumn || 'DATE', sortOrder: f.sortOrder };
  if (pageSize) Object.assign(opts, { limit: pageSize, offset: (page - 1) * pageSize });
  const entries = await loadEntries(ctx, f, scope, opts);
  const userGroups = await loadUserGroups(ctx.workspace.id);
  const dctx = { ...ctx, userGroups };
  const timeEntries = entries.map((e) => entryReportDto(e, f, dctx));
  // `timeentries` (lowercase) is what the live Clockify API returns; `timeEntries` follows the published schema.
  const out = { timeEntries, timeentries: timeEntries };
  if (df.options?.totals !== 'EXCLUDE') {
    const all = pageSize ? await loadEntriesForTotals(ctx, f, scope) : entries;
    out.totals = [totalsDto(f, all, newId())];
  }
  out.page = page;
  out.pageSize = pageSize || timeEntries.length;
  out.count = out.totals ? out.totals[0].entriesCount : await countEntries(ctx, f, scope);
  return { result: out, filter: f, entries, userGroups };
}

// ---- Weekly -------------------------------------------------------------------
export async function weeklyReport(ctx, body, { now } = {}) {
  const b = parse(weeklySchema, body || {});
  const wf = b.weeklyFilter || {};
  const group = wf.group || 'PROJECT';
  const subgroup = wf.subgroup || 'TIME';
  const f = parseCommonFilter(ctx, body, { now });
  const scope = await visibilityScope(ctx);
  const entries = await loadEntries(ctx, f, scope, { sortColumn: 'DATE', sortOrder: 'ASCENDING' });
  const days = rangeDays(f, 62);
  const gctx = { userGroups: new Map() };
  const dayTotals = (list) => {
    const byDay = new Map();
    for (const e of list) { const d = localDate(e, f); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(e); }
    return days.map((date) => { const agg = aggregate(byDay.get(date) || []); return { date, duration: agg.totalTime, amount: f.primaryAmount ? round2(agg[f.primaryAmount.toLowerCase()]) : 0 }; });
  };
  const types = group === 'USER' ? ['USER', 'PROJECT'] : ['PROJECT', 'USER'];
  const groupOne = (groupEntries(entries, types, 0, f, gctx, 'GROUP') || []).map((g) => {
    const own = entries.filter((e) => (types[0] === 'USER' ? e.user_id === g._id : (e.project_id || null) === g._id));
    return {
      ...g,
      days: dayTotals(own),
      children: (g.children || []).map((c) => ({ ...c, days: dayTotals(own.filter((e) => (types[1] === 'USER' ? e.user_id === c._id : (e.project_id || null) === c._id))) })),
    };
  });
  const includeUsersWithoutTime = !!(wf.includeUsersWithoutTime ?? b.includeUsersWithoutTime);
  const out = {
    totals: [totalsDto(f, entries, newId())],
    totalsByDay: dayTotals(entries),
    groupOne,
    group, subgroup,
    decimalFormat: false,
    trackTimeDownToSeconds: ctx.settings.trackTimeDownToSecond !== false,
    includeUsersWithoutTime,
  };
  if (includeUsersWithoutTime) {
    const withTime = new Set(entries.map((e) => e.user_id));
    const params = [ctx.workspace.id];
    let cond = '';
    if (scope.userIds) { params.push(scope.userIds); cond = ' AND u.id = ANY($2)'; }
    const users = await rows(`SELECT u.id, u.name, u.email, u.settings FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.status = 'ACTIVE'${cond} ORDER BY lower(u.name)`, params);
    out.usersWithoutTime = users.filter((u) => !withTime.has(u.id)).map((u) => ({
      id: u.id, name: u.name, email: u.email, timeZone: u.settings?.timeZone || 'UTC', weekStart: u.settings?.weekStart || 'MONDAY', dateFormat: u.settings?.dateFormat || 'DD/MM/YYYY', timeFormat: u.settings?.timeFormat || 'HOUR24',
    }));
  }
  return { result: out, filter: f, entries, days, group, subgroup };
}
