// Holiday helpers shared with the timeOff and scheduling modules: member calendar (time zone, week start,
// working days, capacity), holiday expansion (annual recurrence), working-day computation, an elevated
// context for automatically created time entries and in-app + e-mail notifications.
import { one, rows, query } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { buildContext } from '../../middleware/workspace.js';
import { DEFAULT_USER_SETTINGS, DEFAULT_WORKSPACE_SETTINGS, mergeSettings } from '../../lib/settings.js';
import { isoToSeconds } from '../../lib/duration.js';
import { WEEKDAY_NAMES, dayOfWeekLocal, eachDay, addDaysLocal, daysBetween, parseDateOnly, zonedTime, localDateString } from '../../lib/dates.js';
import { notify } from '../../lib/notify.js';
import { sendMail } from '../../lib/mailer.js';
import { newId } from '../../lib/ids.js';
import { createEntry } from '../timeEntries/service.js';

const pad = (n) => String(n).padStart(2, '0');

// pg returns DATE columns as local-midnight Date objects; normalize to YYYY-MM-DD
export function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).slice(0, 10);
}

// Accepts "YYYY-MM-DD" or an ISO date-time and returns the calendar date the client meant (YYYY-MM-DD)
export function toDateOnly(v, field = 'date') {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let out;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) out = s.slice(0, 10);
  else {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw badRequest(`Invalid ${field}: ${v}`, 400);
    out = d.toISOString().slice(0, 10);
  }
  const p = parseDateOnly(out);
  const check = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (check.getUTCMonth() !== p.month - 1 || check.getUTCDate() !== p.day) throw badRequest(`Invalid ${field}: ${v}`, 400);
  return out;
}

export const dateToIso = (d) => (d ? `${d}T00:00:00Z` : null);

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && aEnd >= bStart;
}

// Calendar settings of a workspace member (falls back to workspace/user defaults)
export async function memberCalendar(workspaceId, userId) {
  const r = await one(
    `SELECT u.id, u.name, u.email, u.settings, u.profile_picture, u.status AS account_status, m.status, m.week_start, m.working_days, m.work_capacity, w.settings AS ws_settings
     FROM users u JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1 JOIN workspaces w ON w.id = m.workspace_id WHERE u.id = $2`,
    [workspaceId, userId],
  );
  if (!r) throw notFound('User is not a member of this workspace', 404);
  return calendarFromRow(r);
}

export function calendarFromRow(r) {
  const ws = mergeSettings(DEFAULT_WORKSPACE_SETTINGS, r.ws_settings);
  const us = mergeSettings(DEFAULT_USER_SETTINGS, r.settings);
  const workingDays = (Array.isArray(r.working_days) && r.working_days.length ? r.working_days : (ws.workingDays || [])).map((d) => String(d).toUpperCase());
  let capacitySeconds = 8 * 3600;
  try { capacitySeconds = isoToSeconds(r.work_capacity || ws.workCapacity || 'PT8H') ?? capacitySeconds; } catch { /* keep default */ }
  return {
    userId: r.id, name: r.name, email: r.email, status: r.status, accountStatus: r.account_status, profilePicture: r.profile_picture || null,
    timeZone: us.timeZone || 'UTC', weekStart: r.week_start || us.weekStart || 'MONDAY', workingDays, capacitySeconds,
    startOfDay: /^\d{2}:\d{2}/.test(String(us.myStartOfDay || '')) ? String(us.myStartOfDay).slice(0, 5) : '09:00', settings: us,
  };
}

// Calendars of several members in one query (Map userId -> calendar)
export async function memberCalendars(workspaceId, userIds) {
  if (!userIds.length) return new Map();
  const list = await rows(
    `SELECT u.id, u.name, u.email, u.settings, u.profile_picture, u.status AS account_status, m.status, m.week_start, m.working_days, m.work_capacity, w.settings AS ws_settings
     FROM users u JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1 JOIN workspaces w ON w.id = m.workspace_id WHERE u.id = ANY($2)`,
    [workspaceId, userIds],
  );
  return new Map(list.map((r) => [r.id, calendarFromRow(r)]));
}

export function isWorkingDay(cal, date) {
  return cal.workingDays.includes(WEEKDAY_NAMES[dayOfWeekLocal(date)]);
}

