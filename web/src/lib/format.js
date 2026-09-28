// Formatting helpers shared by pages
export function isoToSeconds(iso) {
  if (!iso) return 0;
  if (typeof iso === 'number') return iso;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(iso);
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Math.round(Number(m[4] || 0));
}

export function secondsToIso(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${sec || (!h && !m) ? `${sec}S` : ''}`;
}

export function fmtDuration(seconds, { seconds: withSeconds = true, decimal = false } = {}) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (decimal) return (s / 3600).toFixed(2);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return withSeconds ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(h)}:${p(m)}`;
}

// Parses "1:30", "1h30m", "1.5", "90m", "01:30:00" into seconds
export function parseDuration(text) {
  if (text == null) return null;
  const t = String(text).trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 3600);
  const hms = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3] || 0);
  let total = 0; let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/g; let m;
  while ((m = re.exec(t))) { matched = true; total += Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1); }
  return matched ? Math.round(total) : null;
}

export function entryDuration(e, now = Date.now()) {
  const start = new Date(e.timeInterval.start).getTime();
  const end = e.timeInterval.end ? new Date(e.timeInterval.end).getTime() : now;
  return Math.max(0, Math.round((end - start) / 1000));
}

export function money(cents, currency = 'USD', locale = 'pt-BR') {
  const v = (Number(cents) || 0) / 100;
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(v); } catch { return `${currency} ${v.toFixed(2)}`; }
}

export function pad(n) { return String(n).padStart(2, '0'); }

// Local date helpers (in the browser's time zone or the user's tz via Intl)
export function toLocalDateStr(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function toLocalTimeStr(date, timeZone, { seconds = false, hour12 = false } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(hour12 ? 'en-US' : 'pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, hour12 }).format(d);
}

// Combine YYYY-MM-DD + HH:mm in a time zone into an ISO instant
export function localToIso(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi, s = 0] = (timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = tzOffset(new Date(guess), timeZone);
  let result = guess - offset;
  const offset2 = tzOffset(new Date(result), timeZone);
  if (offset2 !== offset) result = guess - offset2;
  return new Date(result).toISOString();
}

export function tzOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') === 24 ? 0 : g('hour'), g('minute'), g('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function startOfWeekStr(dateStr, weekStart = 'MONDAY') {
  const names = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const ws = Math.max(0, names.indexOf(weekStart));
  return addDays(dateStr, -((dow - ws + 7) % 7));
}

export function fmtDate(dateStr, dateFormat = 'DD/MM/YYYY') {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  return dateFormat.replace('YYYY', y).replace('MM', m).replace('DD', d);
}

export function weekdayShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function humanDate(dateStr, today = new Date()) {
  const t = toLocalDateStr(today);
  if (dateStr === t) return 'Hoje';
  if (dateStr === addDays(t, -1)) return 'Ontem';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
}

export function monthName(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
export const WEEKDAY_LABELS = { MONDAY: 'Segunda', TUESDAY: 'Terça', WEDNESDAY: 'Quarta', THURSDAY: 'Quinta', FRIDAY: 'Sexta', SATURDAY: 'Sábado', SUNDAY: 'Domingo' };

export function errorMessage(err) {
  if (!err) return 'Erro desconhecido';
  if (err.data && err.data.message) return err.data.message;
  return err.message || String(err);
}
