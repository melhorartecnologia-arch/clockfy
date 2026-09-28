// ISO-8601 duration helpers compatible with Clockify (e.g. "PT1H30M15S").

export function secondsToIso(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return null;
  let s = Math.max(0, Math.round(Number(totalSeconds)));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let out = 'PT';
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  if (s || (!h && !m)) out += `${s}S`;
  return out;
}

export function isoToSeconds(iso) {
  if (iso == null || iso === '') return null;
  if (typeof iso === 'number') return iso;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(String(iso).trim());
  if (!m) {
    // accept "HH:MM:SS" or "HH:MM" or decimal hours
    const parts = String(iso).split(':');
    if (parts.length >= 2 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
      const [h, mi, se = 0] = parts.map(Number);
      return h * 3600 + mi * 60 + se;
    }
    const n = Number(iso);
    if (!Number.isNaN(n)) return Math.round(n * 3600);
    throw new Error(`Invalid duration: ${iso}`);
  }
  const [, d, h, mi, s] = m;
  return Math.round((Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(mi || 0) * 60) + Number(s || 0));
}

export function formatHms(totalSeconds, { seconds = true } = {}) {
  let s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  return seconds ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}`;
}

export function formatDecimal(totalSeconds, digits = 2) {
  return (Number(totalSeconds || 0) / 3600).toFixed(digits);
}

// Rounding as in Clockify workspace settings: round = "Round to nearest" | "Round up to" | "Round down to"
export function roundSeconds(totalSeconds, roundType, minutes) {
  const step = Number(minutes) * 60;
  if (!step || step <= 0) return totalSeconds;
  const type = String(roundType || '').toLowerCase();
  if (type.includes('up')) return Math.ceil(totalSeconds / step) * step;
  if (type.includes('down')) return Math.floor(totalSeconds / step) * step;
  return Math.round(totalSeconds / step) * step;
}
