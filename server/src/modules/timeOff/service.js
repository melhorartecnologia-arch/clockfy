// Time off: policies, balances, requests and the automatic accrual job.
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { toIso, zonedTime, parseDateOnly, addDaysLocal, localDateString, eachDay } from '../../lib/dates.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { userGroupIds } from '../../middleware/workspace.js';
import {
  memberCalendar, memberCalendars, holidayDatesForUser, workingDates, workDayInterval, createAutoEntry, notifyWithMail,
  workspaceAdminIds, teamManagerIdsOf, toDateOnly,
} from '../holidays/service.js';

export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'];

// Policies ------------------------------------------------------------------------------
export async function loadPolicy(workspaceId, id) {
  const p = await one('SELECT * FROM time_off_policies WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!p) throw notFound('Time off policy not found', 404);
  return p;
}

export function approveOf(p) {
  const a = p.approve || {};
  return { requiresApproval: !!a.requiresApproval, teamManagers: !!a.teamManagers, specificMembers: !!a.specificMembers, userIds: Array.isArray(a.userIds) ? a.userIds : [] };
}

export async function policyUserIds(p) {
  if (p.everyone_including_new) return (await rows("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND status = 'ACTIVE'", [p.workspace_id])).map((r) => r.user_id);
  const r = await rows(
    `SELECT DISTINCT m.user_id FROM workspace_members m WHERE m.workspace_id = $1 AND m.status = 'ACTIVE'
       AND (EXISTS (SELECT 1 FROM time_off_policy_users pu WHERE pu.policy_id = $2 AND pu.user_id = m.user_id)
         OR EXISTS (SELECT 1 FROM time_off_policy_groups pg JOIN user_group_members gm ON gm.group_id = pg.group_id WHERE pg.policy_id = $2 AND gm.user_id = m.user_id))`,
    [p.workspace_id, p.id],
  );
  return r.map((x) => x.user_id);
}

export async function isPolicyUser(p, userId) {
  if (p.everyone_including_new) return !!(await one("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE'", [p.workspace_id, userId]));
  return !!(await one(
    `SELECT 1 FROM workspace_members m WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE'
       AND (EXISTS (SELECT 1 FROM time_off_policy_users pu WHERE pu.policy_id = $3 AND pu.user_id = m.user_id)
         OR EXISTS (SELECT 1 FROM time_off_policy_groups pg JOIN user_group_members gm ON gm.group_id = pg.group_id WHERE pg.policy_id = $3 AND gm.user_id = m.user_id))`,
    [p.workspace_id, userId, p.id],
  ));
}

// Policies the user is eligible for
export async function policiesOfUser(workspaceId, userId, { includeArchived = true } = {}) {
  return rows(
    `SELECT p.* FROM time_off_policies p WHERE p.workspace_id = $1 ${includeArchived ? '' : 'AND p.archived = false'}
       AND (p.everyone_including_new OR EXISTS (SELECT 1 FROM time_off_policy_users pu WHERE pu.policy_id = p.id AND pu.user_id = $2)
         OR EXISTS (SELECT 1 FROM time_off_policy_groups pg JOIN user_group_members gm ON gm.group_id = pg.group_id WHERE pg.policy_id = p.id AND gm.user_id = $2))
     ORDER BY lower(p.name)`,
    [workspaceId, userId],
  );
}

export async function policiesDto(listRows) {
  if (!listRows.length) return [];
  const ids = listRows.map((p) => p.id);
  const users = await rows('SELECT policy_id, user_id FROM time_off_policy_users WHERE policy_id = ANY($1)', [ids]);
  const groups = await rows('SELECT policy_id, group_id FROM time_off_policy_groups WHERE policy_id = ANY($1)', [ids]);
  const needEveryone = listRows.some((p) => p.everyone_including_new);
  const everyone = needEveryone ? (await rows("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND status = 'ACTIVE' ORDER BY user_id", [listRows[0].workspace_id])).map((r) => r.user_id) : [];
  return listRows.map((p) => {
    const atec = p.automatic_time_entry_creation || {};
    const de = atec.defaultEntities || {};
    return {
      id: p.id,
      workspaceId: p.workspace_id,
      name: p.name,
      color: p.color || null,
      icon: p.icon || null,
      timeUnit: p.time_unit || 'DAYS',
      allowHalfDay: !!p.allow_half_day,
      allowNegativeBalance: !!p.allow_negative_balance,
      negativeBalance: p.negative_balance ? { amount: Number(p.negative_balance.amount || 0), period: p.negative_balance.period || null, shouldReset: !!p.negative_balance.shouldReset, timeUnit: p.negative_balance.timeUnit || p.time_unit || 'DAYS' } : null,
      approve: approveOf(p),
      automaticAccrual: p.automatic_accrual ? { amount: Number(p.automatic_accrual.amount || 0), period: p.automatic_accrual.period || 'MONTH', timeUnit: p.automatic_accrual.timeUnit || p.time_unit || 'DAYS' } : null,
      automaticTimeEntryCreation: { enabled: !!atec.enabled, defaultEntities: { projectId: de.projectId || null, taskId: de.taskId || null } },
      projectId: de.projectId || null,
      everyoneIncludingNew: !!p.everyone_including_new,
      hasExpiration: !!p.has_expiration,
      archived: !!p.archived,
      userIds: p.everyone_including_new ? everyone : users.filter((u) => u.policy_id === p.id).map((u) => u.user_id),
      userGroupIds: groups.filter((g) => g.policy_id === p.id).map((g) => g.group_id),
      createdAt: toIso(p.created_at),
    };
  });
}

export async function policyDto(p) {
  const [dto] = await policiesDto([p]);
  return dto;
}

// Balances -------------------------------------------------------------------------------
export async function ensureBalance(workspaceId, policyId, userId) {
  return one(
    'INSERT INTO time_off_balances (id, workspace_id, policy_id, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (policy_id, user_id) DO UPDATE SET policy_id = EXCLUDED.policy_id RETURNING *',
    [newId(), workspaceId, policyId, userId],
  );
}

// Applies a change to the balance (total and/or used) and records it in the history
export async function adjustBalance(balance, { totalDelta = 0, usedDelta = 0, note, authorId }) {
  const b = await one('UPDATE time_off_balances SET total = total + $2, used = used + $3, updated_at = now() WHERE id = $1 RETURNING *', [balance.id, totalDelta, usedDelta]);
  await insert('time_off_balance_history', { id: newId(), balance_id: balance.id, delta: totalDelta - usedDelta, note: note || null, author_id: authorId || null });
  return b;
}

export function available(b) {
  return Math.round((Number(b.total) - Number(b.used)) * 100) / 100;
}

// Throws when using `units` more would exceed the policy's (negative) balance limit
export function assertBalanceAllows(policy, balance, units) {
  const after = available(balance) - Number(units);
  if (after >= 0) return;
  if (!policy.allow_negative_balance) throw badRequest('Insufficient time off balance', 400);
  const limit = policy.negative_balance && policy.negative_balance.amount != null ? Number(policy.negative_balance.amount) : null;
  if (limit != null && -after > limit + 1e-9) throw badRequest(`Negative balance limit of ${limit} ${String(policy.time_unit || 'DAYS').toLowerCase()} exceeded`, 400);
}

export function balancesDto(listRows) {
  return listRows.map((b) => ({
    id: b.id,
    policyId: b.policy_id,
    policyName: b.policy_name,
    policyArchived: !!b.policy_archived,
    policyTimeUnit: b.policy_time_unit || 'DAYS',
    userId: b.user_id,
    userName: b.user_name,
    total: Number(b.total),
    used: Number(b.used),
    balance: available(b),
    negativeBalanceAmount: b.negative_balance && b.negative_balance.amount != null ? Number(b.negative_balance.amount) : 0,
    negativeBalanceLimit: !!b.allow_negative_balance,
    workspaceId: b.workspace_id,
  }));
}

export const BALANCE_SQL = `SELECT b.*, p.name AS policy_name, p.archived AS policy_archived, p.time_unit AS policy_time_unit, p.negative_balance, p.allow_negative_balance, u.name AS user_name
  FROM time_off_balances b JOIN time_off_policies p ON p.id = b.policy_id JOIN users u ON u.id = b.user_id`;

export function balanceOrder(column, order) {
  const map = { USER: 'lower(u.name)', POLICY: 'lower(p.name)', USED: 'b.used', BALANCE: '(b.total - b.used)', TOTAL: 'b.total' };
  return `${map[column] || map.USER} ${order}, b.id`;
}

// Requests ---------------------------------------------------------------------------------
export async function loadRequest(workspaceId, policyId, id) {
  const r = await one('SELECT * FROM time_off_requests WHERE id = $1 AND workspace_id = $2 AND policy_id = $3', [id, workspaceId, policyId]);
  if (!r) throw notFound('Time off request not found', 404);
  return r;
}

export async function canApprove(ctx, policy, userId) {
  if (ctx.isAdmin) return true;
  const a = approveOf(policy);
  if (a.specificMembers && a.userIds.includes(ctx.user.id)) return true;
  if (a.teamManagers && ctx.managedTargets.size) {
    if (ctx.managedTargets.has(userId)) return true;
    const groups = await userGroupIds(ctx.workspace.id, userId);
    if (groups.some((g) => ctx.managedTargets.has(g))) return true;
  }
  return false;
}

export async function approverIds(policy, userId) {
  const a = approveOf(policy);
  const ids = new Set(await workspaceAdminIds(policy.workspace_id));
  if (a.teamManagers) for (const id of await teamManagerIdsOf(policy.workspace_id, userId)) ids.add(id);
  if (a.specificMembers) for (const id of a.userIds) ids.add(id);
  return [...ids];
}

function halfDayHoursOf(cal, date, halfDayPeriod) {
  const half = Math.round(cal.capacitySeconds / 2);
  const { start, end } = workDayInterval(cal, date, half, halfDayPeriod === 'SECOND_HALF' ? half : 0);
  return { start: toIso(start), end: toIso(end) };
}

export async function requestsDto(listRows, { workspaceId } = {}) {
  if (!listRows.length) return [];
  const wsId = workspaceId || listRows[0].workspace_id;
  const userIds = [...new Set(listRows.flatMap((r) => [r.user_id, r.requester_user_id, r.status_changed_by]).filter(Boolean))];
  const policyIds = [...new Set(listRows.map((r) => r.policy_id))];
  const users = new Map((await rows('SELECT id, name, email FROM users WHERE id = ANY($1)', [userIds])).map((u) => [u.id, u]));
  const cals = await memberCalendars(wsId, [...new Set(listRows.map((r) => r.user_id))]);
  const policies = new Map((await rows('SELECT id, name, time_unit FROM time_off_policies WHERE id = ANY($1)', [policyIds])).map((p) => [p.id, p]));
  const balances = await rows('SELECT * FROM time_off_balances WHERE policy_id = ANY($1) AND user_id = ANY($2)', [policyIds, userIds]);
  return listRows.map((r) => {
    const u = users.get(r.user_id) || {}; const req = users.get(r.requester_user_id) || {}; const changer = r.status_changed_by ? users.get(r.status_changed_by) : null;
    const cal = cals.get(r.user_id);
    const p = policies.get(r.policy_id) || {};
    const b = balances.find((x) => x.policy_id === r.policy_id && x.user_id === r.user_id);
    const startDate = cal ? localDateString(new Date(r.start_time), cal.timeZone) : toIso(r.start_time).slice(0, 10);
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      policyId: r.policy_id,
      policyName: p.name || '',
      userId: r.user_id,
      userName: u.name || '',
      userEmail: u.email || '',
      userTimeZone: cal?.timeZone || 'UTC',
      requesterUserId: r.requester_user_id,
      requesterUserName: req.name || '',
      timeOffPeriod: {
        period: { start: toIso(r.start_time), end: toIso(r.end_time), days: r.days == null ? null : Number(r.days) },
        halfDay: !!r.half_day,
        halfDayPeriod: r.half_day_period || 'NOT_DEFINED',
        halfDayHours: r.half_day && cal ? halfDayHoursOf(cal, startDate, r.half_day_period) : null,
      },
      balanceDiff: Number(r.balance_diff),
      balance: b ? available(b) : 0,
      timeUnit: r.time_unit || p.time_unit || 'DAYS',
      note: r.note || '',
      status: {
        statusType: r.status,
        note: r.status_note || '',
        changedAt: toIso(r.status_changed_at),
        changedByUserId: r.status_changed_by || null,
        changedByUserName: changer?.name || null,
        changedForUserName: u.name || '',
      },
      createdAt: toIso(r.created_at),
    };
  });
}

