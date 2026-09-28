// Scheduling: assignments (single and recurring series), publishing, totals per project/user and milestones.
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { toIso, eachDay, addDaysLocal, daysBetween } from '../../lib/dates.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { visibleUserIds } from '../../middleware/workspace.js';
import { dateStr, toDateOnly, dateToIso, memberCalendars, holidayDatesForUser, isWorkingDay, notifyWithMail } from '../holidays/service.js';
import { approvedTimeOffDates } from '../timeOff/service.js';

export const SERIES_OPTIONS = ['THIS_ONE', 'THIS_AND_FOLLOWING', 'ALL'];
export const ASSIGNMENT_SQL = `SELECT a.*, p.name AS project_name, p.color AS project_color, p.archived AS project_archived, p.billable AS project_billable, p.client_id, c.name AS client_name,
    t.name AS task_name, u.name AS user_name, u.profile_picture AS user_image
  FROM scheduling_assignments a JOIN projects p ON p.id = a.project_id LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN tasks t ON t.id = a.task_id JOIN users u ON u.id = a.user_id`;

export async function loadAssignment(workspaceId, id) {
  const a = await one(`${ASSIGNMENT_SQL} WHERE a.id = $1 AND a.workspace_id = $2`, [id, workspaceId]);
  if (!a) throw notFound('Assignment not found', 404);
  return a;
}

export async function loadMany(workspaceId, ids) {
  if (!ids.length) return [];
  return rows(`${ASSIGNMENT_SQL} WHERE a.workspace_id = $1 AND a.id = ANY($2) ORDER BY a.start_date, a.id`, [workspaceId, ids]);
}

// Visibility: admins see everything; project managers see their projects; everyone else only published assignments of visible users
export async function visibilitySql(ctx, params) {
  if (ctx.isAdmin) return null;
  const visible = await visibleUserIds(ctx);
  params.push(visible, [...ctx.managedProjects]);
  return `((a.published AND a.user_id = ANY($${params.length - 1})) OR a.project_id = ANY($${params.length}))`;
}

export async function canSee(ctx, a) {
  if (ctx.managesProject(a.project_id)) return true;
  if (!a.published) return false;
  if (a.user_id === ctx.user.id) return true;
  const visible = await visibleUserIds(ctx);
  return !visible || visible.includes(a.user_id);
}

// Day context (calendars, holidays and approved time off) for users within a period ----------------------
export async function buildDayContext(workspaceId, userIds, startDate, endDate) {
  const ids = [...new Set(userIds)];
  const cals = await memberCalendars(workspaceId, ids);
  const timeOff = await approvedTimeOffDates(workspaceId, ids, startDate, endDate);
  const holidays = new Map();
  for (const uid of ids) holidays.set(uid, await holidayDatesForUser(workspaceId, uid, startDate, endDate));
  return { cals, holidays, timeOff, startDate, endDate };
}

export function dayExclusion(a, dc, date) {
  if (dc.timeOff.get(a.user_id)?.has(date)) return 'TIME_OFF';
  if (dc.holidays.get(a.user_id)?.has(date)) return 'HOLIDAY';
  const cal = dc.cals.get(a.user_id);
  if (cal && !a.include_non_working_days && !isWorkingDay(cal, date)) return 'WEEKEND';
  return null;
}

export function excludeDaysOf(a, dc) {
  const out = [];
  for (const d of eachDay(dateStr(a.start_date), dateStr(a.end_date))) {
    const type = dayExclusion(a, dc, d);
    if (type) out.push({ date: dateToIso(d), type });
  }
  return out;
}

// Dates on which the assignment actually schedules work, limited to [rangeStart, rangeEnd]
export function scheduledDates(a, dc, rangeStart, rangeEnd) {
  const s = dateStr(a.start_date); const e = dateStr(a.end_date);
  const from = rangeStart && rangeStart > s ? rangeStart : s;
  const to = rangeEnd && rangeEnd < e ? rangeEnd : e;
  if (to < from) return [];
  const out = [];
  for (const d of eachDay(from, to)) if (!dayExclusion(a, dc, d)) out.push(d);
  return out;
}

