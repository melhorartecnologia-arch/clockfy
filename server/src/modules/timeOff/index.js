// Module "timeOff" – time off policies, requests and balances (Clockify API compatible).
// Policies:
//   GET    /time-off/policies?page&page-size&name&status(ACTIVE|ARCHIVED|ALL)&sort-column&sort-order -> [PolicyDtoV1]
//   POST   /time-off/policies                        (admin) CreatePolicyRequestV1 -> PolicyDtoV1
//   GET    /time-off/policies/:id                    -> PolicyDtoV1
//   PUT    /time-off/policies/:id                    (admin) UpdatePolicyRequestV1 -> PolicyDtoV1
//   PATCH  /time-off/policies/:id {status}           (admin) -> PolicyDtoV1
//   DELETE /time-off/policies/:id                    (admin) -> PolicyDtoV1
// Requests:
//   POST   /time-off/policies/:policyId/requests                       CreateTimeOffRequestV1Request -> TimeOffRequestFullV1Dto (own)
//   POST   /time-off/policies/:policyId/users/:userId/requests         (admin / team manager) -> TimeOffRequestFullV1Dto
//   PATCH  /time-off/policies/:policyId/requests/:requestId {status, note}  (approver) -> TimeOffRequestFullV1Dto
//   DELETE /time-off/policies/:policyId/requests/:requestId            owner withdraws (WITHDRAWN) / admin deletes -> TimeOffRequestFullV1Dto
//   POST   /time-off/requests  GetTimeOffRequestsV1Request              -> TimeOffRequestsWithCountV1Dto {count, requests}
// Balances:
//   GET    /time-off/balance/policy/:policyId?page&page-size&sort&sort-order -> BalancesWithCountDtoV1
//   GET    /time-off/balance/user/:userId?page&page-size&sort&sort-order     -> BalancesWithCountDtoV1
//   PATCH  /time-off/balance/policy/:policyId {userIds, value, note}   (admin) -> 204
// Extra (UI):
//   GET    /time-off/requests/:requestId                                -> TimeOffRequestFullV1Dto
//   PUT    /time-off/policies/:policyId/requests/:requestId {timeOffPeriod?, note?}  edits a PENDING request (owner/admin)
// Scheduler job "time-off-accrual" (hourly): credits automaticAccrual.amount once per MONTH/YEAR to eligible users.
import { Router } from 'express';
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, paging, sort, int, list } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parseDate } from '../../lib/dates.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { registerJob } from '../../scheduler.js';
import { visibleUserIds, userGroupIds } from '../../middleware/workspace.js';
import { resolveUserFilter, resolveGroupFilter, normalizeAutoEntry } from '../holidays/service.js';
import {
  loadPolicy, policyDto, policiesDto, policyUserIds, isPolicyUser, policiesOfUser, ensureBalance, adjustBalance, balancesDto, BALANCE_SQL, balanceOrder,
  loadRequest, requestDto, requestsDto, createRequest, updateRequest, changeStatus, withdrawRequest, deleteRequest, canApprove, runAccrual, approveOf,
} from './service.js';

export { runAccrual };

export const router = Router({ mergeParams: true });