export async function requestDto(r) {
  const [dto] = await requestsDto([r]);
  return dto;
}

function localRange(cal, startDate, endDate) {
  const s = parseDateOnly(startDate); const e = parseDateOnly(addDaysLocal(endDate, 1));
  const startTime = zonedTime(cal.timeZone, s.year, s.month, s.day);
  const endTime = new Date(zonedTime(cal.timeZone, e.year, e.month, e.day).getTime() - 1000); // 23:59:59 local
  return { startTime, endTime };
}

// Working dates covered by the request (holidays of the user excluded)
async function requestDates(r, cal) {
  const startDate = localDateString(new Date(r.start_time), cal.timeZone);
  const endDate = localDateString(new Date(r.end_time), cal.timeZone);
  const holidays = await holidayDatesForUser(r.workspace_id, r.user_id, startDate, endDate);
  return workingDates(cal, startDate, endDate, holidays);
}

// Creates the TIME_OFF entries of an approved request (when the policy enables it) and links them to the request
async function createRequestEntries(ctx, policy, r, cal) {
  const atec = policy.automatic_time_entry_creation;
  if (!atec || !atec.enabled) return;
  const de = atec.defaultEntities || {};
  const dates = await requestDates(r, cal);
  for (const date of dates) {
    const seconds = r.half_day ? Math.round(cal.capacitySeconds / 2) : cal.capacitySeconds;
    const offset = r.half_day && r.half_day_period === 'SECOND_HALF' ? Math.round(cal.capacitySeconds / 2) : 0;
    const e = await createAutoEntry(ctx, cal, { date, seconds, offsetSeconds: offset, type: 'TIME_OFF', description: policy.name, projectId: de.projectId, taskId: de.taskId });
    await query('INSERT INTO time_off_request_entries (request_id, time_entry_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.id, e.id]);
  }
}

async function removeRequestEntries(r) {
  await query('UPDATE time_entries SET deleted_at = now() WHERE deleted_at IS NULL AND id IN (SELECT time_entry_id FROM time_off_request_entries WHERE request_id = $1)', [r.id]);
  await query('DELETE FROM time_off_request_entries WHERE request_id = $1', [r.id]);
}

async function applyApproval(ctx, policy, r, cal) {
  const b = await ensureBalance(r.workspace_id, policy.id, r.user_id);
  assertBalanceAllows(policy, b, r.balance_diff);
  await adjustBalance(b, { usedDelta: Number(r.balance_diff), note: `Time off approved (${toIso(r.start_time).slice(0, 10)} – ${toIso(r.end_time).slice(0, 10)})`, authorId: ctx.user.id });
  await createRequestEntries(ctx, policy, r, cal);
  events.emitAsync('balance.updated', { workspaceId: r.workspace_id, actorId: ctx.user.id, policyId: policy.id, userId: r.user_id, balanceId: b.id, requestId: r.id });
}

async function revertApproval(ctx, policy, r) {
  const b = await ensureBalance(r.workspace_id, policy.id, r.user_id);
  await adjustBalance(b, { usedDelta: -Number(r.balance_diff), note: `Time off returned (${toIso(r.start_time).slice(0, 10)} – ${toIso(r.end_time).slice(0, 10)})`, authorId: ctx.user.id });
  await removeRequestEntries(r);
  events.emitAsync('balance.updated', { workspaceId: r.workspace_id, actorId: ctx.user.id, policyId: policy.id, userId: r.user_id, balanceId: b.id, requestId: r.id });
}

function normalizePeriod(policy, cal, body) {
  const tp = body.timeOffPeriod || {};
  const per = tp.period || {};
  if (!per.start) throw badRequest('timeOffPeriod.period.start is required', 400);
  const startDate = toDateOnly(per.start, 'timeOffPeriod.period.start');
  const endDate = toDateOnly(per.end || per.start, 'timeOffPeriod.period.end');
  if (endDate < startDate) throw badRequest('timeOffPeriod.period.end must not be before start', 400);
  const halfDay = !!(tp.isHalfDay ?? tp.halfDay);
  const halfDayPeriod = String(tp.halfDayPeriod || tp.timeOffHalfDayPeriod || 'NOT_DEFINED').toUpperCase();
  if (halfDay && !policy.allow_half_day) throw badRequest('Half day requests are not allowed by this policy', 400);
  if (halfDay && startDate !== endDate) throw badRequest('Half day requests must cover a single day', 400);
  return { startDate, endDate, halfDay, halfDayPeriod: halfDay ? halfDayPeriod : null, ...localRange(cal, startDate, endDate) };
}

async function assertNoOverlap(workspaceId, userId, startTime, endTime, excludeId) {
  const overlap = await one(
    `SELECT id FROM time_off_requests WHERE workspace_id = $1 AND user_id = $2 AND status IN ('PENDING', 'APPROVED') AND start_time <= $4 AND end_time >= $3 AND ($5::char(24) IS NULL OR id <> $5)`,
    [workspaceId, userId, startTime, endTime, excludeId || null],
  );
  if (overlap) throw badRequest('The request overlaps with an existing time off request', 400);
}

async function computeUnits(policy, cal, workspaceId, userId, { startDate, endDate, halfDay }) {
  const holidays = await holidayDatesForUser(workspaceId, userId, startDate, endDate);
  const dates = workingDates(cal, startDate, endDate, holidays);
  if (!dates.length) throw badRequest('The selected period does not contain any working days', 400);
  let units = halfDay ? 0.5 : dates.length;
  if ((policy.time_unit || 'DAYS') === 'HOURS') units = Math.round((units * cal.capacitySeconds) / 36) / 100;
  return { units, days: dates.length };
}

export async function createRequest(ctx, policy, userId, body) {
  const ws = ctx.workspace;
  if (policy.archived) throw badRequest('Time off policy is archived', 400);
  const cal = await memberCalendar(ws.id, userId);
  if (cal.status !== 'ACTIVE') throw badRequest('User is not active in this workspace', 400);
  if (!(await isPolicyUser(policy, userId))) throw badRequest('User is not assigned to this time off policy', 400);
  const per = normalizePeriod(policy, cal, body);
  const { units, days } = await computeUnits(policy, cal, ws.id, userId, per);
  const autoApprove = !approveOf(policy).requiresApproval;
  const r = await transaction(async () => {
    await assertNoOverlap(ws.id, userId, per.startTime, per.endTime);
    const b = await ensureBalance(ws.id, policy.id, userId);
    assertBalanceAllows(policy, b, units);
    const created = await insert('time_off_requests', {
      id: newId(), workspace_id: ws.id, policy_id: policy.id, user_id: userId, requester_user_id: ctx.user.id,
      start_time: per.startTime, end_time: per.endTime, days: per.halfDay ? 0.5 : days, half_day: per.halfDay, half_day_period: per.halfDayPeriod,
      time_unit: policy.time_unit || 'DAYS', balance_diff: units, note: body.note || null,
      status: autoApprove ? 'APPROVED' : 'PENDING', status_changed_by: autoApprove ? ctx.user.id : null, status_changed_at: autoApprove ? new Date() : null,
    });
    if (autoApprove) await applyApproval(ctx, policy, created, cal);
    return created;
  });
  await audit({ workspaceId: ws.id, userId: ctx.user.id, action: 'CREATE_TIME_OFF_REQUEST', entityType: 'TIME_OFF_REQUEST', entityId: r.id, content: { ...body, userId, policyId: policy.id } });
  events.emitAsync('time_off.requested', { workspaceId: ws.id, actorId: ctx.user.id, requestId: r.id, policyId: policy.id, userId });
  const range = `${per.startDate}${per.endDate !== per.startDate ? ` – ${per.endDate}` : ''}`;
  if (autoApprove) {
    events.emitAsync('time_off.approved', { workspaceId: ws.id, actorId: ctx.user.id, requestId: r.id, policyId: policy.id, userId });
    await notifyWithMail([userId], { workspaceId: ws.id, type: 'TIME_OFF_APPROVED', title: `Time off approved: ${policy.name}`, body: `Your time off (${range}) was approved automatically.`, payload: { requestId: r.id, policyId: policy.id, userId }, settingKey: 'pto', exclude: [ctx.user.id] });
  } else {
    await notifyWithMail(await approverIds(policy, userId), { workspaceId: ws.id, type: 'TIME_OFF_REQUESTED', title: `${cal.name} requested time off (${policy.name})`, body: `${cal.name} requested ${units} ${String(policy.time_unit || 'DAYS').toLowerCase()} of time off (${range}).`, payload: { requestId: r.id, policyId: policy.id, userId }, settingKey: 'pto', exclude: [ctx.user.id] });
  }
  return r;
}

// Edits the note/period of a PENDING request (extra endpoint used by the UI)
export async function updateRequest(ctx, policy, r, body) {
  if (r.status !== 'PENDING') throw badRequest('Only pending requests can be edited', 400);
  const cal = await memberCalendar(ctx.workspace.id, r.user_id);
  let patch = { note: body.note !== undefined ? body.note || null : undefined };
  if (body.timeOffPeriod) {
    const per = normalizePeriod(policy, cal, body);
    const { units, days } = await computeUnits(policy, cal, ctx.workspace.id, r.user_id, per);
    await assertNoOverlap(ctx.workspace.id, r.user_id, per.startTime, per.endTime, r.id);
    const b = await ensureBalance(ctx.workspace.id, policy.id, r.user_id);
    assertBalanceAllows(policy, b, units);
    patch = { ...patch, start_time: per.startTime, end_time: per.endTime, days: per.halfDay ? 0.5 : days, half_day: per.halfDay, half_day_period: per.halfDayPeriod, balance_diff: units };
  }
  const updated = await one(
    `UPDATE time_off_requests SET note = COALESCE($2, note), start_time = COALESCE($3, start_time), end_time = COALESCE($4, end_time), days = COALESCE($5, days),
        half_day = COALESCE($6, half_day), half_day_period = CASE WHEN $3::timestamptz IS NULL THEN half_day_period ELSE $7 END, balance_diff = COALESCE($8, balance_diff)
      WHERE id = $1 RETURNING *`,
    [r.id, patch.note ?? null, patch.start_time ?? null, patch.end_time ?? null, patch.days ?? null, patch.half_day ?? null, patch.half_day_period ?? null, patch.balance_diff ?? null],
  );
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'UPDATE_TIME_OFF_REQUEST', entityType: 'TIME_OFF_REQUEST', entityId: r.id, content: body });
  events.emitAsync('time_off.updated', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, requestId: r.id, policyId: policy.id, userId: r.user_id });
  return updated;
}

