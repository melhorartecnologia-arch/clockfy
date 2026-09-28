import { Router } from 'express';
import { one, rows, query, transaction } from '../../lib/db.js';
import { parse, z, bool, list, paging } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { parseDate } from '../../lib/dates.js';
import { loadEntry, entryDto, entriesDto, createEntry, updateEntry, deleteEntry, stopRunning, listEntries, canManageEntriesOf, assertCanEdit } from './service.js';
import { visibleUserIds } from '../../middleware/workspace.js';
import { resolveRates } from '../../lib/rates.js';
import { isoToSeconds } from '../../lib/duration.js';
import { newId } from '../../lib/ids.js';

export const router = Router({ mergeParams: true });      // /workspaces/:workspaceId/time-entries
export const userRouter = Router({ mergeParams: true });  // /workspaces/:workspaceId/user/:userId/time-entries

const cfValue = z.object({ customFieldId: z.string(), value: z.any(), sourceType: z.string().optional() });
const entrySchema = z.object({
  id: z.string().optional(),
  start: z.string().or(z.date()),
  end: z.string().or(z.date()).nullable().optional(),
  billable: z.boolean().optional(),
  description: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).nullable().optional(),
  customFields: z.array(cfValue).optional(),
  customAttributes: z.array(cfValue).optional(),
  type: z.enum(['REGULAR', 'BREAK']).optional(),
  timeZone: z.string().optional(),
  duration: z.union([z.string(), z.number()]).optional(),
});
const patchSchema = entrySchema.partial();

function applyDuration(b) {
  if (b.duration != null && b.start && !b.end) {
    b.end = new Date(new Date(b.start).getTime() + isoToSeconds(b.duration) * 1000).toISOString();
  }
  return b;
}

async function respondEntry(req, res, entry, status = 200) {
  res.status(status).json(await entryDto(entry, { ctx: req.ctx, hydrated: bool(req.query.hydrated, false) }));
}

// ---- /workspaces/:workspaceId/time-entries -----------------------------------
router.post('/', async (req, res) => {
  const b = applyDuration(parse(entrySchema, req.body));
  const entry = await createEntry(req.ctx, req.user.id, b);
  await respondEntry(req, res, entry, 201);
});

router.get('/status/in-progress', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 1000 });
  const visible = await visibleUserIds(req.ctx);
  const params = [req.workspace.id]; let cond = '';
  if (visible) { params.push(visible); cond = 'AND e.user_id = ANY($2)'; }
  params.push(limit, offset);
  const l = await rows(`SELECT e.* FROM time_entries e WHERE e.workspace_id = $1 AND e.end_time IS NULL AND e.deleted_at IS NULL ${cond} ORDER BY e.start_time DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(await entriesDto(l, { ctx: req.ctx, hydrated: bool(req.query.hydrated, false) }));
});

router.patch('/invoiced', async (req, res) => {
  req.ctx.requireAdmin();
  const { timeEntryIds, invoiced } = parse(z.object({ timeEntryIds: z.array(z.string()).min(1), invoiced: z.boolean() }), req.body);
  await query('UPDATE time_entries SET invoiced = $3 WHERE workspace_id = $1 AND id = ANY($2)', [req.workspace.id, timeEntryIds, invoiced]);
  res.status(200).json({ ok: true });
});

// Listing across users (admins / managers) – convenient for team timesheets and the calendar
router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 200, max: 5000 });
  const visible = await visibleUserIds(req.ctx);
  const conds = ['e.workspace_id = $1', 'e.deleted_at IS NULL']; const params = [req.workspace.id];
  const users = list(req.query.users || req.query.user);
  if (users.length) { params.push(users); conds.push(`e.user_id = ANY($${params.length})`); }
  if (visible) { params.push(visible); conds.push(`e.user_id = ANY($${params.length})`); }
  if (req.query.start) { params.push(parseDate(req.query.start, 'start')); conds.push(`e.start_time >= $${params.length}`); }
  if (req.query.end) { params.push(parseDate(req.query.end, 'end')); conds.push(`e.start_time < $${params.length}`); }
  if (req.query.project) { params.push(req.query.project); conds.push(`e.project_id = $${params.length}`); }
  if (req.query.task) { params.push(req.query.task); conds.push(`e.task_id = $${params.length}`); }
  if (req.query.description) { params.push(`%${String(req.query.description).toLowerCase()}%`); conds.push(`lower(e.description) LIKE $${params.length}`); }
  params.push(limit, offset);
  const l = await rows(`SELECT e.* FROM time_entries e WHERE ${conds.join(' AND ')} ORDER BY e.start_time DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(await entriesDto(l, { ctx: req.ctx, hydrated: bool(req.query.hydrated, false) }));
});

