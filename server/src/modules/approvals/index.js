// Module "approvals" – timesheet approval requests (Clockify API compatible).
//   GET   /approval-requests?status&sort-column&sort-order&page&page-size        -> [ApprovalDetailsDtoV1]
//   POST  /approval-requests {period?, periodStart}                              -> ApprovalRequestDtoV1 (own timesheet)
//   POST  /approval-requests/users/:userId {period?, periodStart}                -> ApprovalRequestDtoV1 (admin / team manager)
//   POST  /approval-requests/resubmit-entries-for-approval                       -> ApprovalRequestDtoV1
//   POST  /approval-requests/users/:userId/resubmit-entries-for-approval         -> ApprovalRequestDtoV1
//   PATCH /approval-requests/:id {state, note}                                   -> ApprovalRequestDtoV1
// Extra (UI):
//   GET   /approval-requests/:id                                                 -> ApprovalDetailsDtoV1
//   GET   /approval-requests/pending-summary?start&end&users                     -> per visible user: tracked/unsubmitted/pending/approved
//                                                                                   time (ISO), status and the requests overlapping the period.
//   Listing also accepts `users` (owner ids) and `start`/`end` (overlap) filters.
import { Router } from 'express';
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, paging, sort, list } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { toIso, parseDate, zonedParts, zonedTime, startOfWeek, localDateString } from '../../lib/dates.js';
import { secondsToIso } from '../../lib/duration.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';
import { visibleUserIds, userGroupIds } from '../../middleware/workspace.js';
import { entriesDto } from '../timeEntries/service.js';
import { memberCalendar, notifyWithMail, workspaceAdminIds, teamManagerIdsOf, dateStr } from '../holidays/service.js';

export const router = Router({ mergeParams: true });

const PERIODS = ['WEEKLY', 'SEMI_MONTHLY', 'MONTHLY'];
const STATES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN_SUBMISSION', 'WITHDRAWN_APPROVAL'];
const TRANSITIONS = {
  PENDING: ['APPROVED', 'REJECTED', 'WITHDRAWN_SUBMISSION'],
  APPROVED: ['WITHDRAWN_APPROVAL'],
  REJECTED: ['PENDING'],
  WITHDRAWN_SUBMISSION: ['PENDING'],
  WITHDRAWN_APPROVAL: ['PENDING'],
};
const createSchema = z.object({ period: z.enum(PERIODS).optional(), periodStart: z.string().min(1) });
const updateSchema = z.object({ state: z.enum(STATES), note: z.string().max(3000).nullable().optional() });

// [start, end) of the approval period containing `at`, in the owner's time zone
export function periodRange(period, at, { timeZone = 'UTC', weekStart = 'MONDAY' } = {}) {
  const p = zonedParts(at, timeZone);
  switch (period) {
    case 'MONTHLY': return [zonedTime(timeZone, p.year, p.month, 1), zonedTime(timeZone, p.year, p.month + 1, 1)];
    case 'SEMI_MONTHLY':
      return p.day <= 15
        ? [zonedTime(timeZone, p.year, p.month, 1), zonedTime(timeZone, p.year, p.month, 16)]
        : [zonedTime(timeZone, p.year, p.month, 16), zonedTime(timeZone, p.year, p.month + 1, 1)];
    default: {
      const s = startOfWeek(at, timeZone, weekStart);
      const sp = zonedParts(s, timeZone);
      return [s, zonedTime(timeZone, sp.year, sp.month, sp.day + 7)];
    }
  }
}