// DTOs ------------------------------------------------------------------------------------------
export function assignmentDto(a, dc, { hydrated = false } = {}) {
  const dto = {
    id: a.id,
    workspaceId: a.workspace_id,
    projectId: a.project_id,
    taskId: a.task_id || null,
    userId: a.user_id,
    period: { start: dateToIso(dateStr(a.start_date)), end: dateToIso(dateStr(a.end_date)) },
    hoursPerDay: Number(a.hours_per_day),
    startTime: a.start_time || null,
    includeNonWorkingDays: !!a.include_non_working_days,
    note: a.note || '',
    billable: a.billable == null ? !!a.project_billable : !!a.billable,
    published: !!a.published,
    recurring: { repeat: !!a.recurring_repeat, seriesId: a.series_id || null, weeks: a.recurring_weeks || 1 },
    excludeDays: dc ? excludeDaysOf(a, dc) : [],
    createdAt: toIso(a.created_at),
  };
  if (hydrated) {
    Object.assign(dto, {
      projectName: a.project_name, projectColor: a.project_color, projectArchived: !!a.project_archived, projectBillable: !!a.project_billable,
      clientId: a.client_id || '', clientName: a.client_name || '', taskName: a.task_name || null, userName: a.user_name, userImage: a.user_image || '',
    });
  }
  return dto;
}

export async function assignmentsDto(workspaceId, list, { hydrated = false } = {}) {
  if (!list.length) return [];
  let start = null; let end = null;
  for (const a of list) {
    const s = dateStr(a.start_date); const e = dateStr(a.end_date);
    if (!start || s < start) start = s;
    if (!end || e > end) end = e;
  }
  const dc = await buildDayContext(workspaceId, list.map((a) => a.user_id), start, end);
  return list.map((a) => assignmentDto(a, dc, { hydrated }));
}

export function milestoneDto(m) {
  return { id: m.id, name: m.name, date: dateToIso(dateStr(m.date)), projectId: m.project_id, workspaceId: m.workspace_id };
}