const filterSchema = z.object({
  ids: z.array(z.string()).optional(),
  contains: z.enum(['CONTAINS', 'DOES_NOT_CONTAIN', 'CONTAINS_ONLY']).optional(),
  status: z.string().optional(),
  statuses: z.array(z.string()).optional(),
}).nullable().optional();
const approveSchema = z.object({ requiresApproval: z.boolean().optional(), teamManagers: z.boolean().optional(), specificMembers: z.boolean().optional(), userIds: z.array(z.string()).optional() });
const negativeSchema = z.object({ amount: z.number().nonnegative(), period: z.enum(['MONTH', 'YEAR']).nullable().optional(), shouldReset: z.boolean().optional(), timeUnit: z.enum(['DAYS', 'HOURS']).nullable().optional(), amountValidForTimeUnit: z.boolean().optional() });
const accrualSchema = z.object({ amount: z.number().nonnegative(), period: z.enum(['MONTH', 'YEAR']).nullable().optional(), timeUnit: z.enum(['DAYS', 'HOURS']).nullable().optional() });
const atecSchema = z.object({ enabled: z.boolean().optional(), defaultEntities: z.object({ projectId: z.string().nullable().optional(), taskId: z.string().nullable().optional() }).nullable().optional() });
const policySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  color: z.string().max(20).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
  timeUnit: z.enum(['DAYS', 'HOURS']).optional(),
  allowHalfDay: z.boolean().optional(),
  allowNegativeBalance: z.boolean().optional(),
  negativeBalance: negativeSchema.nullable().optional(),
  approve: approveSchema.optional(),
  automaticAccrual: accrualSchema.nullable().optional(),
  automaticTimeEntryCreation: atecSchema.nullable().optional(),
  everyoneIncludingNew: z.boolean().optional(),
  hasExpiration: z.boolean().optional(),
  archived: z.boolean().optional(),
  users: filterSchema,
  userGroups: filterSchema,
});
const policyUpdateSchema = policySchema.partial();
const requestSchema = z.object({
  note: z.string().max(3000).nullable().optional(),
  timeOffPeriod: z.object({
    period: z.object({ start: z.string().min(1), end: z.string().nullable().optional(), days: z.number().optional() }),
    isHalfDay: z.boolean().optional(),
    halfDay: z.boolean().optional(),
    halfDayPeriod: z.string().optional(),
    timeOffHalfDayPeriod: z.string().optional(),
  }),
});
const requestUpdateSchema = requestSchema.partial();
const statusSchema = z.object({ status: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(3000).nullable().optional() });

async function managesUser(ctx, userId) {
  if (ctx.isAdmin || userId === ctx.user.id) return true;
  if (!ctx.managedTargets.size) return false;
  if (ctx.managedTargets.has(userId)) return true;
  const groups = await userGroupIds(ctx.workspace.id, userId);
  return groups.some((g) => ctx.managedTargets.has(g));
}

async function normalizeApprove(workspaceId, a, current) {
  if (a === undefined) return current ? approveOf({ approve: current }) : { requiresApproval: false, teamManagers: false, specificMembers: false, userIds: [] };
  const userIds = [...new Set((a.userIds || []).filter(Boolean))];
  if (userIds.length) {
    const found = await rows('SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)', [workspaceId, userIds]);
    if (found.length !== userIds.length) throw badRequest('One or more approvers are not members of this workspace', 400);
  }
  return { requiresApproval: !!a.requiresApproval, teamManagers: !!a.teamManagers, specificMembers: !!a.specificMembers, userIds };
}

function negativeBalanceOf(b, timeUnit) {
  if (!b) return null;
  return { amount: Number(b.amount), period: b.period || null, shouldReset: !!b.shouldReset, timeUnit: b.timeUnit || timeUnit };
}

function accrualOf(a, timeUnit) {
  if (!a || !(Number(a.amount) > 0)) return null;
  return { amount: Number(a.amount), period: a.period || 'MONTH', timeUnit: a.timeUnit || timeUnit };
}

