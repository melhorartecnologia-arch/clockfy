import { Router } from 'express';
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, paging, sort, list } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { tagDto } from '../../lib/dto.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';

export const router = Router({ mergeParams: true });

// Name clash: an inactive tag keeps its name, so the message says where to find it
async function assertNameFree(workspaceId, name, exceptId = null) {
  const dup = await one('SELECT name, archived FROM tags WHERE workspace_id = $1 AND lower(name) = lower($2) AND ($3::text IS NULL OR id <> $3)', [workspaceId, name, exceptId]);
  if (!dup) return;
  throw badRequest(dup.archived
    ? `Já existe uma etiqueta inativa chamada “${dup.name}”. Um administrador pode reativá-la em Etiquetas.`
    : `Já existe uma etiqueta chamada “${dup.name}”.`, 501);
}

// Records that use each tag (deleted records excluded) – helps deciding what to inactivate
async function usageOf(workspaceId, tagIds) {
  if (!tagIds.length) return new Map();
  const list = await rows(`SELECT tt.tag_id, count(*)::int AS entries, max(e.start_time) AS last_used
                             FROM time_entry_tags tt JOIN time_entries e ON e.id = tt.time_entry_id
                            WHERE e.workspace_id = $1 AND e.deleted_at IS NULL AND tt.tag_id = ANY($2) GROUP BY tt.tag_id`, [workspaceId, tagIds]);
  return new Map(list.map((u) => [u.tag_id, { entries: u.entries, lastUsed: u.last_used }]));
}

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
  if (!bool(req.query['include-usage'], false)) return res.json(tags.map(tagDto));
  const usage = await usageOf(req.workspace.id, tags.map((t) => t.id));
  res.json(tags.map((t) => ({ ...tagDto(t), usage: usage.get(t.id) || { entries: 0, lastUsed: null } })));
});

router.get('/:id', async (req, res) => res.json(tagDto(await getTag(req.workspace.id, req.params.id))));

router.post('/', async (req, res) => {
  if (!req.ctx.canCreate('tag')) throw forbidden('You are not allowed to create tags', 403);
  const { name, archived } = parse(z.object({ name: z.string().min(1).max(100), archived: z.boolean().optional() }), req.body);
  await assertNameFree(req.workspace.id, name);
  const t = await insert('tags', { id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name, archived: !!archived });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_TAG', entityType: 'TAG', entityId: t.id, content: { name } });
  events.emitAsync('tag.created', { workspaceId: req.workspace.id, actorId: req.user.id, tagId: t.id });
  res.status(201).json(tagDto(t));
});

// Activate or inactivate several tags at once (standardisation of the tag list). Inactive tags stay on the records that
// already use them but can no longer be added to any record.
router.post('/bulk-status', async (req, res) => {
  req.ctx.requireAdmin();
  const { tagIds, archived } = parse(z.object({ tagIds: z.array(z.string()).min(1).max(5000), archived: z.boolean() }), req.body);
  const changed = await transaction(async () => {
    const list = await rows('SELECT * FROM tags WHERE workspace_id = $1 AND id = ANY($2) AND archived <> $3 FOR UPDATE', [req.workspace.id, [...new Set(tagIds)], archived]);
    const out = [];
    for (const prev of list) {
      const t = await one('UPDATE tags SET archived = $2 WHERE id = $1 RETURNING *', [prev.id, archived]);
      await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_TAG', entityType: 'TAG', entityId: t.id, content: { archived }, previous: tagDto(prev) });
      out.push(t);
    }
    return out;
  });
  for (const t of changed) events.emitAsync('tag.updated', { workspaceId: req.workspace.id, actorId: req.user.id, tagId: t.id });
  res.json({ updated: changed.map(tagDto) });
});

router.put('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const prev = await getTag(req.workspace.id, req.params.id);
  const { name, archived } = parse(z.object({ name: z.string().min(1).max(100).optional(), archived: z.boolean().optional() }), req.body);
  if (name) await assertNameFree(req.workspace.id, name, prev.id);
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
