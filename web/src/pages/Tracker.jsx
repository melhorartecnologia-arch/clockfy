import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, endpoints } from '../api.js';
import { ProjectPicker, TagPicker, useProjects, useUsers } from '../components/pickers.jsx';
import { Spinner, Empty, Alert, Dropdown, ProjectLabel } from '../components/ui.jsx';
import EntryEditor from '../components/EntryEditor.jsx';
import { useNow, useLocalState } from '../lib/hooks.js';
import { fmtDuration, entryDuration, toLocalDateStr, toLocalTimeStr, localToIso, parseDuration, humanDate, addDays, errorMessage } from '../lib/format.js';

export default function Tracker() {
  const { workspace, user, timeZone, settings, isAdmin, toast, timeFormat } = useStore();
  const wsId = workspace?.id;
  const [entries, setEntries] = useState([]);
  const [running, setRunning] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [editing, setEditing] = useState(null);
  const [mode, setMode] = useLocalState('clockfy.trackerMode', 'timer'); // timer | manual
  const [viewUser, setViewUser] = useState(user.id);
  const users = useUsers(isAdmin ? wsId : null);
  const now = useNow(1000);
  const projects = useProjects(wsId);

  // New entry form (timer bar)
  const [form, setForm] = useState({ description: '', projectId: null, taskId: null, tagIds: [], billable: false, type: 'REGULAR' });
  const [manual, setManual] = useState({ date: toLocalDateStr(new Date(), timeZone), start: '09:00', end: '10:00', durationText: '' });
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const descRef = useRef(null);

  const load = useCallback(async (p = 1, append = false) => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try {
      const [list, run] = await Promise.all([
        endpoints.timeEntries(wsId, viewUser, { page: p, 'page-size': 100, 'in-progress': false }),
        endpoints.runningEntry(wsId, viewUser),
      ]);
      setEntries((old) => (append ? [...old, ...list] : list));
      setHasMore(list.length === 100);
      setRunning(run);
      if (run && viewUser === user.id) setForm({ description: run.description, projectId: run.projectId, taskId: run.taskId, tagIds: run.tagIds || [], billable: run.billable, type: run.type });
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, viewUser, user.id]);

  useEffect(() => { setPage(1); load(1); }, [load]);
  useEffect(() => { const id = setInterval(() => endpoints.runningEntry(wsId, viewUser).then(setRunning).catch(() => {}), 30000); return () => clearInterval(id); }, [wsId, viewUser]);

  // Project default billable
  useEffect(() => {
    if (!form.projectId || running) return;
    const p = projects.find((x) => x.id === form.projectId);
    if (p) setF('billable', !!p.billable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.projectId, projects]);

  async function start() {
    try {
      const e = await endpoints.createEntry(wsId, { ...form, start: new Date().toISOString() });
      setRunning(e); toast('Timer iniciado');
    } catch (err) { toast(errorMessage(err), 'error'); }
  }
  async function stop() {
    try {
      await endpoints.stopTimer(wsId, viewUser);
      setRunning(null); setForm({ description: '', projectId: null, taskId: null, tagIds: [], billable: false, type: 'REGULAR' });
      load(1);
    } catch (err) { toast(errorMessage(err), 'error'); }
  }
  async function discard() {
    if (!running || !window.confirm('Descartar o timer em andamento?')) return;
    await endpoints.deleteEntry(wsId, running.id); setRunning(null); setForm({ description: '', projectId: null, taskId: null, tagIds: [], billable: false, type: 'REGULAR' });
  }
  async function saveRunningField(patch) {
    if (!running) return;
    try { const e = await endpoints.patchEntry(wsId, running.id, patch); setRunning(e); } catch (err) { toast(errorMessage(err), 'error'); }
  }
  async function addManual() {
    try {
      let endIso; const startIso = localToIso(manual.date, manual.start, timeZone);
      const secs = parseDuration(manual.durationText);
      if (secs != null && manual.durationText) endIso = new Date(new Date(startIso).getTime() + secs * 1000).toISOString();
      else endIso = localToIso(manual.date, manual.end, timeZone);
      if (new Date(endIso) <= new Date(startIso)) endIso = new Date(new Date(endIso).getTime() + 86400000).toISOString();
      const body = { ...form, start: startIso, end: endIso };
      const e = viewUser === user.id ? await endpoints.createEntry(wsId, body) : await endpoints.createEntryFor(wsId, viewUser, body);
      setEntries((l) => [e, ...l].sort((a, b) => new Date(b.timeInterval.start) - new Date(a.timeInterval.start)));
      setForm({ description: '', projectId: null, taskId: null, tagIds: [], billable: false, type: 'REGULAR' }); setManual((m) => ({ ...m, durationText: '' }));
      toast('Registro adicionado');
    } catch (err) { toast(errorMessage(err), 'error'); }
  }
  async function continueEntry(e) {
    try { const r = await endpoints.continueEntry(wsId, viewUser, e.id); setRunning(r); setForm({ description: r.description, projectId: r.projectId, taskId: r.taskId, tagIds: r.tagIds, billable: r.billable, type: r.type }); setMode('timer'); } catch (err) { toast(errorMessage(err), 'error'); }
  }
  async function duplicate(e) {
    try { const r = await endpoints.duplicateEntry(wsId, viewUser, e.id); setEntries((l) => [r, ...l].sort((a, b) => new Date(b.timeInterval.start) - new Date(a.timeInterval.start))); } catch (err) { toast(errorMessage(err), 'error'); }
  }
  async function remove(e) {
    if (!window.confirm('Excluir este registro?')) return;
    try { await endpoints.deleteEntry(wsId, e.id); setEntries((l) => l.filter((x) => x.id !== e.id)); } catch (err) { toast(errorMessage(err), 'error'); }
  }
  async function inlineUpdate(e, patch) {
    try { const r = await endpoints.patchEntry(wsId, e.id, patch); setEntries((l) => l.map((x) => (x.id === r.id ? { ...x, ...r, project: x.project && r.projectId === x.projectId ? x.project : undefined } : x))); if (r.projectId !== e.projectId || r.taskId !== e.taskId) load(1); } catch (err) { toast(errorMessage(err), 'error'); load(1); }
  }

  // Group by day; similar entries grouped when setting enabled
  const days = useMemo(() => {
    const map = new Map();
    for (const e of entries) {
      const d = toLocalDateStr(e.timeInterval.start, timeZone);
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(e);
    }
    return [...map.entries()];
  }, [entries, timeZone]);
  const weekTotal = useMemo(() => {
    const today = toLocalDateStr(new Date(), timeZone); const from = addDays(today, -6);
    return entries.filter((e) => toLocalDateStr(e.timeInterval.start, timeZone) >= from).reduce((s, e) => s + entryDuration(e), 0);
  }, [entries, timeZone]);
  const canManual = settings.timeTrackingMode !== 'STOPWATCH_ONLY' || isAdmin;
  const hour12 = timeFormat === 'HOUR12';

  return (
    <div>
      <div className="page-header">
        <h1>Controle de tempo</h1>
        {isAdmin && users.length > 1 && <select className="right" style={{ width: 'auto' }} value={viewUser} onChange={(e) => setViewUser(e.target.value)}>{users.map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? `${u.name} (eu)` : u.name}</option>)}</select>}
      </div>
      <div className="card">
        <div className="tracker-bar">
          <input ref={descRef} className="desc" placeholder={mode === 'timer' ? 'No que você está trabalhando?' : 'O que você fez?'} value={form.description} onChange={(e) => setF('description', e.target.value)} onBlur={() => running && running.description !== form.description && saveRunningField({ description: form.description })} onKeyDown={(e) => { if (e.key === 'Enter') (mode === 'timer' ? (running ? stop() : start()) : addManual()); }} />
          <ProjectPicker projectId={form.projectId} taskId={form.taskId} onChange={(p, t) => { setF('projectId', p); setF('taskId', t); if (running) saveRunningField({ projectId: p, taskId: t }); }} />
          <TagPicker tagIds={form.tagIds} onChange={(v) => { setF('tagIds', v); if (running) saveRunningField({ tagIds: v }); }} />
          <button type="button" className={`billable ${form.billable ? 'on' : ''}`} title={form.billable ? 'Faturável' : 'Não faturável'} onClick={() => { setF('billable', !form.billable); if (running) saveRunningField({ billable: !form.billable }); }}>$</button>
          <span className="sep" />
          {mode === 'timer' ? (
            <>
              <span className="timer">{running ? fmtDuration(entryDuration(running, now)) : '00:00:00'}</span>
              {running ? <><button className="btn danger" onClick={stop}>Parar</button><Dropdown><button onClick={discard} className="danger">Descartar</button>{settings.breaks !== false && <button onClick={async () => { await stop(); const e = await endpoints.createEntry(wsId, { start: new Date().toISOString(), type: 'BREAK', description: 'Pausa' }); setRunning(e); setForm({ description: 'Pausa', projectId: null, taskId: null, tagIds: [], billable: false, type: 'BREAK' }); }}>Iniciar pausa</button>}</Dropdown></> : <button className="btn" onClick={start} disabled={viewUser !== user.id}>Iniciar</button>}
            </>
          ) : (
            <>
              <input type="time" value={manual.start} onChange={(e) => setManual((m) => ({ ...m, start: e.target.value }))} style={{ width: 100 }} />
              <span className="muted">–</span>
              <input type="time" value={manual.end} onChange={(e) => setManual((m) => ({ ...m, end: e.target.value }))} style={{ width: 100 }} />
              <input type="date" value={manual.date} onChange={(e) => setManual((m) => ({ ...m, date: e.target.value }))} style={{ width: 150 }} />
              <input placeholder="Duração (1:30)" value={manual.durationText} onChange={(e) => setManual((m) => ({ ...m, durationText: e.target.value }))} style={{ width: 120 }} />
              <button className="btn" onClick={addManual}>Adicionar</button>
            </>
          )}
          {canManual && !running && <div className="btn-group"><button className={`btn sm ${mode === 'timer' ? '' : 'secondary'}`} onClick={() => setMode('timer')} title="Timer">⏱</button><button className={`btn sm ${mode === 'manual' ? '' : 'secondary'}`} onClick={() => setMode('manual')} title="Manual">☰</button></div>}
        </div>
      </div>

      <Alert type="error">{error}</Alert>
      <div className="row mt"><span className="muted">Esta semana: <b className="mono">{fmtDuration(weekTotal + (running ? entryDuration(running, now) : 0))}</b></span></div>
      {loading && entries.length === 0 ? <Spinner block /> : null}
      {!loading && entries.length === 0 && !running && <div className="card mt"><Empty title="Nenhum registro ainda">Inicie o timer ou adicione um registro manual acima.</Empty></div>}
      {days.map(([day, list]) => (
        <DayGroup key={day} day={day} list={list} now={now} timeZone={timeZone} hour12={hour12} isAdmin={isAdmin} settings={settings} onEdit={setEditing} onContinue={continueEntry} onDuplicate={duplicate} onDelete={remove} onInline={inlineUpdate} />
      ))}
      {hasMore && <div className="center mt"><button className="btn secondary" onClick={() => { const p = page + 1; setPage(p); load(p, true); }} disabled={loading}>Carregar mais</button></div>}
      {editing && <EntryEditor entry={editing} onClose={() => setEditing(null)} onSaved={() => load(1)} onDeleted={() => load(1)} />}
    </div>
  );
}