// Start of the member's work day on a given date, as a Date, plus the end after `seconds`
export function workDayInterval(cal, date, seconds, offsetSeconds = 0) {
  const p = parseDateOnly(date);
  const [hh, mm] = cal.startOfDay.split(':').map(Number);
  const start = new Date(zonedTime(cal.timeZone, p.year, p.month, p.day, hh, mm).getTime() + offsetSeconds * 1000);
  return { start, end: new Date(start.getTime() + seconds * 1000) };
}

// Working dates in [startDate, endDate] excluding the given holiday dates (Set of YYYY-MM-DD)
export function workingDates(cal, startDate, endDate, holidayDates = new Set()) {
  const out = [];
  for (const d of eachDay(startDate, endDate)) if (isWorkingDay(cal, d) && !holidayDates.has(d)) out.push(d);
  return out;
}

// Holidays --------------------------------------------------------------------
function shiftYear(date, year) {
  const p = parseDateOnly(date);
  const d = new Date(Date.UTC(year, p.month - 1, p.day));
  if (d.getUTCMonth() !== p.month - 1) return `${year}-02-28`; // Feb 29 on a non-leap year
  return d.toISOString().slice(0, 10);
}

// Occurrences of a holiday row overlapping [startDate, endDate]; annual holidays are expanded per year
export function holidayOccurrences(h, startDate, endDate) {
  const s = dateStr(h.start_date); const e = dateStr(h.end_date);
  if (!h.occurs_annually) return overlaps(s, e, startDate, endDate) ? [{ ...h, startDate: s, endDate: e }] : [];
  const len = Math.max(0, daysBetween(s, e));
  const out = [];
  for (let y = Number(startDate.slice(0, 4)) - 1; y <= Number(endDate.slice(0, 4)); y++) {
    const os = shiftYear(s, y); const oe = addDaysLocal(os, len);
    if (overlaps(os, oe, startDate, endDate)) out.push({ ...h, startDate: os, endDate: oe });
  }
  return out;
}

export function expandHolidays(list, startDate, endDate) {
  const out = [];
  for (const h of list) out.push(...holidayOccurrences(h, startDate, endDate));
  return out.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.name.localeCompare(b.name)));
}

export function holidayRowsForUserSql(alias = 'h') {
  return `(${alias}.everyone_including_new OR EXISTS (SELECT 1 FROM holiday_users hu WHERE hu.holiday_id = ${alias}.id AND hu.user_id = $2)
    OR EXISTS (SELECT 1 FROM holiday_groups hg JOIN user_group_members gm ON gm.group_id = hg.group_id WHERE hg.holiday_id = ${alias}.id AND gm.user_id = $2))`;
}

// Holidays that apply to a user, expanded to their occurrences within [startDate, endDate] (YYYY-MM-DD)
export async function holidaysForUser(workspaceId, userId, startDate, endDate) {
  const list = await rows(`SELECT h.* FROM holidays h WHERE h.workspace_id = $1 AND ${holidayRowsForUserSql('h')}`, [workspaceId, userId]);
  return expandHolidays(list, startDate, endDate);
}

// Set of holiday dates (YYYY-MM-DD) for a user within the period
export async function holidayDatesForUser(workspaceId, userId, startDate, endDate) {
  const set = new Set();
  for (const h of await holidaysForUser(workspaceId, userId, startDate, endDate)) {
    for (const d of eachDay(h.startDate, h.endDate)) if (d >= startDate && d <= endDate) set.add(d);
  }
  return set;
}

// Users a holiday/policy applies to (active members)
export async function holidayUserIds(h) {
  if (h.everyone_including_new) return (await rows("SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND status = 'ACTIVE'", [h.workspace_id])).map((r) => r.user_id);
  const r = await rows(
    `SELECT DISTINCT m.user_id FROM workspace_members m WHERE m.workspace_id = $1 AND m.status = 'ACTIVE'
       AND (EXISTS (SELECT 1 FROM holiday_users hu WHERE hu.holiday_id = $2 AND hu.user_id = m.user_id)
         OR EXISTS (SELECT 1 FROM holiday_groups hg JOIN user_group_members gm ON gm.group_id = hg.group_id WHERE hg.holiday_id = $2 AND gm.user_id = m.user_id))`,
    [h.workspace_id, h.id],
  );
  return r.map((x) => x.user_id);
}

