import { Router } from 'express';
import { one, rows, query, transaction } from '../../lib/db.js';
import { parse, z, bool, paging, sort, rateSchema } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { taskDto } from '../../lib/dto.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { isoToSeconds } from '../../lib/duration.js';
import { createTask, canAccessProject, taskListDto } from '../projects/service.js';
import { recordRateHistory, reapplyRates } from '../../lib/rates.js';

export const router = Router({ mergeParams: true }); // /workspaces/:workspaceId/projects/:projectId/tasks

async function getTask(workspaceId, projectId, id) {
  const t = await one('SELECT t.*, (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(e.end_time, now()) - e.start_time)))::bigint FROM time_entries e WHERE e.task_id = t.id AND e.deleted_at IS NULL) AS duration_seconds FROM tasks t WHERE t.id = $1 AND t.project_id = $2 AND t.workspace_id = $3', [id, projectId, workspaceId]);
  if (!t) throw notFound('Task not found', 404);
  return t;
}

export async function singleTaskDto(t) {
  const assignees = await rows('SELECT user_id FROM task_assignees WHERE task_id = $1', [t.id]);
  const groups = await rows('SELECT group_id FROM task_user_groups WHERE task_id = $1', [t.id]);
  return taskDto(t, { assigneeIds: assignees.map((a) => a.user_id), userGroupIds: groups.map((g) => g.group_id) });
}

const taskSchema = z.object({
  name: z.string().min(1).max(250),
  assigneeIds: z.array(z.string()).optional(),
  assigneeId: z.string().nullable().optional(),
  userGroupIds: z.array(z.string()).optional(),
  estimate: z.string().nullable().optional(),
  budgetEstimate: z.number().nullable().optional(),
  status: z.enum(['ACTIVE', 'DONE', 'ALL']).optional(),
  billable: z.boolean().nullable().optional(),
  hourlyRate: rateSchema.nullable().optional(),
  costRate: rateSchema.nullable().optional(),
});

function canManageTasks(req) {
  return req.ctx.managesProject(req.params.projectId) || req.ctx.canCreate('task');
}