async function loadRequest(workspaceId, id) {
  const r = await one('SELECT * FROM approval_requests WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!r) throw notFound('Approval request not found', 404);
  return r;
}

// DTOs ---------------------------------------------------------------------------------
export async function requestsDto(listRows) {
  if (!listRows.length) return [];
  const wsId = listRows[0].workspace_id;
  const userIds = [...new Set(listRows.flatMap((r) => [r.owner_user_id, r.creator_user_id, r.updated_by]).filter(Boolean))];
  const users = new Map((await rows('SELECT u.id, u.name, u.email, u.settings, m.week_start FROM users u LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $2 WHERE u.id = ANY($1)', [userIds, wsId])).map((u) => [u.id, u]));
  return listRows.map((r) => {
    const owner = users.get(r.owner_user_id) || {}; const creator = users.get(r.creator_user_id) || {}; const updater = r.updated_by ? users.get(r.updated_by) : null;
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      dateRange: { start: toIso(r.date_start), end: toIso(new Date(new Date(r.date_end).getTime() - 1000)) },
      owner: { userId: r.owner_user_id, userName: owner.name || '', timeZone: owner.settings?.timeZone || 'UTC', startOfWeek: owner.week_start || owner.settings?.weekStart || 'MONDAY' },
      creator: { userId: r.creator_user_id, userName: creator.name || '', userEmail: creator.email || '' },
      status: { state: r.state, note: r.note || '', updatedAt: toIso(r.updated_at), updatedBy: r.updated_by || null, updatedByUserName: updater?.name || null },
      period: r.period,
      createdAt: toIso(r.created_at),
    };
  });
}

async function requestDto(r) {
  const [dto] = await requestsDto([r]);
  return dto;
}

function entryInfo(dto) {
  return {
    id: dto.id,
    description: dto.description,
    userId: dto.userId,
    projectId: dto.projectId,
    taskId: dto.taskId,
    billable: dto.billable,
    type: dto.type,
    timeInterval: dto.timeInterval,
    approvalRequestId: dto.approvalRequestId,
    approvalStatus: dto.approvalStatus,
    isLocked: dto.isLocked,
    hourlyRate: dto.hourlyRate,
    costRate: dto.costRate,
    customFieldValues: dto.customFieldValues,
    project: dto.project ? { id: dto.project.id, name: dto.project.name, color: dto.project.color, clientId: dto.project.clientId || '', clientName: dto.project.clientName || '' } : null,
    task: dto.task ? { id: dto.task.id, name: dto.task.name } : null,
    tags: dto.tags || [],
  };
}

async function expensesOf(requestId, ctx) {
  const listRows = await rows(
    `SELECT e.*, c.name AS category_name, c.unit AS category_unit, c.has_unit_price, c.price_in_cents, c.archived AS category_archived,
            p.name AS project_name, p.color AS project_color, p.client_id, cl.name AS client_name, t.name AS task_name, f.name AS file_name
       FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id LEFT JOIN projects p ON p.id = e.project_id
       LEFT JOIN clients cl ON cl.id = p.client_id LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN files f ON f.id = e.file_id
      WHERE e.approval_request_id = $1 AND e.deleted_at IS NULL ORDER BY e.date, e.created_at`,
    [requestId],
  );
  const currency = ctx.workspace.hourly_rate_currency || 'USD';
  return listRows.map((e) => ({
    id: e.id,
    workspaceId: e.workspace_id,
    userId: e.user_id,
    date: dateStr(e.date),
    notes: e.notes || '',
    quantity: Number(e.quantity),
    total: Number(e.total),
    billable: !!e.billable,
    currency,
    category: e.category_id ? { id: e.category_id, name: e.category_name, unit: e.category_unit || null, hasUnitPrice: !!e.has_unit_price, priceInCents: e.price_in_cents || 0, archived: !!e.category_archived, workspaceId: e.workspace_id } : null,
    project: e.project_id ? { id: e.project_id, name: e.project_name, color: e.project_color, clientId: e.client_id || '', clientName: e.client_name || '' } : null,
    task: e.task_id ? { id: e.task_id, name: e.task_name } : null,
    fileId: e.file_id || null,
    fileName: e.file_name || null,
    fileUrl: e.file_id ? `${config.appUrl}/api/v1/files/${e.file_id}` : null,
    locked: !!e.locked || e.approval_status === 'APPROVED' || e.approval_status === 'PENDING',
    isLocked: !!e.locked || e.approval_status === 'APPROVED' || e.approval_status === 'PENDING',
    approvalRequestId: e.approval_request_id || null,
    approvalStatus: e.approval_status || 'UNSUBMITTED',
    detailedApprovalStatus: e.approval_status || 'UNSUBMITTED',
  }));
}

const seconds = (e) => (e.end_time ? Math.round((new Date(e.end_time) - new Date(e.start_time)) / 1000) : 0);