// Users / user groups filters ({ids, contains, status}) used by holidays and time off policies ----------------------
// Resolves the explicit user ids the entity is assigned to. CONTAINS (default) keeps the given ids;
// DOES_NOT_CONTAIN assigns every member (filtered by status) except the given ids.
export async function resolveUserFilter(workspaceId, filter) {
  if (!filter) return [];
  const ids = [...new Set((filter.ids || []).filter(Boolean))];
  const contains = String(filter.contains || 'CONTAINS').toUpperCase();
  const status = String(filter.status || (filter.statuses && filter.statuses[0]) || 'ACTIVE').toUpperCase();
  if (contains === 'DOES_NOT_CONTAIN') {
    const params = [workspaceId]; let cond = '';
    if (status !== 'ALL') { params.push(status); cond = 'AND status = $2'; }
    const members = await rows(`SELECT user_id FROM workspace_members WHERE workspace_id = $1 ${cond}`, params);
    return members.map((m) => m.user_id).filter((id) => !ids.includes(id));
  }
  if (!ids.length) return [];
  const found = await rows('SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)', [workspaceId, ids]);
  if (found.length !== ids.length) throw badRequest('One or more users are not members of this workspace', 400);
  return ids;
}

export async function resolveGroupFilter(workspaceId, filter) {
  if (!filter) return [];
  const ids = [...new Set((filter.ids || []).filter(Boolean))];
  const contains = String(filter.contains || 'CONTAINS').toUpperCase();
  if (contains === 'DOES_NOT_CONTAIN') {
    const groups = await rows('SELECT id FROM user_groups WHERE workspace_id = $1', [workspaceId]);
    return groups.map((g) => g.id).filter((id) => !ids.includes(id));
  }
  if (!ids.length) return [];
  const found = await rows('SELECT id FROM user_groups WHERE workspace_id = $1 AND id = ANY($2)', [workspaceId, ids]);
  if (found.length !== ids.length) throw badRequest('One or more user groups do not exist in this workspace', 400);
  return ids;
}

// Validates the default project/task of an automatic time entry creation setting
export async function normalizeAutoEntry(workspaceId, input) {
  if (!input) return null;
  const de = input.defaultEntities || {};
  const projectId = de.projectId || null; let taskId = de.taskId || null;
  if (projectId) {
    const p = await one('SELECT id FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId]);
    if (!p) throw badRequest('Default project not found', 400);
  }
  if (taskId) {
    const t = await one('SELECT project_id FROM tasks WHERE id = $1 AND workspace_id = $2', [taskId, workspaceId]);
    if (!t || (projectId && t.project_id !== projectId)) throw badRequest('Default task does not belong to the default project', 400);
    if (!projectId) taskId = null;
  }
  if (input.enabled && !projectId) throw badRequest('A default project is required for automatic time entry creation', 400);
  return { enabled: !!input.enabled, defaultEntities: { projectId, taskId } };
}

// Contexts ----------------------------------------------------------------------
// Context acting as the workspace owner (used by scheduler jobs that create time entries)
export async function adminContext(workspaceId) {
  const ws = await one('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
  if (!ws) throw notFound('Workspace not found', 404);
  const user = await one('SELECT * FROM users WHERE id = $1', [ws.owner_id]);
  const member = await one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws.id, ws.owner_id]);
  return buildContext({ workspace: ws, user, member, roleRows: [] });
}

// Same actor, admin privileges (system-created entries on behalf of a policy/holiday)
export function elevate(ctx) {
  return { ...ctx, isAdmin: true };
}

// Creates an automatic (non-billable) time entry for a user on a date, returning the row
export async function createAutoEntry(ctx, cal, { date, seconds, offsetSeconds = 0, type, description, projectId, taskId }) {
  const { start, end } = workDayInterval(cal, date, seconds, offsetSeconds);
  return createEntry(elevate(ctx), cal.userId, {
    start: start.toISOString(), end: end.toISOString(), description: description || '', projectId: projectId || null, taskId: taskId || null,
    billable: false, type, tagIds: [], timeZone: cal.timeZone, __allowManual: true,
  }, { origin: 'AUTO' });
}

// Notifications ---------------------------------------------------------------------
export async function workspaceAdminIds(workspaceId) {
  const r = await rows(
    `SELECT owner_id AS user_id FROM workspaces WHERE id = $1 UNION SELECT user_id FROM roles WHERE workspace_id = $1 AND role IN ('WORKSPACE_ADMIN', 'OWNER')`,
    [workspaceId],
  );
  return r.map((x) => x.user_id);
}