export async function changeStatus(ctx, policy, r, status, note) {
  const ws = ctx.workspace;
  if (!(await canApprove(ctx, policy, r.user_id))) throw forbidden('You are not allowed to approve or reject this time off request', 403);
  if (r.status === status) throw badRequest(`Time off request is already ${status.toLowerCase()}`, 400);
  if (r.status === 'WITHDRAWN') throw badRequest('Withdrawn time off requests cannot be changed', 400);
  const cal = await memberCalendar(ws.id, r.user_id);
  const updated = await transaction(async () => {
    if (status === 'APPROVED') {
      await assertNoOverlap(ws.id, r.user_id, r.start_time, r.end_time, r.id);
      await applyApproval(ctx, policy, r, cal);
    } else if (r.status === 'APPROVED') {
      await revertApproval(ctx, policy, r);
    }
    return one('UPDATE time_off_requests SET status = $2, status_note = $3, status_changed_by = $4, status_changed_at = now() WHERE id = $1 RETURNING *', [r.id, status, note || null, ctx.user.id]);
  });
  await audit({ workspaceId: ws.id, userId: ctx.user.id, action: status === 'APPROVED' ? 'APPROVE_TIME_OFF_REQUEST' : 'REJECT_TIME_OFF_REQUEST', entityType: 'TIME_OFF_REQUEST', entityId: r.id, content: { status, note }, previous: { status: r.status } });
  events.emitAsync(status === 'APPROVED' ? 'time_off.approved' : 'time_off.rejected', { workspaceId: ws.id, actorId: ctx.user.id, requestId: r.id, policyId: policy.id, userId: r.user_id });
  const range = `${toIso(r.start_time).slice(0, 10)} – ${toIso(r.end_time).slice(0, 10)}`;
  await notifyWithMail([r.user_id], {
    workspaceId: ws.id, type: status === 'APPROVED' ? 'TIME_OFF_APPROVED' : 'TIME_OFF_REJECTED',
    title: `Time off ${status.toLowerCase()}: ${policy.name}`, body: `Your time off request (${range}) was ${status.toLowerCase()} by ${ctx.user.name}.${note ? ` Note: ${note}` : ''}`,
    payload: { requestId: r.id, policyId: policy.id, userId: r.user_id, status }, settingKey: 'pto', exclude: [ctx.user.id],
  });
  return updated;
}

