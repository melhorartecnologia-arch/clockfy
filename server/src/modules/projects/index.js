import { Router } from 'express';
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, list, paging, sort, rateSchema } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { projectDto } from '../../lib/dto.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { recordRateHistory, reapplyRates } from '../../lib/rates.js';
import { getProjectRow, getProjectDto, projectDurations, projectMemberships, setProjectMembers, normalizeTimeEstimate, normalizeBudgetEstimate, createTask, projectStatus } from './service.js';
import { isoToSeconds, secondsToIso } from '../../lib/duration.js';

export const router = Router({ mergeParams: true });

const estimateReq = z.object({ estimate: z.union([z.string(), z.number()]).optional(), type: z.enum(['AUTO', 'MANUAL']).optional(), active: z.boolean().optional(), includeNonBillable: z.boolean().optional(), includeExpenses: z.boolean().optional(), resetOption: z.enum(['WEEKLY', 'MONTHLY', 'YEARLY']).nullable().optional() });
const membershipReq = z.object({ userId: z.string(), hourlyRate: rateSchema.nullable().optional(), costRate: rateSchema.nullable().optional(), membershipType: z.string().optional(), membershipStatus: z.string().optional() });
const taskReq = z.object({ id: z.string().optional(), name: z.string().min(1), assigneeIds: z.array(z.string()).optional(), assigneeId: z.string().optional(), estimate: z.string().nullable().optional(), status: z.string().optional(), billable: z.boolean().optional(), budgetEstimate: z.number().optional(), userGroupIds: z.array(z.string()).optional(), hourlyRate: rateSchema.optional(), costRate: rateSchema.optional() });

const projectSchema = z.object({
  name: z.string().min(1).max(250),
  clientId: z.string().nullable().optional(),
  isPublic: z.boolean().optional(),
  public: z.boolean().optional(),
  estimate: estimateReq.optional(),
  timeEstimate: estimateReq.optional(),
  budgetEstimate: estimateReq.optional(),
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  note: z.string().max(5000).nullable().optional(),
  billable: z.boolean().optional(),
  hourlyRate: rateSchema.nullable().optional(),
  costRate: rateSchema.nullable().optional(),
  memberships: z.array(membershipReq).optional(),
  userGroupIds: z.array(z.string()).optional(),
  tasks: z.array(taskReq).optional(),
  archived: z.boolean().optional(),
  isTemplate: z.boolean().optional(),
  template: z.boolean().optional(),
});

const COLORS = ['#03A9F4', '#8BC34A', '#F44336', '#FF9800', '#9C27B0', '#3F51B5', '#009688', '#795548', '#E91E63', '#607D8B', '#FFC107', '#4CAF50'];

function normColor(c) { if (!c) return COLORS[Math.floor(Math.random() * COLORS.length)]; return (c.startsWith('#') ? c : `#${c}`).toUpperCase(); }

