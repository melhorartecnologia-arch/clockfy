import { Router } from 'express';
import { one, rows, query, insert } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, paging, sort, list } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { tagDto } from '../../lib/dto.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';

export const router = Router({ mergeParams: true });

async function getTag(workspaceId, id) {
  const t = await one('SELECT * FROM tags WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!t) throw notFound('Tag not found', 404);
  return t;
}

router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = sort(req.query, ['NAME', 'ID'], 'NAME');
  const conds = ['workspace_id = $1']; const params = [req.workspace.id];
  if (req.query.archived !== undefined && req.query.archived !== '') { params.push(bool(req.query.archived, false)); conds.push(`archived = $${params.length}`); }
  if (req.query.name) {
    params.push(bool(req.query['strict-name-search'], false) ? String(req.query.name).toLowerCase() : `%${String(req.query.name).toLowerCase()}%`);
    conds.push(`lower(name) LIKE $${params.length}`);
  }
  const excluded = list(req.query['excluded-ids']);
  if (excluded.length) { params.push(excluded); conds.push(`NOT (id = ANY($${params.length}))`); }
  params.push(limit, offset);
  const tags = await rows(`SELECT * FROM tags WHERE ${conds.join(' AND ')} ORDER BY ${s.column === 'ID' ? 'id' : 'lower(name)'} ${s.order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(tags.map(tagDto));
});

router.get('/:id', async (req, res) => res.json(tagDto(await getTag(req.workspace.id, req.params.id))));

router.post('/', async (req, res) => {
  if (!req.ctx.canCreate('tag')) throw forbidden('You are not allowed to create tags', 403);
  const { name, archived } = parse(z.object({ name: z.string().min(1).max(100), archived: z.boolean().optional() }), req.body);
  const dup = await one('SELECT 1 FROM tags WHERE workspace_id = $1 AND lower(name) = lower($2)', [req.workspace.id, name]);
  if (dup) throw badRequest('A tag with this name already exists', 501);
  const t = await insert('tags', { id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name, archived: !!archived });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_TAG', entityType: 'TAG', entityId: t.id, content: { name } });
  events.emitAsync('tag.created', { workspaceId: req.workspace.id, actorId: req.user.id, tagId: t.id });
  res.status(201).json(tagDto(t));
});

router.put('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const prev = await getTag(req.workspace.id, req.params.id);
  const { name, archived } = parse(z.object({ name: z.string().min(1).max(100).optional(), archived: z.boolean().optional() }), req.body);
  if (name) {
    const dup = await one('SELECT 1 FROM tags WHERE workspace_id = $1 AND lower(name) = lower($2) AND id <> $3', [req.workspace.id, name, prev.id]);
    if (dup) throw badRequest('A tag with this name already exists', 501);
  }
  const t = await one('UPDATE tags SET name = COALESCE($2, name), archived = COALESCE($3, archived) WHERE id = $1 RETURNING *', [prev.id, name ?? null, archived ?? null]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_TAG', entityType: 'TAG', entityId: t.id, content: { name, archived }, previous: tagDto(prev) });
  events.emitAsync('tag.updated', { workspaceId: req.workspace.id, actorId: req.user.id, tagId: t.id });
  res.json(tagDto(t));
});

router.delete('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const t = await getTag(req.workspace.id, req.params.id);
  await query('DELETE FROM tags WHERE id = $1', [t.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_TAG', entityType: 'TAG', entityId: t.id, previous: tagDto(t) });
  events.emitAsync('tag.deleted', { workspaceId: req.workspace.id, actorId: req.user.id, tagId: t.id, tag: tagDto(t) });
  res.json(tagDto(t));
});

export default router;