async function writePolicyMembers(policyId, userIds, groupIds) {
  if (userIds) {
    await query('DELETE FROM time_off_policy_users WHERE policy_id = $1', [policyId]);
    for (const uid of userIds) await query('INSERT INTO time_off_policy_users (policy_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [policyId, uid]);
  }
  if (groupIds) {
    await query('DELETE FROM time_off_policy_groups WHERE policy_id = $1', [policyId]);
    for (const gid of groupIds) await query('INSERT INTO time_off_policy_groups (policy_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [policyId, gid]);
  }
}

async function ensureBalances(p) {
  for (const uid of await policyUserIds(p)) await ensureBalance(p.workspace_id, p.id, uid);
}

// Policies -------------------------------------------------------------------------------
router.get('/policies', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 1000 });
  const s = sort(req.query, ['NAME', 'ID', 'DEFAULT_SORT'], 'NAME');
  const conds = ['p.workspace_id = $1']; const params = [req.workspace.id];
  const status = String(req.query.status || 'ALL').toUpperCase();
  if (status === 'ACTIVE') conds.push('p.archived = false');
  if (status === 'ARCHIVED') conds.push('p.archived = true');
  if (req.query.name) { params.push(`%${String(req.query.name).toLowerCase()}%`); conds.push(`lower(p.name) LIKE $${params.length}`); }
  if (!req.ctx.isAdmin && !req.ctx.isTeamManager) {
    params.push(req.user.id);
    conds.push(`(p.everyone_including_new OR EXISTS (SELECT 1 FROM time_off_policy_users pu WHERE pu.policy_id = p.id AND pu.user_id = $${params.length})
      OR EXISTS (SELECT 1 FROM time_off_policy_groups pg JOIN user_group_members gm ON gm.group_id = pg.group_id WHERE pg.policy_id = p.id AND gm.user_id = $${params.length})
      OR p.approve->'userIds' ? $${params.length}::text)`);
  }
  params.push(limit, offset);
  const l = await rows(`SELECT p.* FROM time_off_policies p WHERE ${conds.join(' AND ')} ORDER BY ${s.column === 'ID' ? 'p.id' : 'lower(p.name)'} ${s.order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(await policiesDto(l));
});

router.post('/policies', async (req, res) => {
  req.ctx.requireAdmin();
  const ws = req.workspace.id;
  const b = parse(policySchema, req.body);
  const dup = await one('SELECT 1 FROM time_off_policies WHERE workspace_id = $1 AND lower(name) = lower($2)', [ws, b.name]);
  if (dup) throw badRequest('A time off policy with this name already exists', 400);
  const timeUnit = b.timeUnit || 'DAYS';
  const userIds = await resolveUserFilter(ws, b.users);
  const groupIds = await resolveGroupFilter(ws, b.userGroups);
  const approve = await normalizeApprove(ws, b.approve);
  const atec = await normalizeAutoEntry(ws, b.automaticTimeEntryCreation);
  const accrual = accrualOf(b.automaticAccrual, timeUnit);
  const p = await transaction(async () => {
    const created = await insert('time_off_policies', {
      id: b.id && /^[a-f0-9]{24}$/.test(b.id) ? b.id : newId(), workspace_id: ws, name: b.name, color: b.color || null, icon: b.icon || null, time_unit: timeUnit,
      allow_half_day: !!b.allowHalfDay, allow_negative_balance: !!b.allowNegativeBalance, negative_balance: negativeBalanceOf(b.negativeBalance, timeUnit),
      approve, automatic_accrual: accrual, automatic_time_entry_creation: atec, everyone_including_new: !!b.everyoneIncludingNew, has_expiration: !!b.hasExpiration,
      archived: !!b.archived, last_accrual_at: accrual ? new Date() : null,
    });
    await writePolicyMembers(created.id, userIds, groupIds);
    await ensureBalances(created);
    return created;
  });
  await audit({ workspaceId: ws, userId: req.user.id, action: 'CREATE_TIME_OFF_POLICY', entityType: 'TIME_OFF_POLICY', entityId: p.id, content: b });
  events.emitAsync('time_off_policy.created', { workspaceId: ws, actorId: req.user.id, policyId: p.id });
  res.status(201).json(await policyDto(p));
});

router.get('/policies/:id', async (req, res) => {
  const p = await loadPolicy(req.workspace.id, req.params.id);
  if (!req.ctx.isAdmin && !req.ctx.isTeamManager && !(await isPolicyUser(p, req.user.id)) && !approveOf(p).userIds.includes(req.user.id)) throw notFound('Time off policy not found', 404);
  res.json(await policyDto(p));
});

router.put('/policies/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const ws = req.workspace.id;
  const p = await loadPolicy(ws, req.params.id);
  const b = parse(policyUpdateSchema, req.body);
  if (b.name && b.name.toLowerCase() !== p.name.toLowerCase()) {
    const dup = await one('SELECT 1 FROM time_off_policies WHERE workspace_id = $1 AND lower(name) = lower($2) AND id <> $3', [ws, b.name, p.id]);
    if (dup) throw badRequest('A time off policy with this name already exists', 400);
  }
  const timeUnit = b.timeUnit || p.time_unit || 'DAYS';
  const userIds = b.users !== undefined ? await resolveUserFilter(ws, b.users) : null;
  const groupIds = b.userGroups !== undefined ? await resolveGroupFilter(ws, b.userGroups) : null;
  const approve = await normalizeApprove(ws, b.approve, p.approve);
  const atec = b.automaticTimeEntryCreation !== undefined ? await normalizeAutoEntry(ws, b.automaticTimeEntryCreation) : p.automatic_time_entry_creation;
  const accrual = b.automaticAccrual !== undefined ? accrualOf(b.automaticAccrual, timeUnit) : p.automatic_accrual;
  const previous = await policyDto(p);
  const updated = await transaction(async () => {
    const u = await one(
      `UPDATE time_off_policies SET name = $2, color = $3, icon = $4, time_unit = $5, allow_half_day = $6, allow_negative_balance = $7, negative_balance = $8,
         approve = $9, automatic_accrual = $10, automatic_time_entry_creation = $11, everyone_including_new = $12, has_expiration = $13, archived = $14,
         last_accrual_at = CASE WHEN $10::jsonb IS NULL THEN NULL WHEN last_accrual_at IS NULL THEN now() ELSE last_accrual_at END
       WHERE id = $1 RETURNING *`,
      [p.id, b.name ?? p.name, b.color === undefined ? p.color : (b.color || null), b.icon === undefined ? p.icon : (b.icon || null), timeUnit,
        b.allowHalfDay ?? p.allow_half_day, b.allowNegativeBalance ?? p.allow_negative_balance,
        JSON.stringify(b.negativeBalance !== undefined ? negativeBalanceOf(b.negativeBalance, timeUnit) : p.negative_balance),
        JSON.stringify(approve), accrual == null ? null : JSON.stringify(accrual), atec == null ? null : JSON.stringify(atec),
        b.everyoneIncludingNew ?? p.everyone_including_new, b.hasExpiration ?? p.has_expiration, b.archived ?? p.archived],
    );
    await writePolicyMembers(p.id, userIds, groupIds);
    await ensureBalances(u);
    return u;
  });
  await audit({ workspaceId: ws, userId: req.user.id, action: 'UPDATE_TIME_OFF_POLICY', entityType: 'TIME_OFF_POLICY', entityId: p.id, content: b, previous });
  events.emitAsync('time_off_policy.updated', { workspaceId: ws, actorId: req.user.id, policyId: p.id });
  res.json(await policyDto(updated));
});

router.patch('/policies/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const p = await loadPolicy(req.workspace.id, req.params.id);
  const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']) }), req.body);
  if (status === 'ALL') throw badRequest('status must be ACTIVE or ARCHIVED', 400);
  const updated = await one('UPDATE time_off_policies SET archived = $2 WHERE id = $1 RETURNING *', [p.id, status === 'ARCHIVED']);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_TIME_OFF_POLICY', entityType: 'TIME_OFF_POLICY', entityId: p.id, content: { status } });
  events.emitAsync('time_off_policy.updated', { workspaceId: req.workspace.id, actorId: req.user.id, policyId: p.id });
  res.json(await policyDto(updated));
});

router.delete('/policies/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const p = await loadPolicy(req.workspace.id, req.params.id);
  const dto = await policyDto(p);
  await query('DELETE FROM time_off_policies WHERE id = $1', [p.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_TIME_OFF_POLICY', entityType: 'TIME_OFF_POLICY', entityId: p.id, previous: dto });
  events.emitAsync('time_off_policy.deleted', { workspaceId: req.workspace.id, actorId: req.user.id, policyId: p.id, policy: dto });
  res.json(dto);
});

// Requests -------------------------------------------------------------------------------
router.post('/policies/:policyId/requests', async (req, res) => {
  const p = await loadPolicy(req.workspace.id, req.params.policyId);
  const b = parse(requestSchema, req.body);
  res.json(await requestDto(await createRequest(req.ctx, p, req.user.id, b)));
});

router.post('/policies/:policyId/users/:userId/requests', async (req, res) => {
  const p = await loadPolicy(req.workspace.id, req.params.policyId);
  if (!(await managesUser(req.ctx, req.params.userId))) throw forbidden("You can't create time off requests for this user", 403);
  const b = parse(requestSchema, req.body);
  res.json(await requestDto(await createRequest(req.ctx, p, req.params.userId, b)));
});

router.patch('/policies/:policyId/requests/:requestId', async (req, res) => {
  const p = await loadPolicy(req.workspace.id, req.params.policyId);
  const r = await loadRequest(req.workspace.id, p.id, req.params.requestId);
  const { status, note } = parse(statusSchema, req.body);
  res.json(await requestDto(await changeStatus(req.ctx, p, r, status, note)));
});

router.put('/policies/:policyId/requests/:requestId', async (req, res) => {
  const p = await loadPolicy(req.workspace.id, req.params.policyId);
  const r = await loadRequest(req.workspace.id, p.id, req.params.requestId);
  if (!req.ctx.isAdmin && r.user_id !== req.user.id && r.requester_user_id !== req.user.id) throw forbidden("You can't edit this time off request", 403);
  const b = parse(requestUpdateSchema, req.body);
  res.json(await requestDto(await updateRequest(req.ctx, p, r, b)));
});

router.delete('/policies/:policyId/requests/:requestId', async (req, res) => {
  const p = await loadPolicy(req.workspace.id, req.params.policyId);
  const r = await loadRequest(req.workspace.id, p.id, req.params.requestId);
  if (req.ctx.isAdmin) return res.json(await deleteRequest(req.ctx, p, r));
  if (r.user_id === req.user.id || r.requester_user_id === req.user.id) return res.json(await requestDto(await withdrawRequest(req.ctx, p, r)));
  throw forbidden("You can't delete this time off request", 403);
});

router.post('/requests', async (req, res) => {
  const ws = req.workspace.id; const b = req.body || {};
  const page = Math.max(1, int(b.page, 1)); const pageSize = Math.min(5000, Math.max(1, int(b.pageSize ?? b['page-size'], 50)));
  const conds = ['r.workspace_id = $1']; const params = [ws];
  const statuses = list(b.statuses || b.status).map((s) => s.toUpperCase()).filter((s) => s !== 'ALL');
  if (statuses.length) { params.push(statuses); conds.push(`r.status = ANY($${params.length})`); }
  const users = new Set(list(b.users));
  const groups = list(b.userGroups);
  if (groups.length) for (const m of await rows('SELECT user_id FROM user_group_members WHERE group_id = ANY($1)', [groups])) users.add(m.user_id);
  if (users.size || groups.length) { params.push([...users]); conds.push(`r.user_id = ANY($${params.length})`); }
  if (b.start) { params.push(parseDate(b.start, 'start')); conds.push(`r.end_time >= $${params.length}`); }
  if (b.end) { params.push(parseDate(b.end, 'end')); conds.push(`r.start_time <= $${params.length}`); }
  if (b.policyId || b.policies) { params.push(list(b.policies || b.policyId)); conds.push(`r.policy_id = ANY($${params.length})`); }
  const visible = await visibleUserIds(req.ctx);
  if (visible) { params.push(visible, req.user.id); conds.push(`(r.user_id = ANY($${params.length - 1}) OR p.approve->'userIds' ? $${params.length}::text)`); }
  const from = `FROM time_off_requests r JOIN time_off_policies p ON p.id = r.policy_id WHERE ${conds.join(' AND ')}`;
  const count = (await one(`SELECT count(*)::int AS c ${from}`, params)).c;
  params.push(pageSize, (page - 1) * pageSize);
  const l = await rows(`SELECT r.* ${from} ORDER BY r.start_time DESC, r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ count, requests: await requestsDto(l, { workspaceId: ws }) });
});

