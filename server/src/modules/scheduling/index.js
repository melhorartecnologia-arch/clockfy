// Module "scheduling" – schedule assignments and milestones (Clockify API compatible).
//   GET    /scheduling/assignments/all?name&start&end&sort-column&sort-order&page&page-size   -> [AssignmentHydratedDtoV1]
//   POST   /scheduling/assignments/projects/totals   ProjectTotalsRequestV1                    -> [SchedulingProjectsTotalsDtoV1]
//   GET    /scheduling/assignments/projects/totals/:projectId?start&end                        -> SchedulingProjectsTotalsDtoV1
//   POST   /scheduling/assignments/user-filter/totals GetUserTotalsRequestV1                   -> [SchedulingUsersTotalsDtoV1]
//   GET    /scheduling/assignments/users/:userId/totals?start&end&page&page-size               -> SchedulingUsersTotalsDtoV1
//   PUT    /scheduling/assignments/publish            PublishAssignmentsRequestV1              -> {published, assignmentIds, userIds}
//   POST   /scheduling/assignments/recurring          AssignmentCreateRequestV1                -> [AssignmentDtoV1]
//   PATCH  /scheduling/assignments/recurring/:assignmentId  AssignmentUpdateRequestV1          -> [AssignmentDtoV1]
//   DELETE /scheduling/assignments/recurring/:assignmentId?seriesUpdateOption                  -> [AssignmentDtoV1]
//   PUT    /scheduling/assignments/series/:assignmentId     RecurringAssignmentRequestV1       -> [AssignmentDtoV1]
//   POST   /scheduling/assignments/:assignmentId/copy       CopyAssignmentRequestV1            -> [AssignmentDtoV1]
// Extra (UI):
//   POST   /scheduling/assignments                    single (non recurring) assignment        -> AssignmentDtoV1
//   GET    /scheduling/assignments/:id                                                         -> AssignmentHydratedDtoV1
//   PUT|PATCH /scheduling/assignments/:id             AssignmentUpdateRequestV1 (this one only) -> AssignmentDtoV1
//   DELETE /scheduling/assignments/:id                                                         -> 204
//   GET    /scheduling/milestones?project-id&start&end, POST /scheduling/milestones {projectId, name, date},
//   PUT    /scheduling/milestones/:id, DELETE /scheduling/milestones/:id                        -> MilestoneDto
// Permissions: admins and project managers (of the project) write; members see only their own published
// assignments (team managers also see published assignments of their teams).
import { Router } from 'express';
import { one, rows, query, insert } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, paging, sort, int } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { canAccessProject } from '../projects/service.js';
import { toDateOnly, dateStr } from '../holidays/service.js';
import {
  SERIES_OPTIONS, ASSIGNMENT_SQL, loadAssignment, visibilitySql, canSee, assignmentsDto, milestoneDto, createSeries, updateAssignments, deleteAssignments,
  changeSeries, copyAssignments, publish, projectTotals, userTotals,
} from './service.js';

export const router = Router({ mergeParams: true });