router.get('/', async (req, res) => {
  if (!(await canAccessProject(req.ctx, req.params.projectId))) throw notFound('Project not found', 404);
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = sort(req.query, ['NAME', 'ID'], 'NAME');
  const conds = ['t.project_id = $1']; const params = [req.params.projectId];
  if (req.query['is-active'] !== undefined && req.query['is-active'] !== '') { params.push(bool(req.query['is-active'], true) ? 'ACTIVE' : 'DONE'); conds.push(`t.status = $${params.length}`); }
  if (req.query.name) { params.push(bool(req.query['strict-name-search'], false) ? String(req.query.name).toLowerCase() : `%${String(req.query.name).toLowerCase()}%`); conds.push(`lower(t.name) LIKE $${params.length}`); }
  params.push(limit, offset);
  const tasks = await rows(`SELECT t.*, (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(e.end_time, now()) - e.start_time)))::bigint FROM time_entries e WHERE e.task_id = t.id AND e.deleted_at IS NULL) AS duration_seconds FROM tasks t WHERE ${conds.join(' AND ')} ORDER BY ${s.column === 'ID' ? 't.id' : 'lower(t.name)'} ${s.order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(await Promise.all(tasks.map(singleTaskDto)));
});

router.get('/:taskId', async (req, res) => {
  if (!(await canAccessProject(req.ctx, req.params.projectId))) throw notFound('Project not found', 404);
  res.json(await singleTaskDto(await getTask(req.workspace.id, req.params.projectId, req.params.taskId)));
});

router.post('/', async (req, res) => {
  if (!canManageTasks(req)) throw forbidden('You are not allowed to create tasks', 403);
  const p = await one('SELECT id FROM projects WHERE id = $1 AND workspace_id = $2', [req.params.projectId, req.workspace.id]);
  if (!p) throw notFound('Project not found', 404);
  const b = parse(taskSchema, req.body);
  const dup = await one('SELECT 1 FROM tasks WHERE project_id = $1 AND lower(name) = lower($2)', [p.id, b.name]);
  if (dup) throw badRequest('A task with this name already exists in this project', 501);
  const t = await createTask(req.workspace.id, p.id, { ...b, id: req.body.id });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_TASK', entityType: 'TASK', entityId: t.id, content: b });
  events.emitAsync('task.created', { workspaceId: req.workspace.id, actorId: req.user.id, taskId: t.id, projectId: p.id });
  res.status(201).json(await singleTaskDto(await getTask(req.workspace.id, p.id, t.id)));
});

router.put('/:taskId', async (req, res) => {
  if (!canManageTasks(req)) throw forbidden('You are not allowed to edit tasks', 403);
  const prev = await getTask(req.workspace.id, req.params.projectId, req.params.taskId);
  const b = parse(taskSchema.partial(), req.body);
  if (b.name) {
    const dup = await one('SELECT 1 FROM tasks WHERE project_id = $1 AND lower(name) = lower($2) AND id <> $3', [prev.project_id, b.name, prev.id]);
    if (dup) throw badRequest('A task with this name already exists in this project', 501);
  }
  await transaction(async () => {
    await query(
      `UPDATE tasks SET name = COALESCE($2, name), status = COALESCE($3, status), estimate_seconds = CASE WHEN $4::boolean THEN $5 ELSE estimate_seconds END, budget_estimate = CASE WHEN $6::boolean THEN $7 ELSE budget_estimate END, billable = CASE WHEN $8::boolean THEN $9 ELSE billable END,
         hourly_rate_amount = CASE WHEN $10::boolean THEN $11 ELSE hourly_rate_amount END, hourly_rate_currency = CASE WHEN $10::boolean THEN COALESCE($12, hourly_rate_currency) ELSE hourly_rate_currency END, cost_rate_amount = CASE WHEN $13::boolean THEN $14 ELSE cost_rate_amount END WHERE id = $1`,
      [prev.id, b.name ?? null, b.status && b.status !== 'ALL' ? b.status : null, b.estimate !== undefined, b.estimate ? isoToSeconds(b.estimate) : null, b.budgetEstimate !== undefined, b.budgetEstimate ?? null, b.billable !== undefined, b.billable ?? null,
        b.hourlyRate !== undefined, b.hourlyRate?.amount ?? null, b.hourlyRate?.currency ?? null, b.costRate !== undefined, b.costRate?.amount ?? null],
    );
    if (b.assigneeIds || b.assigneeId !== undefined) {
      await query('DELETE FROM task_assignees WHERE task_id = $1', [prev.id]);
      for (const uid of b.assigneeIds || (b.assigneeId ? [b.assigneeId] : [])) await query('INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [prev.id, uid]);
    }
    if (b.userGroupIds) {
      await query('DELETE FROM task_user_groups WHERE task_id = $1', [prev.id]);
      for (const gid of b.userGroupIds) await query('INSERT INTO task_user_groups (task_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [prev.id, gid]);
    }
    if (b.status === 'DONE') await query('UPDATE time_entries SET end_time = now() WHERE task_id = $1 AND end_time IS NULL AND deleted_at IS NULL', [prev.id]);
  });
  if (b.hourlyRate || b.costRate) await reapplyRates({ workspaceId: req.workspace.id, taskId: prev.id, since: b.hourlyRate?.since || b.costRate?.since });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_TASK', entityType: 'TASK', entityId: prev.id, content: b, previous: await singleTaskDto(prev) });
  events.emitAsync('task.updated', { workspaceId: req.workspace.id, actorId: req.user.id, taskId: prev.id, projectId: prev.project_id });
  res.json(await singleTaskDto(await getTask(req.workspace.id, req.params.projectId, prev.id)));
});

async function taskRate(req, res, kind) {
  req.ctx.requireProjectManager(req.params.projectId);
  const t = await getTask(req.workspace.id, req.params.projectId, req.params.id);
  const { amount, since, currency } = parse(rateSchema, req.body);
  const col = kind === 'HOURLY' ? 'hourly_rate_amount' : 'cost_rate_amount';
  await query(`UPDATE tasks SET ${col} = $2, hourly_rate_currency = COALESCE($3, hourly_rate_currency) WHERE id = $1`, [t.id, amount, currency || null]);
  await recordRateHistory({ workspaceId: req.workspace.id, entityType: 'TASK', entityId: t.id, rateType: kind, amount, currency, since, createdBy: req.user.id });
  if (since) await reapplyRates({ workspaceId: req.workspace.id, taskId: t.id, since });
  events.emitAsync('rate.updated', { workspaceId: req.workspace.id, actorId: req.user.id, rateType: kind === 'HOURLY' ? 'BILLABLE' : 'COST', entity: 'TASK', taskId: t.id });
  res.json(await singleTaskDto(await getTask(req.workspace.id, req.params.projectId, t.id)));
}
router.put('/:id/hourly-rate', (req, res) => taskRate(req, res, 'HOURLY'));
router.put('/:id/cost-rate', (req, res) => taskRate(req, res, 'COST'));

router.delete('/:taskId', async (req, res) => {
  if (!canManageTasks(req)) throw forbidden('You are not allowed to delete tasks', 403);
  const t = await getTask(req.workspace.id, req.params.projectId, req.params.taskId);
  const dto = await singleTaskDto(t);
  await query('DELETE FROM tasks WHERE id = $1', [t.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_TASK', entityType: 'TASK', entityId: t.id, previous: dto });
  events.emitAsync('task.deleted', { workspaceId: req.workspace.id, actorId: req.user.id, taskId: t.id, projectId: t.project_id, task: dto });
  res.json(dto);
});

export { taskListDto };
export default router;
