// Attendance report (Clockify Team Report API): one row per user per day with start/end, breaks, work, capacity and overtime.
import { rows } from '../../lib/db.js';
import { parse, z } from '../../lib/validate.js';
import { isoToSeconds } from '../../lib/duration.js';
import { localDateString, localTimeString, dayOfWeekLocal, WEEKDAY_NAMES, toIso, parseDateOnly, zonedTime } from '../../lib/dates.js';
import { parseCommonFilter, visibilityScope, loadEntries, localDate } from './filters.js';

const compare = z.object({ filtrationType: z.enum(['EXACTLY', 'LARGER_THAN', 'SMALLER_THAN']).optional(), value: z.union([z.string(), z.number()]).optional() }).passthrough();
const attendanceSchema = z.object({
  attendanceFilter: z.object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(5000).optional(),
    sortColumn: z.enum(['USER', 'DATE', 'START', 'END', 'BREAK', 'WORK', 'CAPACITY', 'OVERTIME', 'TIME_OFF']).optional(),
    hasTimeOff: z.boolean().optional(),
    startFilters: z.array(compare).optional(),
    endFilters: z.array(compare).optional(),
    breakFilters: z.array(compare).optional(),
    workFilters: z.array(compare).optional(),
    capacityFilters: z.array(compare).optional(),
    overtimeFilters: z.array(compare).optional(),
  }).passthrough().optional(),
}).passthrough();

function matches(list, actual) {
  for (const c of list || []) {
    const v = Number(c.value);
    if (Number.isNaN(v)) continue;
    const type = c.filtrationType || 'EXACTLY';
    if (type === 'LARGER_THAN' && !(actual > v)) return false;
    if (type === 'SMALLER_THAN' && !(actual < v)) return false;
    if (type === 'EXACTLY' && actual !== v) return false;
  }
  return true;
}

const hhmmToMinutes = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const hundredthsToSeconds = (list) => (list || []).map((c) => ({ ...c, value: Number(c.value) / 100 * 3600 }));
const timeFilters = (list) => (list || []).map((c) => ({ ...c, value: hhmmToMinutes(c.value) }));