router.get('/:id', async (req, res) => {
  const e = await loadEntry(req.workspace.id, req.params.id);
  if (!(await canManageEntriesOf(req.ctx, e.user_id, e.project_id))) {
    // members can still see entries on public projects if allowed by settings
    const p = e.project_id ? await one('SELECT is_public FROM projects WHERE id = $1', [e.project_id]) : null;
    if (!(p && p.is_public && !req.ctx.settings.onlyAdminsSeePublicProjectsEntries)) throw notFound('Time entry not found', 404);
  }
  await respondEntry(req, res, e);
});

async function putEntry(req, res) {
  const e = await loadEntry(req.workspace.id, req.params.id);
  const b = applyDuration(parse(req.method === 'PUT' ? entrySchema : patchSchema, req.body));
  const updated = await updateEntry(req.ctx, e, b);
  await respondEntry(req, res, updated);
}
router.put('/:id', putEntry);
router.patch('/:id', putEntry);

router.delete('/:id', async (req, res) => {
  const e = await loadEntry(req.workspace.id, req.params.id);
  await deleteEntry(req.ctx, e);
  res.status(204).end();
});

router.post('/:id/restore', async (req, res) => {
  req.ctx.requireAdmin();
  const e = await loadEntry(req.workspace.id, req.params.id, { includeDeleted: true });
  await query('UPDATE time_entries SET deleted_at = NULL WHERE id = $1', [e.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'RESTORE_TIME', entityType: 'TIME_ENTRY', entityId: e.id });
  events.emitAsync('time_entry.restored', { workspaceId: req.workspace.id, actorId: req.user.id, userId: e.user_id, entryId: e.id });
  await respondEntry(req, res, { ...e, deleted_at: null });
});

// Split an entry at a point in time: original keeps [start, at), new entry gets [at, end)
router.post('/:id/split', async (req, res) => {
  const e = await loadEntry(req.workspace.id, req.params.id);
  await assertCanEdit(req.ctx, e);
  const { time } = parse(z.object({ time: z.string() }), req.body);
  const at = parseDate(time, 'time');
  if (!e.end_time || at <= new Date(e.start_time) || at >= new Date(e.end_time)) throw badRequest('Split time must be within the entry interval', 400);
  const result = await transaction(async () => {
    await query('UPDATE time_entries SET end_time = $2 WHERE id = $1', [e.id, at]);
    const copy = await one(
      `INSERT INTO time_entries (id, workspace_id, user_id, project_id, task_id, description, start_time, end_time, billable, type, hourly_rate_amount, hourly_rate_currency, cost_rate_amount, time_zone, origin)
       SELECT $2, workspace_id, user_id, project_id, task_id, description, $3, $4, billable, type, hourly_rate_amount, hourly_rate_currency, cost_rate_amount, time_zone, origin FROM time_entries WHERE id = $1 RETURNING *`,
      [e.id, newId(), at, e.end_time],
    );
    await query('INSERT INTO time_entry_tags (time_entry_id, tag_id) SELECT $2, tag_id FROM time_entry_tags WHERE time_entry_id = $1', [e.id, copy.id]);
    await query("INSERT INTO custom_field_values (entity_type, entity_id, custom_field_id, workspace_id, value, source_type) SELECT 'TIMEENTRY', $2, custom_field_id, workspace_id, value, source_type FROM custom_field_values WHERE entity_type = 'TIMEENTRY' AND entity_id = $1", [e.id, copy.id]);
    return [await loadEntry(req.workspace.id, e.id), copy];
  });
  events.emitAsync('time_entry.split', { workspaceId: req.workspace.id, actorId: req.user.id, userId: e.user_id, entryId: e.id, newEntryId: result[1].id });
  res.json(await entriesDto(result, { ctx: req.ctx }));
});

// ---- /workspaces/:workspaceId/user/:userId/time-entries ------------------------
userRouter.get('/', async (req, res) => {
  const uid = req.params.userId;
  if (!(await canManageEntriesOf(req.ctx, uid)) && req.ctx.settings.onlyAdminsSeeAllTimeEntries !== false) {
    if (uid !== req.user.id) throw forbidden("You can't see this user's time entries", 403);
  }
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const q = req.query;
  const out = await listEntries(req.ctx, uid, {
    description: q.description, start: q.start, end: q.end, project: q.project, task: q.task, tags: list(q.tags),
    projectRequired: bool(q['project-required'], false), taskRequired: bool(q['task-required'], false), hydrated: bool(q.hydrated, false),
    inProgress: q['in-progress'] === undefined || q['in-progress'] === '' ? undefined : bool(q['in-progress'], false), getWeekBefore: bool(q['get-week-before'], false), type: q.type, limit, offset,
  });
  res.json(out);
});