router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = sort(req.query, ['NAME', 'CLIENT_NAME', 'DURATION', 'BUDGET', 'PROGRESS', 'ID'], 'NAME');
  const conds = ['p.workspace_id = $1']; const params = [req.workspace.id];
  const q = req.query;
  if (q.archived !== undefined && q.archived !== '') { params.push(bool(q.archived, false)); conds.push(`p.archived = $${params.length}`); }
  if (q.billable !== undefined && q.billable !== '') { params.push(bool(q.billable, false)); conds.push(`p.billable = $${params.length}`); }
  if (q['is-template'] !== undefined && q['is-template'] !== '') { params.push(bool(q['is-template'], false)); conds.push(`p.is_template = $${params.length}`); }
  if (q.name) { params.push(bool(q['strict-name-search'], false) ? String(q.name).toLowerCase() : `%${String(q.name).toLowerCase()}%`); conds.push(`lower(p.name) LIKE $${params.length}`); }
  const clients = list(q.clients);
  if (clients.length) { params.push(clients); conds.push(`${bool(q['contains-client'], true) ? '' : 'NOT '}(p.client_id = ANY($${params.length}))`); }
  if (q['client-status'] && q['client-status'] !== 'ALL') { params.push(String(q['client-status']).toUpperCase() === 'ARCHIVED'); conds.push(`EXISTS (SELECT 1 FROM clients c WHERE c.id = p.client_id AND c.archived = $${params.length})`); }
  const users = list(q.users);
  if (users.length) {
    params.push(users);
    const sub = `EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND ((pm.target_type = 'USER' AND pm.target_id = ANY($${params.length})) OR (pm.target_type = 'USERGROUP' AND pm.target_id IN (SELECT group_id FROM user_group_members WHERE user_id = ANY($${params.length})))))`;
    conds.push(`${bool(q['contains-user'], true) ? '' : 'NOT '}${sub}`);
  }
  const groups = list(q.userGroups);
  if (groups.length) { params.push(groups); conds.push(`${bool(q['contains-group'], true) ? '' : 'NOT '}EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.target_type = 'USERGROUP' AND pm.target_id = ANY($${params.length}))`); }
  const access = String(q.access || '').toUpperCase();
  if (access === 'PUBLIC') conds.push('p.is_public = true');
  if (access === 'PRIVATE') conds.push('p.is_public = false');
  // Non-admins only see public projects or projects they are members of (or manage)
  if (!req.ctx.isAdmin) {
    params.push(req.user.id, [...req.ctx.managedProjects]);
    conds.push(`(p.is_public OR p.id = ANY($${params.length}) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND ((pm.target_type = 'USER' AND pm.target_id = $${params.length - 1}) OR (pm.target_type = 'USERGROUP' AND pm.target_id IN (SELECT group_id FROM user_group_members WHERE user_id = $${params.length - 1})))))`);
  }
  const orderMap = { NAME: 'lower(p.name)', CLIENT_NAME: 'lower(c.name)', DURATION: 'duration_seconds', ID: 'p.id', BUDGET: "(p.budget_estimate->>'estimate')::numeric", PROGRESS: 'duration_seconds' };
  params.push(limit, offset);
  const projects = await rows(
    `SELECT p.*, c.name AS client_name, EXISTS (SELECT 1 FROM project_favorites f WHERE f.project_id = p.id AND f.user_id = '${req.user.id}') AS favorite,
       (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(e.end_time, now()) - e.start_time))),0)::bigint FROM time_entries e WHERE e.project_id = p.id AND e.deleted_at IS NULL AND e.type = 'REGULAR') AS duration_seconds
     FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE ${conds.join(' AND ')} ORDER BY ${orderMap[s.column] || 'lower(p.name)'} ${s.order} NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const hydrated = bool(q.hydrated, false);
  const ids = projects.map((p) => p.id);
  const memberships = ids.length ? await rows('SELECT * FROM project_members WHERE project_id = ANY($1)', [ids]) : [];
  const out = [];
  for (const p of projects) {
    if (hydrated) { out.push(await getProjectDto(req.workspace.id, p.id, { hydrated: true, userId: req.user.id, currency: req.workspace.hourly_rate_currency })); continue; }
    const dto = projectDto(p, { memberships: memberships.filter((m) => m.project_id === p.id), currency: req.workspace.hourly_rate_currency });
    out.push(maskProjectRates(dto, req.ctx));
  }
  res.json(out);
});

function maskProjectRates(dto, ctx) {
  if (ctx.isAdmin || !ctx.settings.onlyAdminsSeeBillableRates || ctx.managedProjects.has(dto.id)) return dto;
  dto.hourlyRate = null; dto.costRate = null;
  dto.memberships = dto.memberships.map((m) => ({ ...m, hourlyRate: null, costRate: null }));
  dto.budgetEstimate = { ...dto.budgetEstimate, estimate: 0 };
  return dto;
}

router.get('/:projectId', async (req, res) => {
  const { canAccessProject } = await import('./service.js');
  if (!(await canAccessProject(req.ctx, req.params.projectId))) throw notFound('Project not found', 404);
  const dto = await getProjectDto(req.workspace.id, req.params.projectId, { hydrated: bool(req.query.hydrated, false), userId: req.user.id, currency: req.workspace.hourly_rate_currency });
  res.json(maskProjectRates(dto, req.ctx));
});

router.get('/:projectId/status', async (req, res) => {
  req.ctx.requireProjectManager(req.params.projectId);
  res.json(await projectStatus(req.workspace.id, req.params.projectId));
});

router.post('/', async (req, res) => {
  if (!req.ctx.canCreate('project')) throw forbidden('You are not allowed to create projects', 403);
  const b = parse(projectSchema, req.body);
  const dup = await one('SELECT 1 FROM projects WHERE workspace_id = $1 AND lower(name) = lower($2) AND client_id IS NOT DISTINCT FROM $3', [req.workspace.id, b.name, b.clientId || null]);
  if (dup) throw badRequest('A project with this name already exists for this client', 501);
  if (b.clientId) {
    const c = await one('SELECT 1 FROM clients WHERE id = $1 AND workspace_id = $2', [b.clientId, req.workspace.id]);
    if (!c) throw badRequest('Client not found', 400);
  }
  const s = req.ctx.settings;
  const timeEstimate = normalizeTimeEstimate(b.timeEstimate || b.estimate, { estimate: 'PT0S', type: 'AUTO', active: false, includeNonBillable: true, resetOption: null });
  const budgetEstimate = normalizeBudgetEstimate(b.budgetEstimate, { estimate: 0, type: 'AUTO', active: false, includeExpenses: false, resetOption: null });
  const project = await transaction(async () => {
    const p = await insert('projects', {
      id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name: b.name, client_id: b.clientId || null, color: normColor(b.color), note: b.note || null,
      billable: b.billable ?? !!s.defaultBillableProjects, is_public: b.isPublic ?? b.public ?? s.isProjectPublicByDefault !== false, archived: !!b.archived, is_template: !!(b.isTemplate ?? b.template),
      hourly_rate_amount: b.hourlyRate?.amount ?? null, hourly_rate_currency: b.hourlyRate?.currency ?? null, cost_rate_amount: b.costRate?.amount ?? null,
      estimate_type: timeEstimate.type, time_estimate: timeEstimate, budget_estimate: budgetEstimate,
    });
    for (const m of b.memberships || []) {
      await query("INSERT INTO project_members (project_id, target_type, target_id, hourly_rate_amount, hourly_rate_currency, cost_rate_amount) VALUES ($1,'USER',$2,$3,$4,$5) ON CONFLICT DO NOTHING", [p.id, m.userId, m.hourlyRate?.amount ?? null, m.hourlyRate?.currency ?? null, m.costRate?.amount ?? null]);
    }
    for (const gid of b.userGroupIds || []) await query("INSERT INTO project_members (project_id, target_type, target_id) VALUES ($1,'USERGROUP',$2) ON CONFLICT DO NOTHING", [p.id, gid]);
    if (!req.ctx.isAdmin) {
      // creator becomes project manager
      await query("INSERT INTO project_members (project_id, target_type, target_id, is_manager) VALUES ($1,'USER',$2,true) ON CONFLICT (project_id, target_type, target_id) DO UPDATE SET is_manager = true", [p.id, req.user.id]);
      await query("INSERT INTO roles (id, workspace_id, user_id, role, entity_id) VALUES ($1,$2,$3,'PROJECT_MANAGER',$4) ON CONFLICT DO NOTHING", [newId(), req.workspace.id, req.user.id, p.id]);
    }
    for (const t of b.tasks || []) await createTask(req.workspace.id, p.id, t);
    return p;
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_PROJECT', entityType: 'PROJECT', entityId: project.id, content: b });
  events.emitAsync('project.created', { workspaceId: req.workspace.id, actorId: req.user.id, projectId: project.id });
  res.status(201).json(await getProjectDto(req.workspace.id, project.id, { hydrated: true, userId: req.user.id, currency: req.workspace.hourly_rate_currency }));
});

router.post('/from-template', async (req, res) => {
  if (!req.ctx.canCreate('project')) throw forbidden('You are not allowed to create projects', 403);
  const b = parse(z.object({ name: z.string().min(1), templateProjectId: z.string(), clientId: z.string().nullable().optional(), color: z.string().optional(), isPublic: z.boolean().optional() }), req.body);
  const tpl = await getProjectRow(req.workspace.id, b.templateProjectId);
  const project = await transaction(async () => {
    const p = await insert('projects', {
      id: newId(), workspace_id: req.workspace.id, name: b.name, client_id: b.clientId === undefined ? tpl.client_id : b.clientId, color: normColor(b.color || tpl.color), note: tpl.note,
      billable: tpl.billable, is_public: b.isPublic ?? tpl.is_public, hourly_rate_amount: tpl.hourly_rate_amount, hourly_rate_currency: tpl.hourly_rate_currency, cost_rate_amount: tpl.cost_rate_amount,
      estimate_type: tpl.estimate_type, time_estimate: tpl.time_estimate, budget_estimate: tpl.budget_estimate, estimate_reset: tpl.estimate_reset,
    });
    await query('INSERT INTO project_members (project_id, target_type, target_id, hourly_rate_amount, hourly_rate_currency, cost_rate_amount, is_manager) SELECT $2, target_type, target_id, hourly_rate_amount, hourly_rate_currency, cost_rate_amount, is_manager FROM project_members WHERE project_id = $1', [tpl.id, p.id]);
    const tasks = await rows('SELECT * FROM tasks WHERE project_id = $1', [tpl.id]);
    for (const t of tasks) {
      const nt = await insert('tasks', { id: newId(), workspace_id: req.workspace.id, project_id: p.id, name: t.name, status: 'ACTIVE', estimate_seconds: t.estimate_seconds, budget_estimate: t.budget_estimate, billable: t.billable, hourly_rate_amount: t.hourly_rate_amount, hourly_rate_currency: t.hourly_rate_currency, cost_rate_amount: t.cost_rate_amount });
      await query('INSERT INTO task_assignees (task_id, user_id) SELECT $2, user_id FROM task_assignees WHERE task_id = $1', [t.id, nt.id]);
    }
    await query('INSERT INTO custom_field_project_defaults (custom_field_id, project_id, value, status) SELECT custom_field_id, $2, value, status FROM custom_field_project_defaults WHERE project_id = $1', [tpl.id, p.id]);
    return p;
  });
  events.emitAsync('project.created', { workspaceId: req.workspace.id, actorId: req.user.id, projectId: project.id });
  res.json(await getProjectDto(req.workspace.id, project.id, { hydrated: true, userId: req.user.id }));
});

router.put('/:projectId', async (req, res) => {
  req.ctx.requireProjectManager(req.params.projectId);
  const prev = await getProjectRow(req.workspace.id, req.params.projectId);
  const b = parse(projectSchema.partial(), req.body);
  if (b.name && (b.name.toLowerCase() !== prev.name.toLowerCase() || b.clientId !== undefined)) {
    const dup = await one('SELECT 1 FROM projects WHERE workspace_id = $1 AND lower(name) = lower($2) AND client_id IS NOT DISTINCT FROM $3 AND id <> $4', [req.workspace.id, b.name, b.clientId === undefined ? prev.client_id : (b.clientId || null), prev.id]);
    if (dup) throw badRequest('A project with this name already exists for this client', 501);
  }
  if ((b.hourlyRate || b.costRate || b.billable !== undefined) && !req.ctx.isAdmin && req.ctx.settings.onlyAdminsSeeBillableRates) throw forbidden('Only admins can change rates', 403);
  const timeEstimate = normalizeTimeEstimate(b.timeEstimate || b.estimate, prev.time_estimate || {});
  const budgetEstimate = normalizeBudgetEstimate(b.budgetEstimate, prev.budget_estimate || {});
  await transaction(async () => {
    await query(
      `UPDATE projects SET name = COALESCE($2, name), client_id = CASE WHEN $3::text IS NULL THEN client_id ELSE NULLIF($3, '') END, color = COALESCE($4, color), note = COALESCE($5, note), billable = COALESCE($6, billable), is_public = COALESCE($7, is_public), archived = COALESCE($8, archived), is_template = COALESCE($9, is_template),
         hourly_rate_amount = CASE WHEN $10::boolean THEN $11 ELSE hourly_rate_amount END, hourly_rate_currency = CASE WHEN $10::boolean THEN COALESCE($12, hourly_rate_currency) ELSE hourly_rate_currency END, cost_rate_amount = CASE WHEN $13::boolean THEN $14 ELSE cost_rate_amount END,
         time_estimate = $15, budget_estimate = $16, estimate_type = $17 WHERE id = $1`,
      [prev.id, b.name ?? null, b.clientId === undefined ? null : (b.clientId || ''), b.color ? normColor(b.color) : null, b.note ?? null, b.billable ?? null, b.isPublic ?? b.public ?? null, b.archived ?? null, b.isTemplate ?? b.template ?? null,
        b.hourlyRate !== undefined, b.hourlyRate?.amount ?? null, b.hourlyRate?.currency ?? null, b.costRate !== undefined, b.costRate?.amount ?? null,
        JSON.stringify(timeEstimate), JSON.stringify(budgetEstimate), timeEstimate.type || prev.estimate_type],
    );
    if (b.memberships) await setProjectMembers(prev.id, { replace: true, userIds: [] });
    for (const m of b.memberships || []) {
      await query("INSERT INTO project_members (project_id, target_type, target_id, hourly_rate_amount, hourly_rate_currency, cost_rate_amount) VALUES ($1,'USER',$2,$3,$4,$5) ON CONFLICT (project_id, target_type, target_id) DO UPDATE SET hourly_rate_amount = EXCLUDED.hourly_rate_amount, cost_rate_amount = EXCLUDED.cost_rate_amount", [prev.id, m.userId, m.hourlyRate?.amount ?? null, m.hourlyRate?.currency ?? null, m.costRate?.amount ?? null]);
    }
    if (b.userGroupIds) {
      await query("DELETE FROM project_members WHERE project_id = $1 AND target_type = 'USERGROUP'", [prev.id]);
      for (const gid of b.userGroupIds) await query("INSERT INTO project_members (project_id, target_type, target_id) VALUES ($1,'USERGROUP',$2) ON CONFLICT DO NOTHING", [prev.id, gid]);
    }
    if (b.archived === true) await query('UPDATE time_entries SET end_time = now() WHERE project_id = $1 AND end_time IS NULL AND deleted_at IS NULL', [prev.id]);
  });
  if (b.hourlyRate?.since || b.costRate?.since) await reapplyRates({ workspaceId: req.workspace.id, projectId: prev.id, since: b.hourlyRate?.since || b.costRate?.since });
  if (b.hourlyRate) await recordRateHistory({ workspaceId: req.workspace.id, entityType: 'PROJECT', entityId: prev.id, rateType: 'HOURLY', amount: b.hourlyRate.amount, currency: b.hourlyRate.currency, since: b.hourlyRate.since, createdBy: req.user.id });
  if (b.costRate) await recordRateHistory({ workspaceId: req.workspace.id, entityType: 'PROJECT', entityId: prev.id, rateType: 'COST', amount: b.costRate.amount, since: b.costRate.since, createdBy: req.user.id });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_PROJECT', entityType: 'PROJECT', entityId: prev.id, content: b, previous: projectDto(prev) });
  events.emitAsync('project.updated', { workspaceId: req.workspace.id, actorId: req.user.id, projectId: prev.id });
  res.json(await getProjectDto(req.workspace.id, prev.id, { userId: req.user.id, currency: req.workspace.hourly_rate_currency }));
});

router.patch('/:projectId/estimate', async (req, res) => {
  req.ctx.requireProjectManager(req.params.projectId);
  const prev = await getProjectRow(req.workspace.id, req.params.projectId);
  const b = parse(z.object({ timeEstimate: estimateReq.optional(), budgetEstimate: estimateReq.optional(), estimateReset: z.any().optional(), estimate: estimateReq.optional() }), req.body);
  const timeEstimate = normalizeTimeEstimate(b.timeEstimate || b.estimate, prev.time_estimate || {});
  const budgetEstimate = normalizeBudgetEstimate(b.budgetEstimate, prev.budget_estimate || {});
  await query('UPDATE projects SET time_estimate = $2, budget_estimate = $3, estimate_type = $4, estimate_reset = COALESCE($5, estimate_reset) WHERE id = $1', [prev.id, JSON.stringify(timeEstimate), JSON.stringify(budgetEstimate), timeEstimate.type || prev.estimate_type, b.estimateReset ? JSON.stringify(b.estimateReset) : null]);
  events.emitAsync('project.updated', { workspaceId: req.workspace.id, actorId: req.user.id, projectId: prev.id });
  res.json(await getProjectDto(req.workspace.id, prev.id, { userId: req.user.id }));
});

router.post('/:projectId/memberships', async (req, res) => {
  req.ctx.requireProjectManager(req.params.projectId);
  const p = await getProjectRow(req.workspace.id, req.params.projectId);
  const b = parse(z.object({ userIds: z.array(z.string()).optional(), userGroups: z.object({ ids: z.array(z.string()).optional() }).optional(), userGroupIds: z.array(z.string()).optional(), remove: z.boolean().optional() }), req.body);
  await setProjectMembers(p.id, { userIds: b.userIds || [], groupIds: b.userGroupIds || b.userGroups?.ids || [], remove: !!b.remove });
  events.emitAsync('project.updated', { workspaceId: req.workspace.id, actorId: req.user.id, projectId: p.id });
  res.json(await getProjectDto(req.workspace.id, p.id, { userId: req.user.id }));
});

router.patch('/:projectId/memberships', async (req, res) => {
  req.ctx.requireProjectManager(req.params.projectId);
  const p = await getProjectRow(req.workspace.id, req.params.projectId);
  const b = parse(z.object({ memberships: z.array(membershipReq), userGroups: z.object({ ids: z.array(z.string()).optional() }).optional(), userGroupIds: z.array(z.string()).optional() }), req.body);
  await transaction(async () => {
    await query("DELETE FROM project_members WHERE project_id = $1 AND target_type = 'USER'", [p.id]);
    for (const m of b.memberships) await query("INSERT INTO project_members (project_id, target_type, target_id, hourly_rate_amount, hourly_rate_currency, cost_rate_amount) VALUES ($1,'USER',$2,$3,$4,$5)", [p.id, m.userId, m.hourlyRate?.amount ?? null, m.hourlyRate?.currency ?? null, m.costRate?.amount ?? null]);
    const groups = b.userGroupIds || b.userGroups?.ids;
    if (groups) {
      await query("DELETE FROM project_members WHERE project_id = $1 AND target_type = 'USERGROUP'", [p.id]);
      for (const gid of groups) await query("INSERT INTO project_members (project_id, target_type, target_id) VALUES ($1,'USERGROUP',$2)", [p.id, gid]);
    }
  });
  events.emitAsync('project.updated', { workspaceId: req.workspace.id, actorId: req.user.id, projectId: p.id });
  res.json(await getProjectDto(req.workspace.id, p.id, { userId: req.user.id }));
});

router.patch('/:projectId/template', async (req, res) => {
  req.ctx.requireAdmin();
  const p = await getProjectRow(req.workspace.id, req.params.projectId);
  const { isTemplate } = parse(z.object({ isTemplate: z.boolean() }), req.body);
  await query('UPDATE projects SET is_template = $2 WHERE id = $1', [p.id, isTemplate]);
  res.json(await getProjectDto(req.workspace.id, p.id, { userId: req.user.id }));
});

async function memberRate(req, res, kind) {
  req.ctx.requireProjectManager(req.params.projectId);
  if (!req.ctx.isAdmin && req.ctx.settings.onlyAdminsSeeBillableRates) throw forbidden('Only admins can change rates', 403);
  const p = await getProjectRow(req.workspace.id, req.params.projectId);
  const { amount, since, currency } = parse(rateSchema, req.body);
  const col = kind === 'HOURLY' ? 'hourly_rate_amount' : 'cost_rate_amount';
  await query(`INSERT INTO project_members (project_id, target_type, target_id, ${col}, hourly_rate_currency) VALUES ($1,'USER',$2,$3,$4) ON CONFLICT (project_id, target_type, target_id) DO UPDATE SET ${col} = EXCLUDED.${col}, hourly_rate_currency = COALESCE(EXCLUDED.hourly_rate_currency, project_members.hourly_rate_currency)`, [p.id, req.params.userId, amount, currency || null]);
  await recordRateHistory({ workspaceId: req.workspace.id, entityType: 'PROJECT_USER', entityId: p.id, userId: req.params.userId, rateType: kind, amount, currency, since, createdBy: req.user.id });
  if (since) await reapplyRates({ workspaceId: req.workspace.id, projectId: p.id, userId: req.params.userId, since });
  events.emitAsync('rate.updated', { workspaceId: req.workspace.id, actorId: req.user.id, rateType: kind === 'HOURLY' ? 'BILLABLE' : 'COST', entity: 'PROJECT_USER', projectId: p.id, userId: req.params.userId });
  res.json(await getProjectDto(req.workspace.id, p.id, { userId: req.user.id }));
}
router.put('/:projectId/users/:userId/hourly-rate', (req, res) => memberRate(req, res, 'HOURLY'));
router.put('/:projectId/users/:userId/cost-rate', (req, res) => memberRate(req, res, 'COST'));

router.delete('/:projectId', async (req, res) => {
  req.ctx.requireProjectManager(req.params.projectId);
  const p = await getProjectRow(req.workspace.id, req.params.projectId);
  if (!p.archived) throw badRequest('Project must be archived before deleting', 400);
  const dto = await getProjectDto(req.workspace.id, p.id);
  await query('DELETE FROM projects WHERE id = $1', [p.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_PROJECT', entityType: 'PROJECT', entityId: p.id, previous: dto });
  events.emitAsync('project.deleted', { workspaceId: req.workspace.id, actorId: req.user.id, projectId: p.id, project: dto });
  res.json(dto);
});

// Favorites --------------------------------------------------------------------
router.post('/:projectId/favorite', async (req, res) => {
  await query('INSERT INTO project_favorites (user_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.projectId]);
  res.json({ ok: true, favorite: true });
});
router.delete('/:projectId/favorite', async (req, res) => {
  await query('DELETE FROM project_favorites WHERE user_id = $1 AND project_id = $2', [req.user.id, req.params.projectId]);
  res.json({ ok: true, favorite: false });
});

export default router;
