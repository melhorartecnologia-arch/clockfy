import { Router } from 'express';
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, paging, sort } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { clientDto } from '../../lib/dto.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';

export const router = Router({ mergeParams: true });

const clientSchema = z.object({
  name: z.string().min(1).max(250),
  address: z.string().max(1000).nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
  ccEmails: z.array(z.string().email()).optional(),
  note: z.string().max(2000).nullable().optional(),
  currencyId: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});

export async function getClient(workspaceId, id) {
  const c = await one('SELECT c.*, cur.code AS currency_code FROM clients c LEFT JOIN workspace_currencies cur ON cur.id = c.currency_id WHERE c.id = $1 AND c.workspace_id = $2', [id, workspaceId]);
  if (!c) throw notFound('Client not found', 404);
  return c;
}

router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = sort(req.query, ['NAME', 'ID'], 'NAME');
  const conds = ['c.workspace_id = $1']; const params = [req.workspace.id];
  if (req.query.archived !== undefined && req.query.archived !== '') { params.push(bool(req.query.archived, false)); conds.push(`c.archived = $${params.length}`); }
  if (req.query.name) { params.push(`%${String(req.query.name).toLowerCase()}%`); conds.push(`lower(c.name) LIKE $${params.length}`); }
  params.push(limit, offset);
  const list = await rows(`SELECT c.*, cur.code AS currency_code FROM clients c LEFT JOIN workspace_currencies cur ON cur.id = c.currency_id WHERE ${conds.join(' AND ')} ORDER BY ${s.column === 'ID' ? 'c.id' : 'lower(c.name)'} ${s.order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(list.map((c) => clientDto(c)));
});

router.get('/:id', async (req, res) => {
  res.json(clientDto(await getClient(req.workspace.id, req.params.id)));
});

router.post('/', async (req, res) => {
  if (!req.ctx.canCreate('client')) throw forbidden('You are not allowed to create clients', 403);
  const body = parse(clientSchema, req.body);
  const dup = await one('SELECT 1 FROM clients WHERE workspace_id = $1 AND lower(name) = lower($2)', [req.workspace.id, body.name]);
  if (dup) throw badRequest('A client with this name already exists', 501);
  const c = await insert('clients', { id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name: body.name, address: body.address || null, email: body.email || null, cc_emails: body.ccEmails || [], note: body.note || null, currency_id: body.currencyId || null, archived: !!body.archived });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_CLIENT', entityType: 'CLIENT', entityId: c.id, content: body });
  events.emitAsync('client.created', { workspaceId: req.workspace.id, actorId: req.user.id, clientId: c.id });
  res.status(201).json(clientDto(await getClient(req.workspace.id, c.id)));
});

router.put('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const prev = await getClient(req.workspace.id, req.params.id);
  const body = parse(clientSchema.partial(), req.body);
  if (body.name && body.name.toLowerCase() !== prev.name.toLowerCase()) {
    const dup = await one('SELECT 1 FROM clients WHERE workspace_id = $1 AND lower(name) = lower($2) AND id <> $3', [req.workspace.id, body.name, prev.id]);
    if (dup) throw badRequest('A client with this name already exists', 501);
  }
  await transaction(async () => {
    await query('UPDATE clients SET name = COALESCE($2, name), address = COALESCE($3, address), email = COALESCE($4, email), cc_emails = COALESCE($5, cc_emails), note = COALESCE($6, note), currency_id = COALESCE($7, currency_id), archived = COALESCE($8, archived) WHERE id = $1',
      [prev.id, body.name ?? null, body.address ?? null, body.email ?? null, body.ccEmails ? JSON.stringify(body.ccEmails) : null, body.note ?? null, body.currencyId ?? null, body.archived ?? null]);
    if (body.archived === true) {
      if (bool(req.query['archive-projects'], false)) {
        await query('UPDATE projects SET archived = true WHERE client_id = $1', [prev.id]);
        if (bool(req.query['mark-tasks-as-done'], false)) await query("UPDATE tasks SET status = 'DONE' WHERE project_id IN (SELECT id FROM projects WHERE client_id = $1)", [prev.id]);
      }
    }
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_CLIENT', entityType: 'CLIENT', entityId: prev.id, content: body, previous: clientDto(prev) });
  events.emitAsync('client.updated', { workspaceId: req.workspace.id, actorId: req.user.id, clientId: prev.id });
  res.json(clientDto(await getClient(req.workspace.id, prev.id)));
});

router.delete('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const c = await getClient(req.workspace.id, req.params.id);
  if (!c.archived) throw badRequest('Client must be archived before deleting', 400);
  await query('DELETE FROM clients WHERE id = $1', [c.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_CLIENT', entityType: 'CLIENT', entityId: c.id, previous: clientDto(c) });
  events.emitAsync('client.deleted', { workspaceId: req.workspace.id, actorId: req.user.id, clientId: c.id, client: clientDto(c) });
  res.json(clientDto(c));
});

export default router;