// Owner withdraws the request (balance and automatic entries are returned)
export async function withdrawRequest(ctx, policy, r) {
  const ws = ctx.workspace;
  if (r.status === 'WITHDRAWN') throw badRequest('Time off request is already withdrawn', 400);
  const updated = await transaction(async () => {
    if (r.status === 'APPROVED') await revertApproval(ctx, policy, r);
    return one("UPDATE time_off_requests SET status = 'WITHDRAWN', status_changed_by = $2, status_changed_at = now() WHERE id = $1 RETURNING *", [r.id, ctx.user.id]);
  });
  await audit({ workspaceId: ws.id, userId: ctx.user.id, action: 'WITHDRAW_TIME_OFF_REQUEST', entityType: 'TIME_OFF_REQUEST', entityId: r.id, previous: { status: r.status } });
  events.emitAsync('time_off.withdrawn', { workspaceId: ws.id, actorId: ctx.user.id, requestId: r.id, policyId: policy.id, userId: r.user_id });
  const cal = await memberCalendar(ws.id, r.user_id);
  await notifyWithMail(await approverIds(policy, r.user_id), {
    workspaceId: ws.id, type: 'TIME_OFF_WITHDRAWN', title: `${cal.name} withdrew a time off request (${policy.name})`,
    body: `Time off request (${toIso(r.start_time).slice(0, 10)} – ${toIso(r.end_time).slice(0, 10)}) was withdrawn.`, payload: { requestId: r.id, policyId: policy.id, userId: r.user_id }, settingKey: 'pto', exclude: [ctx.user.id],
  });
  return updated;
}