export async function detailsDto(ctx, r) {
  const entries = await rows('SELECT * FROM time_entries WHERE approval_request_id = $1 AND deleted_at IS NULL ORDER BY start_time', [r.id]);
  const dtos = await entriesDto(entries, { hydrated: true, ctx });
  const expenses = await expensesOf(r.id, ctx);
  let tracked = 0; let billable = 0; let brk = 0; let approved = 0; let pending = 0; let billableAmount = 0; let costAmount = 0;
  for (const e of entries) {
    const s = seconds(e);
    tracked += s;
    if (e.type === 'BREAK') brk += s;
    if (e.billable) { billable += s; billableAmount += (s / 3600) * (e.hourly_rate_amount || 0); }
    costAmount += (s / 3600) * (e.cost_rate_amount || 0);
    if (e.approval_status === 'APPROVED') approved += s;
    if (e.approval_status === 'PENDING') pending += s;
  }
  return {
    approvalRequest: await requestDto(r),
    entries: dtos.map(entryInfo),
    expenses,
    trackedTime: secondsToIso(tracked),
    billableTime: secondsToIso(billable),
    breakTime: secondsToIso(brk),
    approvedTime: secondsToIso(approved),
    pendingTime: secondsToIso(pending),
    billableAmount: Math.round(billableAmount * 100) / 100,
    costAmount: Math.round(costAmount * 100) / 100,
    expenseTotal: Math.round(expenses.reduce((acc, e) => acc + e.total, 0) * 100) / 100,
  };
}

// Permissions ---------------------------------------------------------------------------
async function isApproverOf(ctx, ownerId) {
  if (ctx.isAdmin) return true;
  if (!ctx.managedTargets.size) return false;
  if (ctx.managedTargets.has(ownerId)) return true;
  const groups = await userGroupIds(ctx.workspace.id, ownerId);
  return groups.some((g) => ctx.managedTargets.has(g));
}

async function assertCanSee(ctx, r) {
  if (r.owner_user_id === ctx.user.id || (await isApproverOf(ctx, r.owner_user_id))) return;
  const visible = await visibleUserIds(ctx);
  if (visible && !visible.includes(r.owner_user_id)) throw notFound('Approval request not found', 404);
}

async function approverIds(workspaceId, ownerId) {
  return [...new Set([...(await workspaceAdminIds(workspaceId)), ...(await teamManagerIdsOf(workspaceId, ownerId))])];
}

// Attaches unsubmitted/rejected/withdrawn entries and expenses of the owner in the period to the request
async function attachItems(r) {
  const cal = await memberCalendar(r.workspace_id, r.owner_user_id);
  const startDay = localDateString(new Date(r.date_start), cal.timeZone);
  const endDay = localDateString(new Date(r.date_end), cal.timeZone);
  const entries = await rows(
    `UPDATE time_entries SET approval_request_id = $3, approval_status = 'PENDING', locked = false
      WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL AND end_time IS NOT NULL AND start_time >= $4 AND start_time < $5
        AND COALESCE(approval_status, '') NOT IN ('PENDING', 'APPROVED') RETURNING id`,
    [r.workspace_id, r.owner_user_id, r.id, r.date_start, r.date_end],
  );
  const expenses = await rows(
    `UPDATE expenses SET approval_request_id = $3, approval_status = 'PENDING', locked = false
      WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL AND date >= $4::date AND date < $5::date
        AND COALESCE(approval_status, '') NOT IN ('PENDING', 'APPROVED') RETURNING id`,
    [r.workspace_id, r.owner_user_id, r.id, startDay, endDay],
  );
  return { entries: entries.length, expenses: expenses.length };
}

function fmtRange(r) {
  return `${toIso(r.date_start).slice(0, 10)} – ${toIso(new Date(new Date(r.date_end).getTime() - 1000)).slice(0, 10)}`;
}

async function notifyApprovers(ctx, r, { type, title, body }) {
  const ids = await approverIds(ctx.workspace.id, r.owner_user_id);
  await notifyWithMail(ids, { workspaceId: ctx.workspace.id, type, title, body, payload: { approvalRequestId: r.id, userId: r.owner_user_id, state: r.state }, settingKey: 'approval', exclude: [ctx.user.id] });
}

async function notifyOwner(ctx, r, { type, title, body }) {
  await notifyWithMail([r.owner_user_id], { workspaceId: ctx.workspace.id, type, title, body, payload: { approvalRequestId: r.id, userId: r.owner_user_id, state: r.state }, settingKey: 'approval', exclude: [ctx.user.id] });
}

