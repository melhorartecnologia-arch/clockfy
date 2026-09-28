// Module "holidays" – workspace holidays (Clockify API compatible).
//   GET    /holidays?assigned-to=<userId>                 -> [HolidayDtoV1]
//   POST   /holidays                                      (admin) CreateHolidayRequestV1 -> HolidayDtoV1
//   GET    /holidays/in-period?assigned-to&start&end      -> [HolidayDtoV1] (annual holidays expanded per year)
//   GET    /holidays/:holidayId                           (extra, for the UI)
//   PUT    /holidays/:holidayId                           (admin) UpdateHolidayRequestV1 -> HolidayDtoV1
//   DELETE /holidays/:holidayId                           (admin) -> HolidayDtoV1
// Scheduler job "holiday-time-entries" (daily): creates HOLIDAY time entries for holidays with
// automaticTimeEntryCreation enabled (idempotent).
import { Router } from 'express';
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, dateOnly } from '../../lib/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { registerJob } from '../../scheduler.js';
import { toIso } from '../../lib/dates.js';
import {
  dateStr, toDateOnly, expandHolidays, holidayRowsForUserSql, holidaysForUser, holidayDatesForUser, holidayUserIds,
  resolveUserFilter, resolveGroupFilter, normalizeAutoEntry, runHolidayEntries, removeHolidayEntries,
} from './service.js';

export { holidaysForUser, holidayDatesForUser, runHolidayEntries };

export const router = Router({ mergeParams: true });

const filterSchema = z.object({
  ids: z.array(z.string()).optional(),
  contains: z.enum(['CONTAINS', 'DOES_NOT_CONTAIN', 'CONTAINS_ONLY']).optional(),
  status: z.string().optional(),
  statuses: z.array(z.string()).optional(),
}).nullable().optional();

const holidaySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  color: z.string().max(20).nullable().optional(),
  datePeriod: z.object({ startDate: dateOnly, endDate: dateOnly.optional() }),
  occursAnnually: z.boolean().optional(),
  everyoneIncludingNew: z.boolean().optional(),
  users: filterSchema,
  userGroups: filterSchema,
  automaticTimeEntryCreation: z.object({
    enabled: z.boolean().optional(),
    defaultEntities: z.object({ projectId: z.string().nullable().optional(), taskId: z.string().nullable().optional() }).nullable().optional(),
  }).nullable().optional(),
});