// Admin deletes the request (balance and automatic entries are returned first)
export async function deleteRequest(ctx, policy, r) {
  const ws = ctx.workspace;
  const dto = await requestDto(r);
  await transaction(async () => {
    if (r.status === 'APPROVED') await revertApproval(ctx, policy, r);
    await query('DELETE FROM time_off_requests WHERE id = $1', [r.id]);
  });
  await audit({ workspaceId: ws.id, userId: ctx.user.id, action: 'DELETE_TIME_OFF_REQUEST', entityType: 'TIME_OFF_REQUEST', entityId: r.id, previous: dto });
  events.emitAsync('time_off.withdrawn', { workspaceId: ws.id, actorId: ctx.user.id, requestId: r.id, policyId: policy.id, userId: r.user_id, deleted: true });
  if (r.status !== 'WITHDRAWN') {
    await notifyWithMail([r.user_id], { workspaceId: ws.id, type: 'TIME_OFF_WITHDRAWN', title: `Time off request deleted: ${policy.name}`, body: `Your time off request (${toIso(r.start_time).slice(0, 10)} – ${toIso(r.end_time).slice(0, 10)}) was deleted by ${ctx.user.name}.`, payload: { requestId: r.id, policyId: policy.id, userId: r.user_id }, settingKey: 'pto', exclude: [ctx.user.id] });
  }
  return dto;
}

