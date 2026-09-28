import { Router } from 'express';
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, paging, sort } from '../../lib/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { userGroupDto } from '../../lib/dto.js';
import { events } from '../../lib/events.js';

export const router = Router({ mergeParams: true });

export async function groupDto(workspaceId, g, includeManagers = true) {
  const members = await rows('SELECT user_id FROM user_group_members WHERE group_id = $1', [g.id]);
  const managers = includeManagers ? await rows("SELECT u.id, u.name FROM roles r JOIN users u ON u.id = r.user_id WHERE r.workspace_id = $1 AND r.role = 'TEAM_MANAGER' AND r.entity_id = $2", [workspaceId, g.id]) : [];
  return userGroupDto(g, { userIds: members.map((m) => m.user_id), teamManagers: managers.map((m) => ({ id: m.id, name: m.name })) });
}

async function getGroup(workspaceId, id) {
  const g = await one('SELECT * FROM user_groups WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!g) throw notFound('User group not found', 404);
  return g;
}

router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = sort(req.query, ['NAME', 'ID'], 'NAME');
  const conds = ['g.workspace_id = $1']; const params = [req.workspace.id];
  if (req.query.name) { params.push(`%${String(req.query.name).toLowerCase()}%`); conds.push(`lower(g.name) LIKE $${params.length}`); }
  if (req.query['project-id']) { params.push(req.query['project-id']); conds.push(`EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $${params.length} AND pm.target_type = 'USERGROUP' AND pm.target_id = g.id)`); }
  params.push(limit, offset);
  const groups = await rows(`SELECT g.* FROM user_groups g WHERE ${conds.join(' AND ')} ORDER BY ${s.column === 'ID' ? 'g.id' : 'lower(g.name)'} ${s.order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const includeManagers = bool(req.query.includeTeamManagers, true);
  res.json(await Promise.all(groups.map((g) => groupDto(req.workspace.id, g, includeManagers))));
});

router.get('/:id', async (req, res) => res.json(await groupDto(req.workspace.id, await getGroup(req.workspace.id, req.params.id))));

router.post('/', async (req, res) => {
  req.ctx.requireAdmin();
  const { name, userIds } = parse(z.object({ name: z.string().min(1).max(100), userIds: z.array(z.string()).optional() }), req.body);
  const dup = await one('SELECT 1 FROM user_groups WHERE workspace_id = $1 AND lower(name) = lower($2)', [req.workspace.id, name]);
  if (dup) throw badRequest('A group with this name already exists', 501);
  const g = await transaction(async () => {
    const created = await insert('user_groups', { id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name });
    for (const uid of userIds || []) await query('INSERT INTO user_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [created.id, uid]);
    return created;
  });
  events.emitAsync('user_group.created', { workspaceId: req.workspace.id, actorId: req.user.id, groupId: g.id });
  res.status(201).json(await groupDto(req.workspace.id, g));
});

router.put('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const g = await getGroup(req.workspace.id, req.params.id);
  const { name, userIds } = parse(z.object({ name: z.string().min(1).max(100).optional(), userIds: z.array(z.string()).optional() }), req.body);
  await transaction(async () => {
    if (name) await query('UPDATE user_groups SET name = $2 WHERE id = $1', [g.id, name]);
    if (userIds) {
      await query('DELETE FROM user_group_members WHERE group_id = $1', [g.id]);
      for (const uid of userIds) await query('INSERT INTO user_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.id, uid]);
    }
  });
  events.emitAsync('user_group.updated', { workspaceId: req.workspace.id, actorId: req.user.id, groupId: g.id });
  res.json(await groupDto(req.workspace.id, await getGroup(req.workspace.id, g.id)));
});

router.delete('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const g = await getGroup(req.workspace.id, req.params.id);
  const dto = await groupDto(req.workspace.id, g);
  await query('DELETE FROM user_groups WHERE id = $1', [g.id]);
  await query("DELETE FROM roles WHERE workspace_id = $1 AND role = 'TEAM_MANAGER' AND entity_id = $2", [req.workspace.id, g.id]);
  events.emitAsync('user_group.deleted', { workspaceId: req.workspace.id, actorId: req.user.id, groupId: g.id, group: dto });
  res.json(dto);
});

router.post('/:userGroupId/users', async (req, res) => {
  req.ctx.requireAdmin();
  const g = await getGroup(req.workspace.id, req.params.userGroupId);
  const { userId, userIds } = parse(z.object({ userId: z.string().optional(), userIds: z.array(z.string()).optional() }), req.body);
  const ids = userIds || (userId ? [userId] : []);
  if (!ids.length) throw badRequest('userId is required', 400);
  for (const uid of ids) {
    const m = await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [req.workspace.id, uid]);
    if (!m) throw badRequest(`User ${uid} is not a member of this workspace`, 400);
    await query('INSERT INTO user_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.id, uid]);
  }
  events.emitAsync('user_group.updated', { workspaceId: req.workspace.id, actorId: req.user.id, groupId: g.id });
  res.json(await groupDto(req.workspace.id, g));
});

router.delete('/:userGroupId/users/:userId', async (req, res) => {
  req.ctx.requireAdmin();
  const g = await getGroup(req.workspace.id, req.params.userGroupId);
  await query('DELETE FROM user_group_members WHERE group_id = $1 AND user_id = $2', [g.id, req.params.userId]);
  events.emitAsync('user_group.updated', { workspaceId: req.workspace.id, actorId: req.user.id, groupId: g.id });
  res.json(await groupDto(req.workspace.id, g));
});

export default router;