router.get('/requests/:requestId', async (req, res) => {
  const r = await one('SELECT * FROM time_off_requests WHERE id = $1 AND workspace_id = $2', [req.params.requestId, req.workspace.id]);
  if (!r) throw notFound('Time off request not found', 404);
  const p = await loadPolicy(req.workspace.id, r.policy_id);
  if (r.user_id !== req.user.id && r.requester_user_id !== req.user.id && !(await canApprove(req.ctx, p, r.user_id)) && !(await managesUser(req.ctx, r.user_id))) throw notFound('Time off request not found', 404);
  res.json(await requestDto(r));
});

// Balances -----------------------------------------------------------------------------------
function balanceSort(q) {
  return sort({ 'sort-column': q.sort || q['sort-column'] || q.sortColumn, 'sort-order': q['sort-order'] || q.sortOrder }, ['USER', 'POLICY', 'USED', 'BALANCE', 'TOTAL'], 'USER');
}

router.get('/balance/policy/:policyId', async (req, res) => {
  const p = await loadPolicy(req.workspace.id, req.params.policyId);
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = balanceSort(req.query);
  await ensureBalances(p);
  const conds = ['b.policy_id = $1']; const params = [p.id];
  const visible = await visibleUserIds(req.ctx);
  if (visible) { params.push(visible); conds.push(`b.user_id = ANY($${params.length})`); }
  const count = (await one(`SELECT count(*)::int AS c FROM time_off_balances b WHERE ${conds.join(' AND ')}`, params)).c;
  params.push(limit, offset);
  const l = await rows(`${BALANCE_SQL} WHERE ${conds.join(' AND ')} ORDER BY ${balanceOrder(s.column, s.order)} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ count, balances: balancesDto(l) });
});

router.get('/balance/user/:userId', async (req, res) => {
  const uid = req.params.userId;
  if (!(await managesUser(req.ctx, uid))) {
    const visible = await visibleUserIds(req.ctx);
    if (visible && !visible.includes(uid)) throw forbidden("You can't see this user's balances", 403);
  }
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = balanceSort(req.query);
  for (const p of await policiesOfUser(req.workspace.id, uid, { includeArchived: false })) await ensureBalance(req.workspace.id, p.id, uid);
  const params = [req.workspace.id, uid];
  const count = (await one('SELECT count(*)::int AS c FROM time_off_balances b WHERE b.workspace_id = $1 AND b.user_id = $2', params)).c;
  params.push(limit, offset);
  const l = await rows(`${BALANCE_SQL} WHERE b.workspace_id = $1 AND b.user_id = $2 ORDER BY ${balanceOrder(s.column, s.order)} LIMIT $3 OFFSET $4`, params);
  res.json({ count, balances: balancesDto(l) });
});

router.patch('/balance/policy/:policyId', async (req, res) => {
  req.ctx.requireAdmin();
  const p = await loadPolicy(req.workspace.id, req.params.policyId);
  const { userIds, value, note } = parse(z.object({ userIds: z.array(z.string()).min(1), value: z.number(), note: z.string().max(3000).nullable().optional() }), req.body);
  const ids = [...new Set(userIds)];
  await transaction(async () => {
    for (const uid of ids) {
      if (!(await isPolicyUser(p, uid))) throw badRequest(`User ${uid} is not assigned to this time off policy`, 400);
      const b = await ensureBalance(req.workspace.id, p.id, uid);
      await adjustBalance(b, { totalDelta: value, note: note || null, authorId: req.user.id });
    }
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_TIME_OFF_BALANCE', entityType: 'TIME_OFF_POLICY', entityId: p.id, content: { userIds: ids, value, note } });
  for (const uid of ids) events.emitAsync('balance.updated', { workspaceId: req.workspace.id, actorId: req.user.id, policyId: p.id, userId: uid, value, note });
  res.status(204).end();
});

registerJob('time-off-accrual', 60 * 60 * 1000, () => runAccrual());

export default {
  name: 'timeOff',
  workspace(ws) { ws.use('/time-off', router); },
};