// Dates (YYYY-MM-DD) of approved time off per user within a period – used by the scheduling module
export async function approvedTimeOffDates(workspaceId, userIds, startDate, endDate) {
  const out = new Map(userIds.map((id) => [id, new Set()]));
  if (!userIds.length) return out;
  const cals = await memberCalendars(workspaceId, userIds);
  const s = parseDateOnly(startDate); const e = parseDateOnly(addDaysLocal(endDate, 1));
  const list = await rows(
    `SELECT user_id, start_time, end_time FROM time_off_requests WHERE workspace_id = $1 AND user_id = ANY($2) AND status = 'APPROVED' AND start_time < $4 AND end_time >= $3`,
    [workspaceId, userIds, new Date(Date.UTC(s.year, s.month - 1, s.day - 1)), new Date(Date.UTC(e.year, e.month - 1, e.day + 1))],
  );
  for (const r of list) {
    const tz = cals.get(r.user_id)?.timeZone || 'UTC';
    for (const d of eachDay(localDateString(new Date(r.start_time), tz), localDateString(new Date(r.end_time), tz))) {
      if (d >= startDate && d <= endDate) out.get(r.user_id).add(d);
    }
  }
  return out;
}

// Accrual job ----------------------------------------------------------------------------------
function periodKey(date, period) {
  const iso = date.toISOString();
  return period === 'YEAR' ? iso.slice(0, 4) : iso.slice(0, 7);
}