// Validation ------------------------------------------------------------------------------------
export async function normalizeInput(ctx, b, existing) {
  const ws = ctx.workspace.id;
  const projectId = b.projectId !== undefined ? b.projectId : existing?.project_id;
  if (!projectId) throw badRequest('projectId is required', 400);
  const project = await one('SELECT * FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, ws]);
  if (!project) throw badRequest('Project not found', 400);
  if (project.archived && (!existing || existing.project_id !== projectId)) throw badRequest('Project is archived', 400);
  const userId = b.userId !== undefined ? b.userId : existing?.user_id;
  if (!userId) throw badRequest('userId is required', 400);
  const member = await one('SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws, userId]);
  if (!member) throw badRequest('User is not a member of this workspace', 400);
  if (member.status !== 'ACTIVE' && (!existing || existing.user_id !== userId)) throw badRequest('User is not active in this workspace', 400);
  const taskId = b.taskId !== undefined ? (b.taskId || null) : (existing && existing.project_id === projectId ? existing.task_id : null);
  if (taskId) {
    const task = await one('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
    if (!task || task.project_id !== projectId) throw badRequest('Task does not belong to the selected project', 400);
  }
  const start = b.start !== undefined ? toDateOnly(b.start, 'start') : dateStr(existing.start_date);
  const end = b.end !== undefined ? toDateOnly(b.end, 'end') : dateStr(existing.end_date);
  if (!start || !end) throw badRequest('start and end are required', 400);
  if (end < start) throw badRequest('end must not be before start', 400);
  if (daysBetween(start, end) > 366) throw badRequest('Assignment period cannot exceed one year', 400);
  const hoursPerDay = b.hoursPerDay !== undefined ? Number(b.hoursPerDay) : Number(existing?.hours_per_day ?? 8);
  if (!(hoursPerDay > 0) || hoursPerDay > 24) throw badRequest('hoursPerDay must be between 0 and 24', 400);
  let startTime = b.startTime !== undefined ? b.startTime : existing?.start_time;
  if (startTime) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(startTime));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw badRequest('startTime must be in hh:mm:ss format', 400);
    startTime = `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
  } else startTime = null;
  return {
    project_id: projectId, user_id: userId, task_id: taskId, start_date: start, end_date: end, hours_per_day: Math.round(hoursPerDay * 100) / 100, start_time: startTime,
    include_non_working_days: b.includeNonWorkingDays !== undefined ? !!b.includeNonWorkingDays : !!existing?.include_non_working_days,
    note: b.note !== undefined ? (b.note == null ? null : String(b.note).slice(0, 3000)) : (existing?.note ?? null),
    billable: b.billable !== undefined ? (b.billable == null ? null : !!b.billable) : (existing ? existing.billable : (project.billable ?? null)),
  };
}

function emit(name, ctx, a, extra = {}) {
  events.emitAsync(name, { workspaceId: ctx.workspace.id, actorId: ctx.user.id, assignmentId: a.id, userId: a.user_id, projectId: a.project_id, seriesId: a.series_id || null, ...extra });
}

// Creation ---------------------------------------------------------------------------------------
// Creates one assignment, or a weekly series when recurringAssignment.weeks > 1 (one assignment per week sharing series_id)
export async function createSeries(ctx, b) {
  const projectId = b.projectId;
  ctx.requireProjectManager(projectId);
  const n = await normalizeInput(ctx, b);
  const rec = b.recurringAssignment || null;
  const weeks = Math.max(1, Number(rec?.weeks ?? 1) || 1);
  if (weeks > 260) throw badRequest('weeks cannot exceed 260', 400);
  const repeat = !!(rec?.repeat) || weeks > 1;
  const seriesId = repeat ? newId() : null;
  const created = await transaction(async () => {
    const out = [];
    for (let i = 0; i < weeks; i++) {
      out.push(await insert('scheduling_assignments', {
        id: i === 0 && b.id && /^[a-f0-9]{24}$/.test(b.id) ? b.id : newId(), workspace_id: ctx.workspace.id, ...n,
        start_date: addDaysLocal(n.start_date, 7 * i), end_date: addDaysLocal(n.end_date, 7 * i),
        published: !!b.published && ctx.managesProject(projectId), series_id: seriesId, recurring_weeks: weeks, recurring_repeat: repeat,
      }));
    }
    return out;
  });
  for (const a of created) {
    await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'CREATE_ASSIGNMENT', entityType: 'ASSIGNMENT', entityId: a.id, content: b });
    emit('assignment.created', ctx, a);
  }
  return loadMany(ctx.workspace.id, created.map((a) => a.id));
}

async function seriesTargets(a, option) {
  if (!a.series_id || !option || option === 'THIS_ONE') return [a];
  const all = await rows('SELECT * FROM scheduling_assignments WHERE series_id = $1 ORDER BY start_date, id', [a.series_id]);
  if (option === 'ALL') return all;
  return all.filter((t) => dateStr(t.start_date) >= dateStr(a.start_date));
}

// Update -----------------------------------------------------------------------------------------
export async function updateAssignments(ctx, a, b, option) {
  ctx.requireProjectManager(a.project_id);
  if (b.projectId !== undefined && b.projectId !== a.project_id) ctx.requireProjectManager(b.projectId);
  const n = await normalizeInput(ctx, b, a);
  const targets = await seriesTargets(a, option);
  const dStart = daysBetween(dateStr(a.start_date), n.start_date);
  const dEnd = daysBetween(dateStr(a.end_date), n.end_date);
  const before = await assignmentsDto(ctx.workspace.id, [a]);
  const updated = await transaction(async () => {
    const out = [];
    for (const t of targets) {
      const start = t.id === a.id ? n.start_date : addDaysLocal(dateStr(t.start_date), dStart);
      const end = t.id === a.id ? n.end_date : addDaysLocal(dateStr(t.end_date), dEnd);
      out.push(await one(
        `UPDATE scheduling_assignments SET project_id = $2, user_id = $3, task_id = $4, start_date = $5, end_date = $6, hours_per_day = $7, start_time = $8,
            include_non_working_days = $9, note = $10, billable = $11 WHERE id = $1 RETURNING *`,
        [t.id, n.project_id, n.user_id, n.task_id, start, end, n.hours_per_day, n.start_time, n.include_non_working_days, n.note, n.billable],
      ));
    }
    return out;
  });
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'UPDATE_ASSIGNMENT', entityType: 'ASSIGNMENT', entityId: a.id, content: { ...b, seriesUpdateOption: option }, previous: before[0] });
  for (const t of updated) emit('assignment.updated', ctx, t, { seriesUpdateOption: option || 'THIS_ONE' });
  return loadMany(ctx.workspace.id, updated.map((t) => t.id));
}

// Delete -----------------------------------------------------------------------------------------
export async function deleteAssignments(ctx, a, option) {
  ctx.requireProjectManager(a.project_id);
  const targets = await seriesTargets(a, option);
  const dtos = await assignmentsDto(ctx.workspace.id, await loadMany(ctx.workspace.id, targets.map((t) => t.id)));
  await query('DELETE FROM scheduling_assignments WHERE id = ANY($1)', [targets.map((t) => t.id)]);
  for (const dto of dtos) {
    await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'DELETE_ASSIGNMENT', entityType: 'ASSIGNMENT', entityId: dto.id, previous: dto });
    emit('assignment.deleted', ctx, { id: dto.id, user_id: dto.userId, project_id: dto.projectId, series_id: dto.recurring.seriesId }, { assignment: dto });
  }
  return dtos;
}

// Series size -------------------------------------------------------------------------------------
export async function changeSeries(ctx, a, { weeks, repeat }) {
  ctx.requireProjectManager(a.project_id);
  weeks = Math.max(1, Number(weeks) || 1);
  if (weeks > 260) throw badRequest('weeks cannot exceed 260', 400);
  const isRecurring = repeat !== undefined ? !!repeat || weeks > 1 : weeks > 1;
  const seriesId = a.series_id || newId();
  const ids = await transaction(async () => {
    if (!a.series_id) await query('UPDATE scheduling_assignments SET series_id = $2 WHERE id = $1', [a.id, seriesId]);
    const all = await rows('SELECT * FROM scheduling_assignments WHERE series_id = $1 ORDER BY start_date, id', [seriesId]);
    const keep = all.slice(0, weeks).map((t) => t.id);
    if (weeks < all.length) await query('DELETE FROM scheduling_assignments WHERE id = ANY($1)', [all.slice(weeks).map((t) => t.id)]);
    const last = all[all.length - 1];
    for (let k = 1; k <= weeks - all.length; k++) {
      const c = await insert('scheduling_assignments', {
        id: newId(), workspace_id: last.workspace_id, project_id: last.project_id, task_id: last.task_id, user_id: last.user_id,
        start_date: addDaysLocal(dateStr(last.start_date), 7 * k), end_date: addDaysLocal(dateStr(last.end_date), 7 * k), hours_per_day: last.hours_per_day, start_time: last.start_time,
        include_non_working_days: last.include_non_working_days, note: last.note, billable: last.billable, published: false, series_id: seriesId,
      });
      keep.push(c.id);
    }
    await query('UPDATE scheduling_assignments SET recurring_weeks = $2, recurring_repeat = $3 WHERE series_id = $1', [seriesId, weeks, isRecurring]);
    return keep;
  });
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'UPDATE_ASSIGNMENT', entityType: 'ASSIGNMENT', entityId: a.id, content: { weeks, repeat, seriesId } });
  emit('assignment.updated', ctx, { ...a, series_id: seriesId }, { weeks, repeat: isRecurring });
  return loadMany(ctx.workspace.id, ids);
}

// Copy ---------------------------------------------------------------------------------------------
export async function copyAssignments(ctx, a, { userId, seriesUpdateOption }) {
  ctx.requireProjectManager(a.project_id);
  const member = await one('SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ctx.workspace.id, userId]);
  if (!member || member.status !== 'ACTIVE') throw badRequest('User is not an active member of this workspace', 400);
  const targets = await seriesTargets(a, seriesUpdateOption);
  const seriesId = targets.length > 1 ? newId() : null;
  const created = await transaction(async () => {
    const out = [];
    for (const t of targets) {
      out.push(await insert('scheduling_assignments', {
        id: newId(), workspace_id: t.workspace_id, project_id: t.project_id, task_id: t.task_id, user_id: userId, start_date: dateStr(t.start_date), end_date: dateStr(t.end_date),
        hours_per_day: t.hours_per_day, start_time: t.start_time, include_non_working_days: t.include_non_working_days, note: t.note, billable: t.billable, published: false,
        series_id: seriesId, recurring_weeks: targets.length > 1 ? targets.length : null, recurring_repeat: targets.length > 1,
      }));
    }
    return out;
  });
  for (const c of created) {
    await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'CREATE_ASSIGNMENT', entityType: 'ASSIGNMENT', entityId: c.id, content: { copiedFrom: a.id, userId } });
    emit('assignment.created', ctx, c, { copiedFrom: a.id });
  }
  return loadMany(ctx.workspace.id, created.map((c) => c.id));
}

// Filters -------------------------------------------------------------------------------------------
// Resolves ContainsUsersFilterRequestV1 / ContainsUserGroupFilterRequestV1 into a list of user ids (null = no filter)
export async function filterUserIds(workspaceId, userFilter, groupFilter) {
  let ids = null;
  if (userFilter && ((userFilter.ids && userFilter.ids.length) || String(userFilter.contains || '').toUpperCase() === 'DOES_NOT_CONTAIN')) {
    const given = (userFilter.ids || []).filter(Boolean);
    if (String(userFilter.contains || 'CONTAINS').toUpperCase() === 'DOES_NOT_CONTAIN') {
      const status = String(userFilter.status || (userFilter.statuses && userFilter.statuses[0]) || 'ALL').toUpperCase();
      const params = [workspaceId]; let cond = '';
      if (status !== 'ALL') { params.push(status); cond = 'AND status = $2'; }
      ids = (await rows(`SELECT user_id FROM workspace_members WHERE workspace_id = $1 ${cond}`, params)).map((m) => m.user_id).filter((id) => !given.includes(id));
    } else ids = given;
  }
  if (groupFilter && groupFilter.ids && groupFilter.ids.length) {
    const inGroups = (await rows('SELECT DISTINCT gm.user_id FROM user_group_members gm JOIN user_groups g ON g.id = gm.group_id WHERE g.workspace_id = $1 AND gm.group_id = ANY($2)', [workspaceId, groupFilter.ids])).map((r) => r.user_id);
    let groupIds = inGroups;
    if (String(groupFilter.contains || 'CONTAINS').toUpperCase() === 'DOES_NOT_CONTAIN') {
      groupIds = (await rows('SELECT user_id FROM workspace_members WHERE workspace_id = $1', [workspaceId])).map((m) => m.user_id).filter((id) => !inGroups.includes(id));
    }
    ids = ids ? ids.filter((id) => groupIds.includes(id)) : groupIds;
  }
  return ids;
}

export function statusSql(statusFilter) {
  const s = String(statusFilter || 'ALL').toUpperCase();
  if (s === 'PUBLISHED') return 'a.published = true';
  if (s === 'UNPUBLISHED') return 'a.published = false';
  return null;
}

// Publish --------------------------------------------------------------------------------------------
export async function publish(ctx, b) {
  const ws = ctx.workspace.id;
  const start = toDateOnly(b.start, 'start'); const end = toDateOnly(b.end, 'end');
  if (!start || !end) throw badRequest('start and end are required', 400);
  if (end < start) throw badRequest('end must not be before start', 400);
  const conds = ['a.workspace_id = $1', 'a.published = false', 'a.start_date <= $3', 'a.end_date >= $2']; const params = [ws, start, end];
  const userIds = await filterUserIds(ws, b.userFilter, b.userGroupFilter);
  if (userIds) { params.push(userIds); conds.push(`a.user_id = ANY($${params.length})`); }
  if (b.search) { params.push(`%${String(b.search).toLowerCase()}%`); conds.push(`(lower(p.name) LIKE $${params.length} OR lower(u.name) LIKE $${params.length})`); }
  if (!ctx.isAdmin) {
    if (!ctx.managedProjects.size) throw forbidden('Only admins or project managers can publish assignments', 403);
    params.push([...ctx.managedProjects]); conds.push(`a.project_id = ANY($${params.length})`);
  }
  const list = await rows(`SELECT a.id, a.user_id FROM scheduling_assignments a JOIN projects p ON p.id = a.project_id JOIN users u ON u.id = a.user_id WHERE ${conds.join(' AND ')}`, params);
  const ids = list.map((a) => a.id);
  if (ids.length) await query('UPDATE scheduling_assignments SET published = true WHERE id = ANY($1)', [ids]);
  const byUser = new Map();
  for (const a of list) byUser.set(a.user_id, (byUser.get(a.user_id) || 0) + 1);
  await audit({ workspaceId: ws, userId: ctx.user.id, action: 'PUBLISH_ASSIGNMENTS', entityType: 'ASSIGNMENT', entityId: null, content: { start, end, assignmentIds: ids } });
  events.emitAsync('assignment.published', { workspaceId: ws, actorId: ctx.user.id, assignmentIds: ids, userIds: [...byUser.keys()], start, end });
  if (b.notifyUsers) {
    for (const [uid, n] of byUser) {
      await notifyWithMail([uid], {
        workspaceId: ws, type: 'SCHEDULE_PUBLISHED', title: 'Your schedule has been published',
        body: `${n} assignment(s) between ${start} and ${end} were published by ${ctx.user.name}.`, payload: { start, end, count: n }, settingKey: 'scheduling',
      });
    }
  }
  return { published: ids.length, assignmentIds: ids, userIds: [...byUser.keys()] };
}

// Totals ----------------------------------------------------------------------------------------------
function periodOf(q) {
  const start = toDateOnly(q.start, 'start'); const end = toDateOnly(q.end, 'end');
  if (!start || !end) throw badRequest('start and end are required', 400);
  if (end < start) throw badRequest('end must not be before start', 400);
  if (daysBetween(start, end) > 400) throw badRequest('Period cannot exceed 400 days', 400);
  return { start, end };
}

export async function projectTotals(ctx, q) {
  const ws = ctx.workspace.id;
  const { start, end } = periodOf(q);
  const conds = ['a.workspace_id = $1', 'a.start_date <= $3', 'a.end_date >= $2']; const params = [ws, start, end];
  const st = statusSql(q.statusFilter); if (st) conds.push(st);
  if (q.projectId) { params.push(q.projectId); conds.push(`a.project_id = $${params.length}`); }
  if (q.search) { params.push(`%${String(q.search).toLowerCase()}%`); conds.push(`lower(p.name) LIKE $${params.length}`); }
  const vis = await visibilitySql(ctx, params); if (vis) conds.push(vis);
  const list = await rows(`${ASSIGNMENT_SQL} WHERE ${conds.join(' AND ')} ORDER BY a.start_date`, params);
  const dc = await buildDayContext(ws, list.map((a) => a.user_id), start, end);
  const dates = [...eachDay(start, end)];
  const groups = new Map();
  const groupFor = (p) => {
    if (!groups.has(p.id)) groups.set(p.id, { project: p, totalHours: 0, days: new Set() });
    return groups.get(p.id);
  };
  for (const a of list) {
    const g = groupFor({ id: a.project_id, name: a.project_name, color: a.project_color, archived: a.project_archived, billable: a.project_billable, client_id: a.client_id, client_name: a.client_name });
    for (const d of scheduledDates(a, dc, start, end)) { g.totalHours += Number(a.hours_per_day); g.days.add(d); }
  }
  if (q.projectId && !groups.size) {
    const p = await one('SELECT p.*, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1 AND p.workspace_id = $2', [q.projectId, ws]);
    if (!p) throw notFound('Project not found', 404);
    groupFor(p);
  }
  const projectIds = [...groups.keys()];
  const milestones = projectIds.length ? await rows('SELECT * FROM scheduling_milestones WHERE workspace_id = $1 AND project_id = ANY($2) AND date >= $3 AND date <= $4 ORDER BY date', [ws, projectIds, start, end]) : [];
  const out = [...groups.values()].sort((a, b) => String(a.project.name).localeCompare(String(b.project.name))).map((g) => ({
    projectId: g.project.id,
    projectName: g.project.name,
    projectColor: g.project.color,
    clientId: g.project.client_id || '',
    clientName: g.project.client_name || '',
    projectArchived: !!g.project.archived,
    projectBillable: !!g.project.billable,
    taskId: null,
    taskName: null,
    totalHours: Math.round(g.totalHours * 100) / 100,
    assignments: dates.map((d) => ({ date: dateToIso(d), hasAssignment: g.days.has(d) })),
    milestones: milestones.filter((m) => m.project_id === g.project.id).map(milestoneDto),
    workspaceId: ws,
  }));
  const page = Math.max(1, Number(q.page) || 1); const pageSize = Math.min(5000, Math.max(1, Number(q.pageSize) || 50));
  return out.slice((page - 1) * pageSize, page * pageSize);
}

export async function userTotals(ctx, q) {
  const ws = ctx.workspace.id;
  const { start, end } = periodOf(q);
  const conds = ['m.workspace_id = $1']; const params = [ws];
  if (q.userId) { params.push(q.userId); conds.push(`m.user_id = $${params.length}`); } else conds.push("m.status = 'ACTIVE'");
  const filtered = q.userId ? null : await filterUserIds(ws, q.userFilter, q.userGroupFilter);
  if (filtered) { params.push(filtered); conds.push(`m.user_id = ANY($${params.length})`); }
  if (q.search) { params.push(`%${String(q.search).toLowerCase()}%`); conds.push(`lower(u.name) LIKE $${params.length}`); }
  const visible = await visibleUserIds(ctx);
  if (visible) { params.push(visible); conds.push(`m.user_id = ANY($${params.length})`); }
  const page = Math.max(1, Number(q.page) || 1); const pageSize = Math.min(5000, Math.max(1, Number(q.pageSize) || 50));
  params.push(pageSize, (page - 1) * pageSize);
  const members = await rows(`SELECT u.id, u.name, u.profile_picture, m.status FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE ${conds.join(' AND ')} ORDER BY lower(u.name) LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  if (q.userId && !members.length) throw notFound('User not found in workspace', 404);
  const ids = members.map((m) => m.id);
  const aConds = ['a.workspace_id = $1', 'a.user_id = ANY($2)', 'a.start_date <= $4', 'a.end_date >= $3']; const aParams = [ws, ids, start, end];
  const st = statusSql(q.statusFilter); if (st) aConds.push(st);
  const vis = await visibilitySql(ctx, aParams); if (vis) aConds.push(vis);
  const list = ids.length ? await rows(`SELECT a.* FROM scheduling_assignments a WHERE ${aConds.join(' AND ')}`, aParams) : [];
  const dc = await buildDayContext(ws, ids, start, end);
  const dates = [...eachDay(start, end)];
  return members.map((m) => {
    const cal = dc.cals.get(m.id);
    const totals = new Map(dates.map((d) => [d, 0]));
    for (const a of list.filter((x) => x.user_id === m.id)) for (const d of scheduledDates(a, dc, start, end)) totals.set(d, totals.get(d) + Number(a.hours_per_day));
    return {
      userId: m.id,
      userName: m.name,
      userImage: m.profile_picture || '',
      userStatus: m.status,
      workingDays: cal ? cal.workingDays : [],
      capacityPerDay: cal ? Math.round((cal.capacitySeconds / 3600) * 100) / 100 : 8,
      totalHoursPerDay: dates.map((d) => ({ date: dateToIso(d), totalHours: Math.round(totals.get(d) * 100) / 100 })),
      workspaceId: ws,
    };
  });
}