export async function attendanceReport(ctx, body, { now } = {}) {
  const b = parse(attendanceSchema, body || {});
  const af = b.attendanceFilter || {};
  const f = parseCommonFilter(ctx, body, { now });
  const scope = await visibilityScope(ctx);
  const entries = await loadEntries(ctx, f, scope, { sortColumn: 'DATE', sortOrder: 'ASCENDING' });
  const members = await rows('SELECT m.user_id, m.working_days, m.work_capacity, u.name, u.profile_picture FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1', [ctx.workspace.id]);
  const memberMap = new Map(members.map((m) => [m.user_id, m]));
  const defaultCapacity = isoToSeconds(ctx.settings.workCapacity || 'PT8H') || 0;
  const defaultDays = ctx.settings.workingDays || ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

  // group entries by user + local date
  const buckets = new Map();
  const add = (userId, date) => {
    const key = `${userId}|${date}`;
    if (!buckets.has(key)) buckets.set(key, { userId, date, entries: [], timeOff: 0 });
    return buckets.get(key);
  };
  for (const e of entries) add(e.user_id, localDate(e, f)).entries.push(e);

  if (af.hasTimeOff) {
    const params = [ctx.workspace.id, f.start, f.end];
    let cond = '';
    if (scope.userIds) { params.push(scope.userIds); cond = ' AND r.user_id = ANY($4)'; }
    const offs = await rows(`SELECT r.user_id, r.start_time, r.end_time, r.half_day, r.time_unit FROM time_off_requests r WHERE r.workspace_id = $1 AND r.status = 'APPROVED' AND r.start_time <= $3 AND r.end_time >= $2${cond}`, params);
    for (const r of offs) {
      const m = memberMap.get(r.user_id);
      const cap = m?.work_capacity ? isoToSeconds(m.work_capacity) : defaultCapacity;
      const s = new Date(r.start_time); const e = new Date(r.end_time);
      let d = localDateString(s < f.start ? f.start : s, f.timeZone);
      const last = localDateString(e > f.end ? f.end : e, f.timeZone);
      while (d <= last) {
        const bucket = add(r.user_id, d);
        if (r.time_unit === 'HOURS') {
          const p = parseDateOnly(d);
          const dayStart = zonedTime(f.timeZone, p.year, p.month, p.day); const dayEnd = zonedTime(f.timeZone, p.year, p.month, p.day + 1);
          bucket.timeOff += Math.max(0, Math.min(Math.round((Math.min(e, dayEnd) - Math.max(s, dayStart)) / 1000), cap));
        } else bucket.timeOff += r.half_day ? Math.round(cap / 2) : cap;
        const p = parseDateOnly(d);
        d = localDateString(zonedTime(f.timeZone, p.year, p.month, p.day + 1), f.timeZone);
      }
    }
  }

  let entities = [];
  for (const bucket of buckets.values()) {
    const m = memberMap.get(bucket.userId);
    const list = bucket.entries;
    const workingDays = m?.working_days || defaultDays;
    const isWorkingDay = workingDays.includes(WEEKDAY_NAMES[dayOfWeekLocal(bucket.date)]);
    const capacity = isWorkingDay ? (m?.work_capacity ? isoToSeconds(m.work_capacity) : defaultCapacity) : 0;
    const work = list.filter((e) => (e.type || 'REGULAR') === 'REGULAR').reduce((s, e) => s + e.seconds, 0);
    const brk = list.filter((e) => e.type === 'BREAK').reduce((s, e) => s + e.seconds, 0);
    const timeOff = bucket.timeOff + list.filter((e) => e.type === 'TIME_OFF' || e.type === 'HOLIDAY').reduce((s, e) => s + e.seconds, 0);
    const starts = list.map((e) => new Date(e.start_time)).sort((a, b) => a - b);
    const ends = list.map((e) => (e.end_time ? new Date(e.end_time) : null));
    const running = ends.some((x) => !x);
    const endTime = running ? null : ends.reduce((a, b) => (b > a ? b : a), ends[0] || null);
    const remaining = Math.max(0, capacity - work - timeOff);
    const overtime = Math.max(0, work + timeOff - capacity);
    entities.push({
      userId: bucket.userId,
      userName: m?.name || list[0]?.user_name || '',
      imageUrl: m?.profile_picture || list[0]?.user_image || '',
      date: bucket.date,
      startTime: starts.length ? toIso(starts[0]) : null,
      endTime: endTime ? toIso(endTime) : null,
      break: brk,
      totalDuration: work,
      capacity,
      remainingCapacity: remaining,
      overtime,
      timeOff,
      hasRunningEntry: running,
      _startMinutes: starts.length ? hhmmToMinutes(localTimeString(starts[0], f.timeZone)) : null,
      _endMinutes: endTime ? hhmmToMinutes(localTimeString(endTime, f.timeZone)) : null,
    });
  }

  entities = entities.filter((x) => matches(timeFilters(af.startFilters), x._startMinutes)
    && matches(timeFilters(af.endFilters), x._endMinutes)
    && matches(hundredthsToSeconds(af.breakFilters), x.break)
    && matches(hundredthsToSeconds(af.workFilters), x.totalDuration)
    && matches(hundredthsToSeconds(af.capacityFilters), x.capacity)
    && matches(hundredthsToSeconds(af.overtimeFilters), x.overtime));

  const dir = f.sortOrder === 'DESCENDING' ? -1 : 1;
  const col = af.sortColumn || 'USER';
  const cmp = {
    USER: (a, b) => a.userName.localeCompare(b.userName) || a.date.localeCompare(b.date),
    DATE: (a, b) => a.date.localeCompare(b.date) || a.userName.localeCompare(b.userName),
    START: (a, b) => (a._startMinutes ?? -1) - (b._startMinutes ?? -1),
    END: (a, b) => (a._endMinutes ?? -1) - (b._endMinutes ?? -1),
    BREAK: (a, b) => a.break - b.break,
    WORK: (a, b) => a.totalDuration - b.totalDuration,
    CAPACITY: (a, b) => a.capacity - b.capacity,
    OVERTIME: (a, b) => a.overtime - b.overtime,
    TIME_OFF: (a, b) => a.timeOff - b.timeOff,
  }[col];
  entities.sort((a, b) => cmp(a, b) * dir);
  for (const x of entities) { delete x._startMinutes; delete x._endMinutes; }

  const total = entities.length;
  const page = af.page || 1;
  const pageSize = af.pageSize || 50;
  const paged = af.page || af.pageSize ? entities.slice((page - 1) * pageSize, page * pageSize) : entities;
  return { result: { entities: paged, count: total, page, pageSize }, filter: f, entities: paged };
}