const userFilterSchema = z.object({ ids: z.array(z.string()).optional(), contains: z.string().optional(), status: z.string().optional(), statuses: z.array(z.string()).optional(), sourceType: z.string().optional() }).nullable().optional();
const createSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().min(1),
  userId: z.string().min(1),
  taskId: z.string().nullable().optional(),
  start: z.string().min(1),
  end: z.string().min(1),
  hoursPerDay: z.number().positive(),
  startTime: z.string().nullable().optional(),
  includeNonWorkingDays: z.boolean().optional(),
  note: z.string().nullable().optional(),
  billable: z.boolean().nullable().optional(),
  published: z.boolean().optional(),
  recurringAssignment: z.object({ weeks: z.number().int().min(1), repeat: z.boolean().optional() }).nullable().optional(),
});
const updateSchema = z.object({
  projectId: z.string().optional(),
  userId: z.string().optional(),
  taskId: z.string().nullable().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  hoursPerDay: z.number().positive().optional(),
  startTime: z.string().nullable().optional(),
  includeNonWorkingDays: z.boolean().optional(),
  note: z.string().nullable().optional(),
  billable: z.boolean().nullable().optional(),
  seriesUpdateOption: z.enum(SERIES_OPTIONS).optional(),
});
const totalsSchema = z.object({
  start: z.string().min(1), end: z.string().min(1), page: z.number().int().optional(), pageSize: z.number().int().optional(), search: z.string().optional(),
  statusFilter: z.enum(['PUBLISHED', 'UNPUBLISHED', 'ALL']).optional(), userFilter: userFilterSchema, userGroupFilter: userFilterSchema,
});
const publishSchema = z.object({
  start: z.string().min(1), end: z.string().min(1), notifyUsers: z.boolean().optional(), search: z.string().optional(),
  userFilter: userFilterSchema, userGroupFilter: userFilterSchema, viewType: z.enum(['PROJECTS', 'TEAM', 'ALL']).optional(),
});
const milestoneSchema = z.object({ id: z.string().optional(), projectId: z.string().min(1), name: z.string().min(1).max(200), date: z.string().min(1) });

function seriesOption(v) {
  const o = String(v || 'THIS_ONE').toUpperCase();
  if (!SERIES_OPTIONS.includes(o)) throw badRequest('seriesUpdateOption must be THIS_ONE, THIS_AND_FOLLOWING or ALL', 400);
  return o;
}

async function respondList(req, res, list, status = 200) {
  res.status(status).json(await assignmentsDto(req.workspace.id, list, { hydrated: true }));
}