userRouter.post('/', async (req, res) => {
  const b = applyDuration(parse(entrySchema, req.body));
  const entry = await createEntry(req.ctx, req.params.userId, b);
  await respondEntry(req, res, entry, 201);
});

// Stop the running timer
userRouter.patch('/', async (req, res) => {
  const uid = req.params.userId;
  if (!(await canManageEntriesOf(req.ctx, uid))) throw forbidden("You can't stop this user's timer", 403);
  const { end } = parse(z.object({ end: z.string().optional() }), req.body || {});
  const stopped = await stopRunning(req.ctx, uid, end);
  if (!stopped) throw notFound('No running timer', 404);
  await respondEntry(req, res, stopped);
});

// Bulk edit: body is an array of time entries (each with id) or {timeEntryIds, ...changes}
userRouter.put('/', async (req, res) => {
  const uid = req.params.userId;
  const body = req.body;
  const items = Array.isArray(body) ? body : (body && body.timeEntryIds ? body.timeEntryIds.map((id) => ({ ...body, id, timeEntryIds: undefined })) : null);
  if (!items || !items.length) throw badRequest('Body must be a non-empty array of time entries', 400);
  const out = [];
  await transaction(async () => {
    for (const item of items) {
      const b = applyDuration(parse(patchSchema, item));
      const e = await loadEntry(req.workspace.id, item.id);
      if (e.user_id !== uid) throw badRequest(`Time entry ${e.id} does not belong to user ${uid}`, 400);
      out.push(await updateEntry(req.ctx, e, b));
    }
  });
  res.json(await entriesDto(out, { ctx: req.ctx, hydrated: bool(req.query.hydrated, false) }));
});

userRouter.delete('/', async (req, res) => {
  const uid = req.params.userId;
  const ids = list(req.query['time-entry-ids'] || req.body?.timeEntryIds);
  if (!ids.length) throw badRequest('time-entry-ids is required', 400);
  const deleted = [];
  for (const id of ids) {
    const e = await loadEntry(req.workspace.id, id);
    if (e.user_id !== uid) throw badRequest(`Time entry ${id} does not belong to user ${uid}`, 400);
    deleted.push(await deleteEntry(req.ctx, e));
  }
  res.json(deleted);
});

userRouter.post('/:id/duplicate', async (req, res) => {
  const uid = req.params.userId;
  const e = await loadEntry(req.workspace.id, req.params.id);
  if (e.user_id !== uid) throw badRequest('Time entry does not belong to this user', 400);
  if (!(await canManageEntriesOf(req.ctx, uid, e.project_id))) throw forbidden();
  const tags = await rows('SELECT tag_id FROM time_entry_tags WHERE time_entry_id = $1', [e.id]);
  const cfs = await rows("SELECT custom_field_id, value FROM custom_field_values WHERE entity_type = 'TIMEENTRY' AND entity_id = $1", [e.id]);
  const copy = await createEntry(req.ctx, uid, {
    start: e.start_time, end: e.end_time, description: e.description, projectId: e.project_id, taskId: e.task_id, billable: e.billable, type: e.type,
    tagIds: tags.map((t) => t.tag_id), customFields: cfs.map((c) => ({ customFieldId: c.custom_field_id, value: c.value })),
  });
  await respondEntry(req, res, copy, 201);
});

// Convenience: currently running timer of a user
userRouter.get('/running', async (req, res) => {
  const uid = req.params.userId;
  if (!(await canManageEntriesOf(req.ctx, uid))) throw forbidden();
  const running = await one('SELECT * FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND end_time IS NULL AND deleted_at IS NULL', [req.workspace.id, uid]);
  res.json(running ? await entryDto(running, { ctx: req.ctx, hydrated: bool(req.query.hydrated, true) }) : null);
});

// Convenience: continue an entry (start a new timer with the same data)
userRouter.post('/:id/continue', async (req, res) => {
  const uid = req.params.userId;
  const e = await loadEntry(req.workspace.id, req.params.id);
  if (e.user_id !== uid) throw badRequest('Time entry does not belong to this user', 400);
  const tags = await rows('SELECT tag_id FROM time_entry_tags WHERE time_entry_id = $1', [e.id]);
  const cfs = await rows("SELECT custom_field_id, value FROM custom_field_values WHERE entity_type = 'TIMEENTRY' AND entity_id = $1", [e.id]);
  const copy = await createEntry(req.ctx, uid, {
    start: new Date().toISOString(), end: null, description: e.description, projectId: e.project_id, taskId: e.task_id, billable: e.billable, type: e.type,
    tagIds: tags.map((t) => t.tag_id), customFields: cfs.map((c) => ({ customFieldId: c.custom_field_id, value: c.value })),
  });
  await respondEntry(req, res, copy, 201);
});

export { resolveRates };
export default router;