export async function teamManagerIdsOf(workspaceId, userId) {
  const r = await rows(
    `SELECT DISTINCT r.user_id FROM roles r WHERE r.workspace_id = $1 AND r.role = 'TEAM_MANAGER'
       AND (r.entity_id = $2 OR r.entity_id IN (SELECT gm.group_id FROM user_group_members gm JOIN user_groups g ON g.id = gm.group_id WHERE gm.user_id = $2 AND g.workspace_id = $1))`,
    [workspaceId, userId],
  );
  return r.map((x) => x.user_id);
}

// In-app notification + optional e-mail (respecting the user's notification setting, e.g. approval/pto/scheduling)
export async function notifyWithMail(userIds, { workspaceId, type, title, body, payload, settingKey, mail = true, exclude = [] }) {
  const skip = new Set(exclude.filter(Boolean));
  const ids = [...new Set((userIds || []).filter((id) => id && !skip.has(id)))];
  if (!ids.length) return [];
  await notify(ids, { workspaceId, type, title, body, payload });
  if (mail) {
    const users = await rows("SELECT id, email, settings FROM users WHERE id = ANY($1) AND status = 'ACTIVE'", [ids]);
    for (const u of users) {
      const s = mergeSettings(DEFAULT_USER_SETTINGS, u.settings);
      if (settingKey && s[settingKey] === false) continue;
      await sendMail({ to: u.email, subject: title, text: body || title });
    }
  }
  return ids;
}

// Holiday time entries job --------------------------------------------------------------
// Creates HOLIDAY time entries for holidays with automatic time entry creation enabled, for every eligible
// user, on each working day of the holiday within a window around `now`. Idempotent via holiday_time_entries.
export async function runHolidayEntries({ now = new Date(), workspaceId, daysBack = 7, daysAhead = 31 } = {}) {
  const today = localDateString(now, 'UTC');
  const from = addDaysLocal(today, -daysBack); const to = addDaysLocal(today, daysAhead);
  const params = []; let cond = '';
  if (workspaceId) { params.push(workspaceId); cond = 'AND h.workspace_id = $1'; }
  const holidays = await rows(`SELECT h.* FROM holidays h WHERE COALESCE((h.automatic_time_entry_creation->>'enabled')::boolean, false) ${cond} ORDER BY h.workspace_id`, params);
  const contexts = new Map();
  let created = 0;
  for (const h of holidays) {
    const occurrences = holidayOccurrences(h, from, to);
    if (!occurrences.length) continue;
    if (!contexts.has(h.workspace_id)) contexts.set(h.workspace_id, await adminContext(h.workspace_id));
    const ctx = contexts.get(h.workspace_id);
    const atec = h.automatic_time_entry_creation || {};
    const projectId = h.project_id || atec.defaultEntities?.projectId || null;
    const taskId = h.task_id || atec.defaultEntities?.taskId || null;
    const userIds = await holidayUserIds(h);
    const cals = await memberCalendars(h.workspace_id, userIds);
    for (const occ of occurrences) {
      for (const date of eachDay(occ.startDate, occ.endDate)) {
        if (date < from || date > to) continue;
        for (const uid of userIds) {
          const cal = cals.get(uid);
          if (!cal || !isWorkingDay(cal, date)) continue;
          const exists = await one('SELECT 1 FROM holiday_time_entries WHERE holiday_id = $1 AND user_id = $2 AND date = $3', [h.id, uid, date]);
          if (exists) continue;
          try {
            const e = await createAutoEntry(ctx, cal, { date, seconds: cal.capacitySeconds, type: 'HOLIDAY', description: h.name, projectId, taskId });
            await query('INSERT INTO holiday_time_entries (holiday_id, user_id, date, time_entry_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [h.id, uid, date, e.id]);
            created++;
          } catch (err) {
            console.error(`[holidays] could not create time entry for user ${uid} on ${date}:`, err.message);
          }
        }
      }
    }
  }
  return created;
}

// Soft-deletes automatically created entries of a holiday (used when the holiday is deleted)
export async function removeHolidayEntries(holidayId) {
  await query(
    `UPDATE time_entries SET deleted_at = now() WHERE deleted_at IS NULL AND locked = false AND COALESCE(approval_status, '') NOT IN ('PENDING', 'APPROVED')
       AND id IN (SELECT time_entry_id FROM holiday_time_entries WHERE holiday_id = $1)`,
    [holidayId],
  );
}

export { newId };