// Listing --------------------------------------------------------------------------------------
router.get('/assignments/all', async (req, res) => {
  const ws = req.workspace.id;
  if (!req.query.start || !req.query.end) throw badRequest('start and end are required', 400);
  const start = toDateOnly(req.query.start, 'start'); const end = toDateOnly(req.query.end, 'end');
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = sort(req.query, ['PROJECT', 'USER', 'ID'], 'PROJECT');
  const conds = ['a.workspace_id = $1', 'a.start_date <= $3', 'a.end_date >= $2']; const params = [ws, start, end];
  if (req.query.name) { params.push(`%${String(req.query.name).toLowerCase()}%`); conds.push(`(lower(p.name) LIKE $${params.length} OR lower(u.name) LIKE $${params.length} OR lower(COALESCE(t.name, '')) LIKE $${params.length})`); }
  if (req.query.users || req.query.user) { params.push(String(req.query.users || req.query.user).split(',').map((x) => x.trim()).filter(Boolean)); conds.push(`a.user_id = ANY($${params.length})`); }
  if (req.query.project || req.query.projects) { params.push(String(req.query.project || req.query.projects).split(',').map((x) => x.trim()).filter(Boolean)); conds.push(`a.project_id = ANY($${params.length})`); }
  if (req.query.published !== undefined && req.query.published !== '') conds.push(`a.published = ${String(req.query.published) === 'true'}`);
  const vis = await visibilitySql(req.ctx, params); if (vis) conds.push(vis);
  const orderMap = { PROJECT: 'lower(p.name)', USER: 'lower(u.name)', ID: 'a.id' };
  params.push(limit, offset);
  const list = await rows(`${ASSIGNMENT_SQL} WHERE ${conds.join(' AND ')} ORDER BY ${orderMap[s.column]} ${s.order}, a.start_date, a.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  await respondList(req, res, list);
});

// Totals ------------------------------------------------------------------------------------------
router.post('/assignments/projects/totals', async (req, res) => {
  const b = parse(totalsSchema, req.body);
  res.json(await projectTotals(req.ctx, b));
});

router.get('/assignments/projects/totals/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  if (!req.ctx.isAdmin && !(await canAccessProject(req.ctx, projectId))) throw notFound('Project not found', 404);
  const [out] = await projectTotals(req.ctx, { start: req.query.start, end: req.query.end, projectId, statusFilter: req.query.statusFilter || req.query['status-filter'] });
  res.json(out);
});

router.post('/assignments/user-filter/totals', async (req, res) => {
  const b = parse(totalsSchema, req.body);
  res.json(await userTotals(req.ctx, b));
});

router.get('/assignments/users/:userId/totals', async (req, res) => {
  const [out] = await userTotals(req.ctx, {
    start: req.query.start, end: req.query.end, userId: req.params.userId, statusFilter: req.query.statusFilter || req.query['status-filter'],
    page: int(req.query.page, 1), pageSize: int(req.query['page-size'] ?? req.query.pageSize, 50),
  });
  if (!out) throw forbidden("You can't see this user's schedule", 403);
  res.json(out);
});

// Publish ---------------------------------------------------------------------------------------------
router.put('/assignments/publish', async (req, res) => {
  const b = parse(publishSchema, req.body);
  res.json(await publish(req.ctx, b));
});

// Recurring assignments --------------------------------------------------------------------------------
router.post('/assignments/recurring', async (req, res) => {
  const b = parse(createSchema, req.body);
  await respondList(req, res, await createSeries(req.ctx, b), 201);
});

router.patch('/assignments/recurring/:assignmentId', async (req, res) => {
  const a = await loadAssignment(req.workspace.id, req.params.assignmentId);
  const b = parse(updateSchema, req.body);
  await respondList(req, res, await updateAssignments(req.ctx, a, b, seriesOption(b.seriesUpdateOption)));
});

router.delete('/assignments/recurring/:assignmentId', async (req, res) => {
  const a = await loadAssignment(req.workspace.id, req.params.assignmentId);
  res.json(await deleteAssignments(req.ctx, a, seriesOption(req.query.seriesUpdateOption || req.query['series-update-option'])));
});

router.put('/assignments/series/:assignmentId', async (req, res) => {
  const a = await loadAssignment(req.workspace.id, req.params.assignmentId);
  const b = parse(z.object({ weeks: z.number().int().min(1), repeat: z.boolean().optional() }), req.body);
  await respondList(req, res, await changeSeries(req.ctx, a, b));
});

router.post('/assignments/:assignmentId/copy', async (req, res) => {
  const a = await loadAssignment(req.workspace.id, req.params.assignmentId);
  const b = parse(z.object({ userId: z.string().min(1), seriesUpdateOption: z.enum(SERIES_OPTIONS).optional() }), req.body);
  await respondList(req, res, await copyAssignments(req.ctx, a, { userId: b.userId, seriesUpdateOption: seriesOption(b.seriesUpdateOption) }));
});

// Single assignments (extra) -------------------------------------------------------------------------------
router.post('/assignments', async (req, res) => {
  const b = parse(createSchema, req.body);
  const [dto] = await assignmentsDto(req.workspace.id, await createSeries(req.ctx, { ...b, recurringAssignment: b.recurringAssignment || null }), { hydrated: true });
  res.status(201).json(dto);
});

router.get('/assignments/:id', async (req, res) => {
  const a = await loadAssignment(req.workspace.id, req.params.id);
  if (!(await canSee(req.ctx, a))) throw notFound('Assignment not found', 404);
  const [dto] = await assignmentsDto(req.workspace.id, [a], { hydrated: true });
  res.json(dto);
});

async function putOne(req, res) {
  const a = await loadAssignment(req.workspace.id, req.params.id);
  const b = parse(updateSchema, req.body);
  const [dto] = await assignmentsDto(req.workspace.id, await updateAssignments(req.ctx, a, b, seriesOption(b.seriesUpdateOption)), { hydrated: true });
  res.json(dto);
}
router.put('/assignments/:id', putOne);
router.patch('/assignments/:id', putOne);

router.delete('/assignments/:id', async (req, res) => {
  const a = await loadAssignment(req.workspace.id, req.params.id);
  await deleteAssignments(req.ctx, a, seriesOption(req.query.seriesUpdateOption || req.query['series-update-option']));
  res.status(204).end();
});

// Milestones -------------------------------------------------------------------------------------------------
async function loadMilestone(workspaceId, id) {
  const m = await one('SELECT * FROM scheduling_milestones WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!m) throw notFound('Milestone not found', 404);
  return m;
}

async function assertProject(ctx, projectId) {
  const p = await one('SELECT id FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, ctx.workspace.id]);
  if (!p) throw badRequest('Project not found', 400);
  ctx.requireProjectManager(projectId);
}

router.get('/milestones', async (req, res) => {
  const conds = ['m.workspace_id = $1']; const params = [req.workspace.id];
  const projectId = req.query['project-id'] || req.query.projectId;
  if (projectId) {
    if (!req.ctx.isAdmin && !(await canAccessProject(req.ctx, projectId))) throw notFound('Project not found', 404);
    params.push(projectId); conds.push(`m.project_id = $${params.length}`);
  } else if (!req.ctx.isAdmin) {
    params.push(req.user.id, [...req.ctx.managedProjects]);
    conds.push(`(m.project_id = ANY($${params.length}) OR EXISTS (SELECT 1 FROM projects p WHERE p.id = m.project_id AND (p.is_public OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND ((pm.target_type = 'USER' AND pm.target_id = $${params.length - 1}) OR (pm.target_type = 'USERGROUP' AND pm.target_id IN (SELECT group_id FROM user_group_members WHERE user_id = $${params.length - 1})))))))`);
  }
  if (req.query.start) { params.push(toDateOnly(req.query.start, 'start')); conds.push(`m.date >= $${params.length}`); }
  if (req.query.end) { params.push(toDateOnly(req.query.end, 'end')); conds.push(`m.date <= $${params.length}`); }
  const list = await rows(`SELECT m.* FROM scheduling_milestones m WHERE ${conds.join(' AND ')} ORDER BY m.date, lower(m.name)`, params);
  res.json(list.map(milestoneDto));
});

router.post('/milestones', async (req, res) => {
  const b = parse(milestoneSchema, req.body);
  await assertProject(req.ctx, b.projectId);
  const m = await insert('scheduling_milestones', { id: b.id && /^[a-f0-9]{24}$/.test(b.id) ? b.id : newId(), workspace_id: req.workspace.id, project_id: b.projectId, name: b.name, date: toDateOnly(b.date, 'date') });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_MILESTONE', entityType: 'MILESTONE', entityId: m.id, content: b });
  events.emitAsync('milestone.created', { workspaceId: req.workspace.id, actorId: req.user.id, milestoneId: m.id, projectId: m.project_id });
  res.status(201).json(milestoneDto(m));
});

router.put('/milestones/:id', async (req, res) => {
  const m = await loadMilestone(req.workspace.id, req.params.id);
  const b = parse(milestoneSchema.partial(), req.body);
  req.ctx.requireProjectManager(m.project_id);
  if (b.projectId && b.projectId !== m.project_id) await assertProject(req.ctx, b.projectId);
  const updated = await one('UPDATE scheduling_milestones SET project_id = $2, name = $3, date = $4 WHERE id = $1 RETURNING *', [m.id, b.projectId || m.project_id, b.name || m.name, b.date ? toDateOnly(b.date, 'date') : dateStr(m.date)]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_MILESTONE', entityType: 'MILESTONE', entityId: m.id, content: b, previous: milestoneDto(m) });
  events.emitAsync('milestone.updated', { workspaceId: req.workspace.id, actorId: req.user.id, milestoneId: m.id, projectId: updated.project_id });
  res.json(milestoneDto(updated));
});

router.delete('/milestones/:id', async (req, res) => {
  const m = await loadMilestone(req.workspace.id, req.params.id);
  req.ctx.requireProjectManager(m.project_id);
  await query('DELETE FROM scheduling_milestones WHERE id = $1', [m.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_MILESTONE', entityType: 'MILESTONE', entityId: m.id, previous: milestoneDto(m) });
  events.emitAsync('milestone.deleted', { workspaceId: req.workspace.id, actorId: req.user.id, milestoneId: m.id, projectId: m.project_id });
  res.json(milestoneDto(m));
});

export default {
  name: 'scheduling',
  workspace(ws) { ws.use('/scheduling', router); },
};
