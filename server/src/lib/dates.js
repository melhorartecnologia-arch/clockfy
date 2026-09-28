// Date helpers with IANA time zone support using Intl (no external dependency).

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
export const WEEKDAY_NAMES = WEEKDAYS;

export function weekdayIndex(name) {
  const i = WEEKDAYS.indexOf(String(name || 'MONDAY').toUpperCase());
  return i < 0 ? 1 : i;
}

const dtfCache = new Map();
function dtf(timeZone) {
  const key = timeZone || 'UTC';
  if (!dtfCache.has(key)) {
    dtfCache.set(key, new Intl.DateTimeFormat('en-US', {
      timeZone: key, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return dtfCache.get(key);
}

export function isValidTimeZone(tz) {
  try { dtf(tz); return true; } catch { return false; }
}

// Returns wall-clock parts of `date` in the given time zone
export function zonedParts(date, timeZone = 'UTC') {
  const parts = {};
  for (const p of dtf(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  if (parts.hour === 24) parts.hour = 0;
  return parts; // {year, month, day, hour, minute, second}
}

export function tzOffsetMs(date, timeZone = 'UTC') {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Builds a Date for a wall-clock time in a time zone
export function zonedTime(timeZone, year, month, day, hour = 0, minute = 0, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = tzOffsetMs(new Date(guess), timeZone);
  let result = guess - offset;
  // correct for DST transitions
  const offset2 = tzOffsetMs(new Date(result), timeZone);
  if (offset2 !== offset) result = guess - offset2;
  return new Date(result);
}

export function localDateString(date, timeZone = 'UTC') {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localTimeString(date, timeZone = 'UTC', withSeconds = true) {
  const p = zonedParts(date, timeZone);
  const t = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  return withSeconds ? `${t}:${String(p.second).padStart(2, '0')}` : t;
}

export function startOfDay(date, timeZone = 'UTC') {
  const p = zonedParts(date, timeZone);
  return zonedTime(timeZone, p.year, p.month, p.day);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

export function addDaysLocal(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function parseDateOnly(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str));
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function dayOfWeekLocal(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function startOfWeek(date, timeZone = 'UTC', weekStart = 'MONDAY') {
  const p = zonedParts(date, timeZone);
  const ws = weekdayIndex(weekStart);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const diff = (dow - ws + 7) % 7;
  return zonedTime(timeZone, p.year, p.month, p.day - diff);
}

export function startOfMonth(date, timeZone = 'UTC') {
  const p = zonedParts(date, timeZone);
  return zonedTime(timeZone, p.year, p.month, 1);
}

export function addMonths(date, months, timeZone = 'UTC') {
  const p = zonedParts(date, timeZone);
  return zonedTime(timeZone, p.year, p.month + months, p.day, p.hour, p.minute, p.second);
}

export function toIso(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseDate(value, fieldName = 'date') {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`Invalid ${fieldName}: ${value}`);
    err.status = 400;
    throw err;
  }
  return d;
}

// Resolves Clockify dateRangeType into absolute [start, end)
export function resolveDateRange(type, now, timeZone = 'UTC', weekStart = 'MONDAY') {
  const today = startOfDay(now, timeZone);
  switch (String(type || 'ABSOLUTE').toUpperCase()) {
    case 'TODAY': return [today, addDays(today, 1)];
    case 'YESTERDAY': return [addDays(today, -1), today];
    case 'THIS_WEEK': { const s = startOfWeek(now, timeZone, weekStart); return [s, addDays(s, 7)]; }
    case 'LAST_WEEK': { const s = startOfWeek(now, timeZone, weekStart); return [addDays(s, -7), s]; }
    case 'PAST_TWO_WEEKS': { const s = startOfWeek(now, timeZone, weekStart); return [addDays(s, -7), addDays(s, 7)]; }
    case 'THIS_MONTH': { const s = startOfMonth(now, timeZone); return [s, addMonths(s, 1, timeZone)]; }
    case 'LAST_MONTH': { const s = startOfMonth(now, timeZone); return [addMonths(s, -1, timeZone), s]; }
    case 'THIS_YEAR': { const p = zonedParts(now, timeZone); return [zonedTime(timeZone, p.year, 1, 1), zonedTime(timeZone, p.year + 1, 1, 1)]; }
    case 'LAST_YEAR': { const p = zonedParts(now, timeZone); return [zonedTime(timeZone, p.year - 1, 1, 1), zonedTime(timeZone, p.year, 1, 1)]; }
    default: return null;
  }
}

export function daysBetween(startStr, endStr) {
  const a = parseDateOnly(startStr); const b = parseDateOnly(endStr);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
}

export function* eachDay(startStr, endStr) {
  const n = daysBetween(startStr, endStr);
  for (let i = 0; i <= n; i++) yield addDaysLocal(startStr, i);
}