function DayGroup({ day, list, now, timeZone, hour12, isAdmin, settings, onEdit, onContinue, onDuplicate, onDelete, onInline }) {
  const total = list.reduce((s, e) => s + entryDuration(e, now), 0);
  const groups = useMemo(() => {
    if (settings.groupSimilarEntriesDisabled) return list.map((e) => [e]);
    const m = new Map();
    for (const e of list) { const k = `${e.description}|${e.projectId}|${e.taskId}|${[...(e.tagIds || [])].sort().join(',')}|${e.billable}|${e.type}`; if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
    return [...m.values()];
  }, [list, settings.groupSimilarEntriesDisabled]);
  const [expanded, setExpanded] = useState({});
  return (
    <div className="day-group">
      <div className="day-head"><span className="bold">{humanDate(day)}</span><span className="right muted">Total: <b className="mono">{fmtDuration(total)}</b></span></div>
      {groups.map((g) => {
        const first = g[0]; const key = first.id; const multi = g.length > 1; const open = expanded[key];
        return (
          <React.Fragment key={key}>
            <EntryRow e={first} group={multi ? g : null} now={now} timeZone={timeZone} hour12={hour12} isAdmin={isAdmin} onEdit={onEdit} onContinue={onContinue} onDuplicate={onDuplicate} onDelete={onDelete} onInline={onInline} onToggle={() => setExpanded((x) => ({ ...x, [key]: !x[key] }))} open={open} />
            {multi && open && g.map((e) => <EntryRow key={e.id} e={e} sub now={now} timeZone={timeZone} hour12={hour12} isAdmin={isAdmin} onEdit={onEdit} onContinue={onContinue} onDuplicate={onDuplicate} onDelete={onDelete} onInline={onInline} />)}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function EntryRow({ e, group, sub, now, timeZone, hour12, isAdmin, onEdit, onContinue, onDuplicate, onDelete, onInline, onToggle, open }) {
  const [desc, setDesc] = useState(e.description);
  useEffect(() => setDesc(e.description), [e.description]);
  const dur = group ? group.reduce((s, x) => s + entryDuration(x, now), 0) : entryDuration(e, now);
  const locked = e.isLocked && !isAdmin;
  const start = toLocalTimeStr(e.timeInterval.start, timeZone, { hour12 });
  const end = e.timeInterval.end ? toLocalTimeStr(e.timeInterval.end, timeZone, { hour12 }) : '…';
  return (
    <div className={`entry-row ${locked ? 'locked' : ''}`} style={sub ? { paddingLeft: 40, background: '#fafcfd' } : undefined}>
      {group ? <span className="count" onClick={onToggle} title="Registros agrupados">{group.length}</span> : (sub ? <span style={{ width: 20 }} /> : null)}
      <div className="desc">
        {group ? <span onClick={onToggle} style={{ cursor: 'pointer' }}>{e.description || <span className="light">(sem descrição)</span>}</span>
          : <input value={desc} placeholder="(sem descrição)" disabled={locked} onChange={(ev) => setDesc(ev.target.value)} onBlur={() => desc !== e.description && onInline(e, { description: desc })} onKeyDown={(ev) => ev.key === 'Enter' && ev.target.blur()} />}
      </div>
      <span onClick={() => !group && !locked && onEdit(e)} style={{ cursor: 'pointer' }}><ProjectLabel project={e.project} task={e.task} /></span>
      {e.tags && e.tags.length > 0 && <span className="tag-list">{e.tags.map((t) => <span key={t.id} className="chip">{t.name}</span>)}</span>}
      {e.type === 'BREAK' && <span className="badge">Pausa</span>}
      {e.type === 'TIME_OFF' && <span className="badge warning">Folga</span>}
      {e.type === 'HOLIDAY' && <span className="badge warning">Feriado</span>}
      {e.isLocked && <span title="Bloqueado">🔒</span>}
      <span className={`billable ${e.billable ? 'on' : ''}`} style={{ fontSize: 16, color: e.billable ? 'var(--primary)' : 'var(--text-light)', padding: '0 6px', cursor: locked || group ? 'default' : 'pointer' }} onClick={() => !locked && !group && onInline(e, { billable: !e.billable })}>$</span>
      <span className="times nowrap" onClick={() => !group && !locked && onEdit(e)} style={{ cursor: 'pointer' }}>{group ? '' : `${start} – ${end}`}</span>
      <span className="dur mono">{fmtDuration(dur)}</span>
      <button className="btn ghost icon" title="Continuar" onClick={() => onContinue(e)}>▶</button>
      <Dropdown>
        {!group && <button onClick={() => onEdit(e)}>Editar</button>}
        {!group && <button onClick={() => onDuplicate(e)}>Duplicar</button>}
        {!group && <button className="danger" onClick={() => onDelete(e)} disabled={locked}>Excluir</button>}
        {group && <button onClick={onToggle}>{open ? 'Recolher' : 'Expandir'} grupo</button>}
      </Dropdown>
    </div>
  );
}