// Submission ----------------------------------------------------------------------------
// Creates (or re-opens) the approval request of `userId` for the period containing `periodStart` and attaches the
// entries/expenses that are not pending/approved yet. With `resubmit`, items are attached to an existing request.
export async function submit(ctx, userId, body, { resubmit = false } = {}) {
  const ws = ctx.workspace;
  if (userId !== ctx.user.id && !(await isApproverOf(ctx, userId))) throw forbidden("You can't submit approval requests for this user", 403);
  const cal = await memberCalendar(ws.id, userId);
  if (cal.status !== 'ACTIVE') throw badRequest('User is not active in this workspace', 400);
  const period = body.period || ctx.settings.approvalPeriod || 'WEEKLY';
  if (!PERIODS.includes(period)) throw badRequest('Invalid period', 400);
  const [start, end] = periodRange(period, parseDate(body.periodStart, 'periodStart'), cal);

  const { request, reopened, created } = await transaction(async () => {
    const existing = await one(
      'SELECT * FROM approval_requests WHERE workspace_id = $1 AND owner_user_id = $2 AND date_start = $3 AND date_end = $4 ORDER BY created_at DESC LIMIT 1',
      [ws.id, userId, start, end],
    );
    const running = await one('SELECT 1 FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL AND end_time IS NULL AND start_time >= $3 AND start_time < $4', [ws.id, userId, start, end]);
    if (running) throw badRequest('Stop the running timer before submitting this period for approval', 400);
    let r = existing; let isNew = false;
    if (existing && ['PENDING', 'APPROVED'].includes(existing.state) && !resubmit) throw badRequest('An approval request for this period already exists', 400);
    if (!existing) {
      r = await insert('approval_requests', { id: newId(), workspace_id: ws.id, owner_user_id: userId, creator_user_id: ctx.user.id, period, date_start: start, date_end: end, state: 'PENDING', updated_by: ctx.user.id });
      isNew = true;
    }
    const attached = await attachItems(r);
    if (!attached.entries && !attached.expenses) throw badRequest('There are no time entries or expenses to submit for this period', 400);
    const wasClosed = r.state !== 'PENDING';
    if (!isNew) {
      r = await one('UPDATE approval_requests SET state = $2, note = CASE WHEN $3::boolean THEN NULL ELSE note END, updated_by = $4, updated_at = now() WHERE id = $1 RETURNING *', [r.id, 'PENDING', wasClosed, ctx.user.id]);
    }
    return { request: r, reopened: wasClosed && !isNew, created: isNew };
  });

  await audit({ workspaceId: ws.id, userId: ctx.user.id, action: created ? 'CREATE_APPROVAL_REQUEST' : 'UPDATE_APPROVAL_REQUEST', entityType: 'APPROVAL_REQUEST', entityId: request.id, content: { ...body, period, userId, resubmit } });
  events.emitAsync(created ? 'approval.created' : 'approval.status_updated', { workspaceId: ws.id, actorId: ctx.user.id, approvalRequestId: request.id, userId, state: 'PENDING', ...(created ? {} : { previousState: reopened ? 'REOPENED' : 'PENDING' }) });
  await notifyApprovers(ctx, request, {
    type: 'APPROVAL_SUBMITTED', title: `${cal.name} submitted a timesheet for approval`,
    body: `Timesheet ${fmtRange(request)} ${created ? 'was submitted' : 'was resubmitted'} for approval.`,
  });
  return request;
}