// Credits the automatic accrual amount once per period (MONTH|YEAR) to every eligible user of each policy
export async function runAccrual({ now = new Date() } = {}) {
  const policies = await rows("SELECT * FROM time_off_policies WHERE archived = false AND automatic_accrual IS NOT NULL AND COALESCE((automatic_accrual->>'amount')::numeric, 0) > 0");
  let credited = 0;
  for (const p of policies) {
    const acc = p.automatic_accrual;
    const period = String(acc.period || 'MONTH').toUpperCase() === 'YEAR' ? 'YEAR' : 'MONTH';
    const key = periodKey(now, period);
    if (p.last_accrual_at && periodKey(new Date(p.last_accrual_at), period) >= key) continue;
    const amount = Number(acc.amount);
    await transaction(async () => {
      for (const uid of await policyUserIds(p)) {
        const b = await ensureBalance(p.workspace_id, p.id, uid);
        await adjustBalance(b, { totalDelta: amount, note: `Automatic accrual ${key}`, authorId: null });
        events.emitAsync('balance.updated', { workspaceId: p.workspace_id, actorId: null, policyId: p.id, userId: uid, balanceId: b.id, accrual: key });
        credited++;
      }
      await query('UPDATE time_off_policies SET last_accrual_at = $2 WHERE id = $1', [p.id, now]);
    });
  }
  return credited;
}
