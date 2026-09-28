import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.jsx';
import { endpoints } from '../api.js';
import { useUsers } from '../components/pickers.jsx';
import { Spinner, Alert } from '../components/ui.jsx';
import EntryEditor from '../components/EntryEditor.jsx';
import { useNow, useLocalState } from '../lib/hooks.js';
import { fmtDuration, toLocalDateStr, toLocalTimeStr, localToIso, addDays, startOfWeekStr, weekdayShort, fmtDate, errorMessage, pad, entryDuration } from '../lib/format.js';

const HOUR_PX = 48;

export default function Calendar() {
  const { workspace, user, timeZone, weekStart, isAdmin, toast, dateFormat, timeFormat } = useStore();
  const wsId = workspace?.id;
  const today = toLocalDateStr(new Date(), timeZone);
  const [view, setView] = useLocalState('clockfy.calendarView', 'week'); // week | day
  const [anchor, setAnchor] = useState(today);
  const [viewUser, setViewUser] = useState(user.id);
  const users = useUsers(isAdmin ? wsId : null);
  const [entries, setEntries] = useState([]);
  const [running, setRunning] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editor, setEditor] = useState(null); // { entry } | { defaults }
  const now = useNow(60000);

  const days = useMemo(() => (view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeekStr(anchor, weekStart), i)) : [anchor]), [view, anchor, weekStart]);
  const first = days[0]; const last = days[days.length - 1];
  const startIso = localToIso(addDays(first, -1), '00:00', timeZone); // include entries starting the day before that span midnight
  const endIso = localToIso(addDays(last, 1), '00:00', timeZone);

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try {
      const [list, run] = await Promise.all([
        endpoints.timeEntries(wsId, viewUser, { start: startIso, end: endIso, hydrated: true, 'page-size': 2000 }),
        endpoints.runningEntry(wsId, viewUser).catch(() => null),
      ]);
      setEntries(list); setRunning(run);
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, viewUser, startIso, endIso]);
  useEffect(() => { load(); }, [load]);

  // Split entries into per-day segments (entries spanning midnight are clipped)
  const segments = useMemo(() => {
    const out = Object.fromEntries(days.map((d) => [d, []]));
    for (const e of entries) {
      const s = new Date(e.timeInterval.start).getTime();
      const en = e.timeInterval.end ? new Date(e.timeInterval.end).getTime() : now;
      for (const d of days) {
        const dayStart = new Date(localToIso(d, '00:00', timeZone)).getTime();
        const dayEnd = new Date(localToIso(addDays(d, 1), '00:00', timeZone)).getTime();
        const a = Math.max(s, dayStart); const b = Math.min(en, dayEnd);
        if (b <= a) continue;
        out[d].push({ e, top: ((a - dayStart) / 3600000) * HOUR_PX, height: Math.max(14, ((b - a) / 3600000) * HOUR_PX) });
      }
    }
    // Overlapping events: offset horizontally
    for (const d of days) {
      const list = out[d].sort((x, y) => x.top - y.top);
      const lanes = [];
      for (const seg of list) {
        let lane = lanes.findIndex((end) => end <= seg.top);
        if (lane === -1) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = seg.top + seg.height;
        seg.lane = lane;
      }
      const n = Math.max(1, lanes.length);
      for (const seg of list) { seg.lanes = n; }
    }
    return out;
  }, [entries, days, timeZone, now]);

  const dayTotal = (d) => segments[d].reduce((s, seg) => s + (seg.height / HOUR_PX) * 3600, 0);
  const hour12 = timeFormat === 'HOUR12';

  function clickColumn(ev, day) {
    if (ev.target !== ev.currentTarget) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const y = ev.clientY - rect.top;
    const hour = Math.max(0, Math.min(23, Math.floor(y / HOUR_PX)));
    const half = (y / HOUR_PX - hour) >= 0.5 ? 30 : 0;
    const start = `${pad(hour)}:${pad(half)}`;
    const endH = half ? hour + 1 : hour; const endM = half ? 0 : 30;
    const end = endH > 23 ? '23:59' : `${pad(endH)}:${pad(endM)}`;
    setEditor({ defaults: { date: day, endDate: day, start, end } });
  }

  const nowTop = (() => { const t = toLocalTimeStr(new Date(now), timeZone).split(':').map(Number); return (t[0] + t[1] / 60) * HOUR_PX; })();
  const gridCols = `60px repeat(${days.length}, 1fr)`;
  const title = view === 'week' ? `${fmtDate(first, dateFormat)} – ${fmtDate(last, dateFormat)}` : `${weekdayShort(anchor)}, ${fmtDate(anchor, dateFormat)}`;

  return (
    <div>
      <div className="page-header">
        <h1>Calendário</h1>
        <div className="btn-group">
          <button className="btn secondary sm" onClick={() => setAnchor(addDays(anchor, view === 'week' ? -7 : -1))}>‹</button>
          <button className="btn secondary sm" onClick={() => setAnchor(today)}>Hoje</button>
          <button className="btn secondary sm" onClick={() => setAnchor(addDays(anchor, view === 'week' ? 7 : 1))}>›</button>
        </div>
        <span className="muted">{title}</span>
        <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={{ width: 150 }} />
        <div className="right row gap">
          {isAdmin && users.length > 1 && <select style={{ width: 'auto' }} value={viewUser} onChange={(e) => setViewUser(e.target.value)}>{users.map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? `${u.name} (eu)` : u.name}</option>)}</select>}
          <div className="btn-group">
            <button className={`btn sm ${view === 'day' ? '' : 'secondary'}`} onClick={() => setView('day')}>Dia</button>
            <button className={`btn sm ${view === 'week' ? '' : 'secondary'}`} onClick={() => setView('week')}>Semana</button>
          </div>
          <button className="btn" onClick={() => setEditor({ defaults: { date: anchor, endDate: anchor } })}>+ Registro</button>
        </div>
      </div>
      <Alert type="error">{error}</Alert>
      {loading && entries.length === 0 ? <Spinner block /> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="calendar-head" style={{ gridTemplateColumns: gridCols }}>
            <div className="calendar-corner small light">{running && viewUser ? '⏱' : ''}</div>
            {days.map((d) => (
              <div key={d} className={`calendar-day ${d === today ? 'today' : ''}`}>
                <div className="bold">{weekdayShort(d)} <span className="muted" style={{ fontWeight: 400 }}>{d.slice(8, 10)}/{d.slice(5, 7)}</span></div>
                <div className="small muted mono">{fmtDuration(dayTotal(d), { seconds: false })}</div>
              </div>
            ))}
          </div>
          <div className="calendar-scroll">
            <div className="calendar" style={{ gridTemplateColumns: gridCols, border: 'none' }}>
              <div>{Array.from({ length: 24 }, (_, h) => <div key={h} className="hour">{hour12 ? `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` : `${pad(h)}:00`}</div>)}</div>
              {days.map((d) => (
                <div key={d} className={`col ${d === today ? 'today' : ''}`} style={{ height: 24 * HOUR_PX, cursor: 'cell' }} onClick={(ev) => clickColumn(ev, d)}>
                  {Array.from({ length: 24 }, (_, h) => <div key={h} className="hour" style={{ pointerEvents: 'none' }} />)}
                  {d === today && <div className="calendar-now" style={{ top: nowTop }} />}
                  {segments[d].map((seg, i) => {
                    const e = seg.e; const color = e.project?.color || '#607d8b';
                    const width = 100 / seg.lanes;
                    return (
                      <div key={`${e.id}-${i}`} className="ev" title={`${e.description || '(sem descrição)'}\n${e.project ? e.project.name : 'Sem projeto'}${e.task ? `: ${e.task.name}` : ''}\n${toLocalTimeStr(e.timeInterval.start, timeZone, { hour12 })} – ${e.timeInterval.end ? toLocalTimeStr(e.timeInterval.end, timeZone, { hour12 }) : 'em andamento'} (${fmtDuration(entryDuration(e, now))})`}
                        style={{ top: seg.top, height: seg.height, left: `calc(${seg.lane * width}% + 2px)`, width: `calc(${width}% - 4px)`, right: 'auto', background: color, opacity: e.timeInterval.end ? 1 : .75, borderLeft: e.type === 'BREAK' ? '3px dashed #fff' : undefined }}
                        onClick={(ev) => { ev.stopPropagation(); setEditor({ entry: e }); }}>
                        <div className="bold truncate">{e.description || (e.project ? e.project.name : '(sem descrição)')}</div>
                        {seg.height >= 28 && <div className="truncate" style={{ opacity: .9 }}>{e.project ? `${e.project.name}${e.task ? `: ${e.task.name}` : ''}` : 'Sem projeto'}</div>}
                        {seg.height >= 42 && <div style={{ opacity: .85 }}>{toLocalTimeStr(e.timeInterval.start, timeZone, { hour12 })} – {e.timeInterval.end ? toLocalTimeStr(e.timeInterval.end, timeZone, { hour12 }) : '…'}</div>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="filter-bar small light" style={{ borderTop: '1px solid var(--border)' }}>Clique em um horário vazio para criar um registro; clique em um registro para editá-lo.</div>
        </div>
      )}
      {editor && (
        <EntryEditor entry={editor.entry} defaults={editor.defaults} userId={viewUser} onClose={() => setEditor(null)}
          onSaved={() => { load(); toast(editor.entry ? 'Registro atualizado' : 'Registro criado', 'success'); }} onDeleted={() => load()} />
      )}
    </div>
  );
}