// State changes ---------------------------------------------------------------------------
export async function changeState(ctx, r, state, note) {
  const ws = ctx.workspace;
  const approver = await isApproverOf(ctx, r.owner_user_id);
  const owner = r.owner_user_id === ctx.user.id;
  if (!approver && !owner) throw forbidden("You can't update this approval request", 403);
  if (!TRANSITIONS[r.state].includes(state)) throw badRequest(`Cannot change approval request state from ${r.state} to ${state}`, 400);
  if (['APPROVED', 'REJECTED', 'WITHDRAWN_APPROVAL'].includes(state) && !approver) throw forbidden('Only admins or team managers can approve, reject or withdraw approval', 403);

  const updated = await transaction(async () => {
    if (state === 'PENDING') {
      await attachItems(r);
      await query("UPDATE time_entries SET approval_status = 'PENDING', locked = false WHERE approval_request_id = $1", [r.id]);
      await query("UPDATE expenses SET approval_status = 'PENDING', locked = false WHERE approval_request_id = $1", [r.id]);
    } else {
      const withdrawn = state.startsWith('WITHDRAWN');
      await query('UPDATE time_entries SET approval_status = $2, locked = $3, approval_request_id = CASE WHEN $4::boolean THEN NULL ELSE approval_request_id END WHERE approval_request_id = $1', [r.id, state, state === 'APPROVED', withdrawn]);
      await query('UPDATE expenses SET approval_status = $2, locked = $3, approval_request_id = CASE WHEN $4::boolean THEN NULL ELSE approval_request_id END WHERE approval_request_id = $1', [r.id, state, state === 'APPROVED', withdrawn]);
    }
    return one('UPDATE approval_requests SET state = $2, note = $3, updated_by = $4, updated_at = now() WHERE id = $1 RETURNING *', [r.id, state, note ?? null, ctx.user.id]);
  });

  await audit({ workspaceId: ws.id, userId: ctx.user.id, action: 'UPDATE_APPROVAL_REQUEST', entityType: 'APPROVAL_REQUEST', entityId: r.id, content: { state, note }, previous: { state: r.state, note: r.note } });
  events.emitAsync('approval.status_updated', { workspaceId: ws.id, actorId: ctx.user.id, approvalRequestId: r.id, userId: r.owner_user_id, state, previousState: r.state });
  const range = fmtRange(updated);
  const ownerName = (await one('SELECT name FROM users WHERE id = $1', [r.owner_user_id]))?.name || '';
  if (state === 'APPROVED') await notifyOwner(ctx, updated, { type: 'APPROVAL_APPROVED', title: 'Your timesheet was approved', body: `Timesheet ${range} was approved by ${ctx.user.name}.${note ? ` Note: ${note}` : ''}` });
  else if (state === 'REJECTED') await notifyOwner(ctx, updated, { type: 'APPROVAL_REJECTED', title: 'Your timesheet was rejected', body: `Timesheet ${range} was rejected by ${ctx.user.name}.${note ? ` Note: ${note}` : ''}` });
  else if (state === 'WITHDRAWN_APPROVAL') await notifyOwner(ctx, updated, { type: 'APPROVAL_WITHDRAWN', title: 'Approval of your timesheet was withdrawn', body: `Approval of timesheet ${range} was withdrawn by ${ctx.user.name}.` });
  else if (state === 'WITHDRAWN_SUBMISSION') await notifyApprovers(ctx, updated, { type: 'APPROVAL_WITHDRAWN', title: `${ownerName} withdrew a timesheet submission`, body: `Submission of timesheet ${range} was withdrawn.` });
  else await notifyApprovers(ctx, updated, { type: 'APPROVAL_SUBMITTED', title: `${ownerName} resubmitted a timesheet for approval`, body: `Timesheet ${range} was resubmitted for approval.` });
  return updated;
}