async function loadHoliday(workspaceId, id) {
  const h = await one('SELECT * FROM holidays WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!h) throw notFound('Holiday not found', 404);
  return h;
}

export async function holidaysDto(list) {
  if (!list.length) return [];
  const ids = [...new Set(list.map((h) => h.id))];
  const users = await rows('SELECT holiday_id, user_id FROM holiday_users WHERE holiday_id = ANY($1)', [ids]);
  const groups = await rows('SELECT holiday_id, group_id FROM holiday_groups WHERE holiday_id = ANY($1)', [ids]);
  return list.map((h) => {
    const atec = h.automatic_time_entry_creation || {};
    return {
      id: h.id,
      name: h.name,
      workspaceId: h.workspace_id,
      datePeriod: { startDate: h.startDate || dateStr(h.start_date), endDate: h.endDate || dateStr(h.end_date) },
      occursAnnually: !!h.occurs_annually,
      everyoneIncludingNew: !!h.everyone_including_new,
      userIds: users.filter((u) => u.holiday_id === h.id).map((u) => u.user_id),
      userGroupIds: groups.filter((g) => g.holiday_id === h.id).map((g) => g.group_id),
      automaticTimeEntryCreation: !!atec.enabled,
      projectId: h.project_id || atec.defaultEntities?.projectId || null,
      taskId: h.task_id || atec.defaultEntities?.taskId || null,
      color: h.color || null,
      createdAt: toIso(h.created_at),
    };
  });
}

async function holidayDto(h) {
  const [dto] = await holidaysDto([h]);
  return dto;
}

async function writeAssignees(holidayId, userIds, groupIds) {
  await query('DELETE FROM holiday_users WHERE holiday_id = $1', [holidayId]);
  await query('DELETE FROM holiday_groups WHERE holiday_id = $1', [holidayId]);
  for (const uid of userIds) await query('INSERT INTO holiday_users (holiday_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [holidayId, uid]);
  for (const gid of groupIds) await query('INSERT INTO holiday_groups (holiday_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [holidayId, gid]);
}

async function normalize(workspaceId, b, existing) {
  const startDate = toDateOnly(b.datePeriod.startDate, 'datePeriod.startDate');
  const endDate = toDateOnly(b.datePeriod.endDate || b.datePeriod.startDate, 'datePeriod.endDate');
  if (endDate < startDate) throw badRequest('datePeriod.endDate must not be before datePeriod.startDate', 400);
  const userIds = b.users !== undefined ? await resolveUserFilter(workspaceId, b.users) : null;
  const groupIds = b.userGroups !== undefined ? await resolveGroupFilter(workspaceId, b.userGroups) : null;
  let everyone = b.everyoneIncludingNew;
  if (everyone === undefined) everyone = existing ? existing.everyone_including_new : !((userIds && userIds.length) || (groupIds && groupIds.length));
  const atec = b.automaticTimeEntryCreation !== undefined ? await normalizeAutoEntry(workspaceId, b.automaticTimeEntryCreation) : undefined;
  return { startDate, endDate, userIds, groupIds, everyone, atec };
}

// Listing -------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const assignedTo = req.query['assigned-to'] || req.query.assignedTo;
  const params = [req.workspace.id];
  let cond = '';
  if (assignedTo) { params.push(assignedTo); cond = `AND ${holidayRowsForUserSql('h')}`; }
  const list = await rows(`SELECT h.* FROM holidays h WHERE h.workspace_id = $1 ${cond} ORDER BY h.start_date, lower(h.name)`, params);
  res.json(await holidaysDto(list));
});

router.get('/in-period', async (req, res) => {
  const assignedTo = req.query['assigned-to'] || req.query.assignedTo;
  if (!req.query.start || !req.query.end) throw badRequest('start and end are required', 400);
  const start = toDateOnly(req.query.start, 'start'); const end = toDateOnly(req.query.end, 'end');
  if (end < start) throw badRequest('end must not be before start', 400);
  const params = [req.workspace.id];
  let cond = '';
  if (assignedTo) { params.push(assignedTo); cond = `AND ${holidayRowsForUserSql('h')}`; }
  const list = await rows(`SELECT h.* FROM holidays h WHERE h.workspace_id = $1 ${cond}`, params);
  res.json(await holidaysDto(expandHolidays(list, start, end)));
});

router.get('/:holidayId', async (req, res) => res.json(await holidayDto(await loadHoliday(req.workspace.id, req.params.holidayId))));

// Writes (admin) -------------------------------------------------------------------
router.post('/', async (req, res) => {
  req.ctx.requireAdmin();
  const b = parse(holidaySchema, req.body);
  const n = await normalize(req.workspace.id, b);
  const h = await transaction(async () => {
    const created = await insert('holidays', {
      id: b.id && /^[a-f0-9]{24}$/.test(b.id) ? b.id : newId(), workspace_id: req.workspace.id, name: b.name, color: b.color || null,
      start_date: n.startDate, end_date: n.endDate, occurs_annually: !!b.occursAnnually, everyone_including_new: n.everyone,
      automatic_time_entry_creation: n.atec ?? null, project_id: n.atec?.defaultEntities.projectId || null, task_id: n.atec?.defaultEntities.taskId || null,
    });
    await writeAssignees(created.id, n.userIds || [], n.groupIds || []);
    return created;
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_HOLIDAY', entityType: 'HOLIDAY', entityId: h.id, content: b });
  events.emitAsync('holiday.created', { workspaceId: req.workspace.id, actorId: req.user.id, holidayId: h.id });
  if (n.atec?.enabled) await runHolidayEntries({ workspaceId: req.workspace.id });
  res.status(201).json(await holidayDto(h));
});

router.put('/:holidayId', async (req, res) => {
  req.ctx.requireAdmin();
  const h = await loadHoliday(req.workspace.id, req.params.holidayId);
  const b = parse(holidaySchema, req.body);
  const n = await normalize(req.workspace.id, b, h);
  const previous = await holidayDto(h);
  const updated = await transaction(async () => {
    const u = await one(
      `UPDATE holidays SET name = $2, color = $3, start_date = $4, end_date = $5, occurs_annually = $6, everyone_including_new = $7,
         automatic_time_entry_creation = CASE WHEN $8::boolean THEN $9::jsonb ELSE automatic_time_entry_creation END,
         project_id = CASE WHEN $8::boolean THEN $10 ELSE project_id END, task_id = CASE WHEN $8::boolean THEN $11 ELSE task_id END
       WHERE id = $1 RETURNING *`,
      [h.id, b.name, b.color === undefined ? h.color : (b.color || null), n.startDate, n.endDate, b.occursAnnually ?? h.occurs_annually, n.everyone,
        n.atec !== undefined, n.atec === undefined ? null : JSON.stringify(n.atec), n.atec?.defaultEntities.projectId || null, n.atec?.defaultEntities.taskId || null],
    );
    if (n.userIds !== null || n.groupIds !== null) {
      const currentUsers = (await rows('SELECT user_id FROM holiday_users WHERE holiday_id = $1', [h.id])).map((r) => r.user_id);
      const currentGroups = (await rows('SELECT group_id FROM holiday_groups WHERE holiday_id = $1', [h.id])).map((r) => r.group_id);
      await writeAssignees(h.id, n.userIds ?? currentUsers, n.groupIds ?? currentGroups);
    }
    return u;
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_HOLIDAY', entityType: 'HOLIDAY', entityId: h.id, content: b, previous });
  events.emitAsync('holiday.updated', { workspaceId: req.workspace.id, actorId: req.user.id, holidayId: h.id });
  if (updated.automatic_time_entry_creation?.enabled) await runHolidayEntries({ workspaceId: req.workspace.id });
  res.json(await holidayDto(updated));
});

router.delete('/:holidayId', async (req, res) => {
  req.ctx.requireAdmin();
  const h = await loadHoliday(req.workspace.id, req.params.holidayId);
  const dto = await holidayDto(h);
  await transaction(async () => {
    await removeHolidayEntries(h.id);
    await query('DELETE FROM holidays WHERE id = $1', [h.id]);
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_HOLIDAY', entityType: 'HOLIDAY', entityId: h.id, previous: dto });
  events.emitAsync('holiday.deleted', { workspaceId: req.workspace.id, actorId: req.user.id, holidayId: h.id, holiday: dto });
  res.json(dto);
});

registerJob('holiday-time-entries', 24 * 60 * 60 * 1000, () => runHolidayEntries());

export { holidayUserIds };
export default {
  name: 'holidays',
  workspace(ws) { ws.use('/holidays', router); },
};