// Routes -------------------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 1000 });
  const s = sort(req.query, ['START', 'ID', 'USER_ID', 'UPDATED_AT'], 'START');
  const conds = ['r.workspace_id = $1']; const params = [req.workspace.id];
  const states = list(req.query.status).map((x) => x.toUpperCase()).filter((x) => STATES.includes(x));
  if (states.length) { params.push(states); conds.push(`r.state = ANY($${params.length})`); }
  const users = list(req.query.users || req.query.user);
  if (users.length) { params.push(users); conds.push(`r.owner_user_id = ANY($${params.length})`); }
  const visible = await visibleUserIds(req.ctx);
  if (visible) { params.push(visible); conds.push(`r.owner_user_id = ANY($${params.length})`); }
  if (req.query.start) { params.push(parseDate(req.query.start, 'start')); conds.push(`r.date_end > $${params.length}`); }
  if (req.query.end) { params.push(parseDate(req.query.end, 'end')); conds.push(`r.date_start < $${params.length}`); }
  const orderMap = { ID: 'r.id', USER_ID: 'r.owner_user_id', START: 'r.date_start', UPDATED_AT: 'r.updated_at' };
  params.push(limit, offset);
  const l = await rows(`SELECT r.* FROM approval_requests r WHERE ${conds.join(' AND ')} ORDER BY ${orderMap[s.column]} ${s.order}, r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const out = [];
  for (const r of l) out.push(await detailsDto(req.ctx, r));
  res.json(out);
});

router.get('/pending-summary', async (req, res) => {
  const ws = req.workspace.id;
  if (!req.query.start || !req.query.end) throw badRequest('start and end are required', 400);
  const start = parseDate(req.query.start, 'start'); const end = parseDate(req.query.end, 'end');
  const visible = await visibleUserIds(req.ctx);
  const requested = list(req.query.users);
  const params = [ws]; const conds = ["m.workspace_id = $1", "m.status = 'ACTIVE'"];
  if (visible) { params.push(visible); conds.push(`m.user_id = ANY($${params.length})`); }
  if (requested.length) { params.push(requested); conds.push(`m.user_id = ANY($${params.length})`); }
  const members = await rows(`SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE ${conds.join(' AND ')} ORDER BY lower(u.name)`, params);
  const ids = members.map((m) => m.id);
  const agg = ids.length ? await rows(
    `SELECT user_id, approval_status, SUM(EXTRACT(EPOCH FROM (end_time - start_time)))::bigint AS secs FROM time_entries
      WHERE workspace_id = $1 AND user_id = ANY($2) AND deleted_at IS NULL AND end_time IS NOT NULL AND start_time >= $3 AND start_time < $4 GROUP BY user_id, approval_status`,
    [ws, ids, start, end],
  ) : [];
  const reqs = ids.length ? await requestsDto(await rows('SELECT * FROM approval_requests WHERE workspace_id = $1 AND owner_user_id = ANY($2) AND date_start < $4 AND date_end > $3 ORDER BY date_start', [ws, ids, start, end])) : [];
  res.json(members.map((m) => {
    const mine = agg.filter((a) => a.user_id === m.id);
    const sum = (pred) => mine.filter(pred).reduce((acc, a) => acc + Number(a.secs), 0);
    const tracked = sum(() => true);
    const pending = sum((a) => a.approval_status === 'PENDING');
    const approved = sum((a) => a.approval_status === 'APPROVED');
    const unsubmitted = tracked - pending - approved;
    const requests = reqs.filter((r) => r.owner.userId === m.id);
    const status = requests.some((r) => r.status.state === 'PENDING') ? 'PENDING' : unsubmitted > 0 ? 'UNSUBMITTED' : requests.some((r) => r.status.state === 'REJECTED') ? 'REJECTED' : approved > 0 ? 'APPROVED' : 'NONE';
    return {
      userId: m.id, userName: m.name, userEmail: m.email,
      trackedTime: secondsToIso(tracked), unsubmittedTime: secondsToIso(unsubmitted), pendingTime: secondsToIso(pending), approvedTime: secondsToIso(approved),
      status, requests: requests.map((r) => ({ id: r.id, state: r.status.state, dateRange: r.dateRange, period: r.period })),
    };
  }));
});

router.post('/', async (req, res) => {
  const b = parse(createSchema, req.body);
  res.status(201).json(await requestDto(await submit(req.ctx, req.user.id, b)));
});

router.post('/resubmit-entries-for-approval', async (req, res) => {
  const b = parse(createSchema, req.body);
  res.json(await requestDto(await submit(req.ctx, req.user.id, b, { resubmit: true })));
});

router.post('/users/:userId', async (req, res) => {
  const b = parse(createSchema, req.body);
  res.status(201).json(await requestDto(await submit(req.ctx, req.params.userId, b)));
});

router.post('/users/:userId/resubmit-entries-for-approval', async (req, res) => {
  const b = parse(createSchema, req.body);
  res.json(await requestDto(await submit(req.ctx, req.params.userId, b, { resubmit: true })));
});

router.get('/:id', async (req, res) => {
  const r = await loadRequest(req.workspace.id, req.params.id);
  await assertCanSee(req.ctx, r);
  res.json(await detailsDto(req.ctx, r));
});

router.patch('/:id', async (req, res) => {
  const { state, note } = parse(updateSchema, req.body);
  const r = await loadRequest(req.workspace.id, req.params.id);
  res.json(await requestDto(await changeState(req.ctx, r, state, note)));
});

export default {
  name: 'approvals',
  workspace(ws) { ws.use('/approval-requests', router); },
};
