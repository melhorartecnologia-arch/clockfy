import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, ws } from '../api.js';
import { Spinner, Alert, Modal, Confirm, Tabs, Avatar, ProjectLabel } from '../components/ui.jsx';
import { ProjectPicker, useUsers, useProjects } from '../components/pickers.jsx';
import { useAsync, useLocalState } from '../lib/hooks.js';
import { toLocalDateStr, addDays, startOfWeekStr, fmtDate, weekdayShort, monthName, pad, errorMessage } from '../lib/format.js';
import './Schedule.css';

const TABS = [{ value: 'projects', label: 'Projetos' }, { value: 'team', label: 'Equipe' }];
const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const SERIES_LABEL = { THIS_ONE: 'Somente esta', THIS_AND_FOLLOWING: 'Esta e as seguintes', ALL: 'Toda a série' };
const EXCLUDE_LABEL = { TIME_OFF: 'folga', HOLIDAY: 'feriado', WEEKEND: 'dia não útil' };

const dayOf = (iso) => String(iso).slice(0, 10);
const utc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
const dayName = (s) => DAY_NAMES[new Date(utc(s)).getUTCDay()];
const lastOfMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const hoursText = (h) => `${Number(h).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}h`;
const shortDate = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function useMyRoles(wsId, userId) {
  const { data } = useAsync(() => api.get(`${ws(wsId)}/users/${userId}/roles`), [wsId, userId], { initial: [] });
  return (data || []).map((r) => r.role?.name).filter(Boolean);
}

// Greedy lane packing so overlapping bars stack vertically
function packLanes(list) {
  const lanes = [];
  const out = [];
  for (const a of [...list].sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.end < y.end ? -1 : 1))) {
    let lane = lanes.findIndex((end) => end < a.start);
    if (lane === -1) { lane = lanes.length; lanes.push(a.end); } else lanes[lane] = a.end;
    out.push({ ...a, lane });
  }
  return { items: out, count: Math.max(1, lanes.length) };
}

// Page -----------------------------------------------------------------------------------------------
export default function Schedule() {
  const { '*': sub } = useParams();
  const navigate = useNavigate();
  const { workspace, user, isAdmin, timeZone, weekStart, toast } = useStore();
  const wsId = workspace?.id;
  const view = TABS.some((t) => t.value === sub) ? sub : 'projects';
  const roles = useMyRoles(wsId, user.id);
  const canEdit = isAdmin || roles.includes('PROJECT_MANAGER');
  const today = toLocalDateStr(new Date(), timeZone);
  const [zoom, setZoom] = useLocalState('clockfy.scheduleZoom', 'week');
  const [anchor, setAnchor] = useState(today);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('ALL');
  const [modal, setModal] = useState(null); // { type: 'assignment' | 'milestone' | 'publish' | 'copy', ... }
  const [confirm, setConfirm] = useState(null);
  const users = useUsers(wsId);
  const projects = useProjects(wsId);

  const range = useMemo(() => {
    const start = zoom === 'month' ? `${anchor.slice(0, 7)}-01` : startOfWeekStr(anchor, weekStart);
    const end = zoom === 'month' ? lastOfMonth(anchor.slice(0, 7)) : addDays(start, 6);
    const days = []; for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    return { start, end, days };
  }, [anchor, zoom, weekStart]);
  const move = (dir) => setAnchor(zoom === 'month' ? (dir > 0 ? addDays(lastOfMonth(anchor.slice(0, 7)), 1) : addDays(`${anchor.slice(0, 7)}-01`, -1)) : addDays(range.start, 7 * dir));

  const { data, loading, error, reload } = useAsync(async () => {
    const q0 = { start: range.start, end: range.end };
    const [all, totals, milestones] = await Promise.all([
      api.get(`${ws(wsId)}/scheduling/assignments/all`, { ...q0, 'page-size': 5000, 'sort-column': 'PROJECT' }),
      view === 'projects' ? api.post(`${ws(wsId)}/scheduling/assignments/projects/totals`, { ...q0, pageSize: 1000 }) : api.post(`${ws(wsId)}/scheduling/assignments/user-filter/totals`, { ...q0, pageSize: 1000 }),
      api.get(`${ws(wsId)}/scheduling/milestones`, q0).catch(() => []),
    ]);
    return { all, totals, milestones };
  }, [wsId, view, range.start, range.end], { initial: null });

  const assignments = useMemo(() => (data?.all || []).filter((a) => status === 'ALL' || (status === 'PUBLISHED') === a.published).map((a) => ({ ...a, start: dayOf(a.period.start), end: dayOf(a.period.end), excluded: new Set((a.excludeDays || []).map((x) => dayOf(x.date))) })), [data, status]);
  const filter = (label) => !q || label.toLowerCase().includes(q.toLowerCase());
  const dayHoursOf = (list) => range.days.map((d) => list.reduce((s, a) => (a.start <= d && a.end >= d && !a.excluded.has(d) ? s + a.hoursPerDay : s), 0));

  const rows = useMemo(() => {
    if (!data) return [];
    if (view === 'projects') {
      const byProject = new Map();
      for (const t of data.totals) byProject.set(t.projectId, { key: t.projectId, project: { id: t.projectId, name: t.projectName, color: t.projectColor, clientName: t.clientName }, totalHours: t.totalHours, milestones: t.milestones || [] });
      for (const m of data.milestones || []) {
        if (!byProject.has(m.projectId)) { const p = projects.find((x) => x.id === m.projectId); byProject.set(m.projectId, { key: m.projectId, project: p ? { id: p.id, name: p.name, color: p.color, clientName: p.clientName } : { id: m.projectId, name: 'Projeto', color: '#999' }, totalHours: 0, milestones: [] }); }
        const r = byProject.get(m.projectId); if (!r.milestones.some((x) => x.id === m.id)) r.milestones.push(m);
      }
      return [...byProject.values()].map((r) => ({ ...r, label: `${r.project.name} ${r.project.clientName || ''}`, list: assignments.filter((a) => a.projectId === r.key) }))
        .map((r) => ({ ...r, dayHours: dayHoursOf(r.list) }))
        .map((r) => ({ ...r, total: r.dayHours.reduce((s, h) => s + h, 0) }))
        .filter((r) => filter(r.label) && (status === 'ALL' || r.list.length))
        .sort((a, b) => a.project.name.localeCompare(b.project.name));
    }
    return data.totals.map((u) => ({ key: u.userId, user: { id: u.userId, name: u.userName, profilePicture: u.userImage }, capacity: u.capacityPerDay, workingDays: u.workingDays || [], label: u.userName, list: assignments.filter((a) => a.userId === u.userId), serverHours: (u.totalHoursPerDay || []).map((x) => x.totalHours) }))
      .map((r) => ({ ...r, dayHours: status === 'ALL' ? r.serverHours : dayHoursOf(r.list) }))
      .map((r) => ({ ...r, total: r.dayHours.reduce((s, h) => s + h, 0) }))
      .filter((r) => filter(r.label))
      .sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, view, assignments, q, status, projects, range.days]);
  const footer = useMemo(() => range.days.map((_, i) => rows.reduce((s, r) => s + (r.dayHours[i] || 0), 0)), [rows, range.days]);
  const unpublished = (data?.all || []).filter((a) => !a.published).length;

  async function run(fn, msg) { try { const r = await fn(); if (msg) toast(msg, 'success'); reload(); return r; } catch (e) { toast(errorMessage(e), 'error'); throw e; } }
  function remove(a, option) {
    const series = !!a.recurring?.seriesId;
    if (series) return run(() => api.delete(`${ws(wsId)}/scheduling/assignments/recurring/${a.id}?seriesUpdateOption=${option || 'THIS_ONE'}`), 'Atribuição excluída');
    return run(() => api.delete(`${ws(wsId)}/scheduling/assignments/${a.id}`), 'Atribuição excluída');
  }
  const openCreate = (defaults) => canEdit && setModal({ type: 'assignment', defaults });
  const openBar = (a) => setModal({ type: 'assignment', assignment: a });

  return (
    <div>
      <div className="page-header">
        <h1>Agenda</h1>
        <div className="btn-group">
          <button className="btn secondary sm" onClick={() => move(-1)} title="Anterior">‹</button>
          <button className="btn secondary sm" onClick={() => setAnchor(today)}>Hoje</button>
          <button className="btn secondary sm" onClick={() => move(1)} title="Próximo">›</button>
        </div>
        <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={{ width: 150 }} />
        <span className="muted">{zoom === 'month' ? cap(monthName(range.start)) : `${fmtDate(range.start)} – ${fmtDate(range.end)}`}</span>
        <div className="btn-group"><button className={`btn sm ${zoom === 'week' ? '' : 'secondary'}`} onClick={() => setZoom('week')}>Semana</button><button className={`btn sm ${zoom === 'month' ? '' : 'secondary'}`} onClick={() => setZoom('month')}>Mês</button></div>
        <div className="right row gap wrap">
          {canEdit && <button className="btn secondary" onClick={() => setModal({ type: 'milestone' })}>+ Marco</button>}
          {canEdit && <button className="btn secondary" onClick={() => openCreate({})}>+ Atribuição</button>}
          {canEdit && <button className="btn" onClick={() => setModal({ type: 'publish' })} title={unpublished ? `${unpublished} não publicada(s) no período` : 'Nada a publicar no período'}>Publicar{unpublished ? ` (${unpublished})` : ''}</button>}
        </div>
      </div>
      <Tabs tabs={TABS} value={view} onChange={(t) => navigate(`/schedule/${t}`)} />
      <div className="row gap wrap mb">
        <input type="search" placeholder={view === 'projects' ? 'Buscar projeto…' : 'Buscar membro…'} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="ALL">Todas</option><option value="PUBLISHED">Publicadas</option><option value="UNPUBLISHED">Não publicadas</option></select>
        {loading && <Spinner />}
        <div className="sched-legend right">
          <span><span className="sw" />Publicada</span><span><span className="sw unpub" />Não publicada</span>{view === 'team' && <span><span className="sw over" />Acima da capacidade</span>}<span>◆ Marco</span>
        </div>
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      {!data && loading ? <Spinner block /> : (
        <div className={`sched zoom-${zoom}`} style={{ '--sched-n': range.days.length }}>
          <div className="sched-head">
            <div className="sched-corner">{view === 'projects' ? 'Projeto' : 'Membro'} · total no período</div>
            <div className="sched-days">{range.days.map((d) => <div key={d} className={`sched-day ${d === today ? 'today' : ''} ${['SATURDAY', 'SUNDAY'].includes(dayName(d)) ? 'off' : ''}`}>{weekdayShort(d)}<b>{zoom === 'month' ? d.slice(8, 10) : shortDate(d)}</b></div>)}</div>
          </div>
          {rows.length === 0 && (
            <div className="sched-empty">
              <div className="bold">Nenhuma atribuição neste período</div>
              <div className="small mt">{canEdit ? 'Clique em um dia da grade ou em “+ Atribuição” para planejar a alocação da equipe.' : 'Quando sua agenda for publicada, ela aparecerá aqui.'}</div>
            </div>
          )}
          {rows.map((r) => <Row key={r.key} row={r} view={view} range={range} today={today} canEdit={canEdit} onCell={(d) => openCreate(view === 'projects' ? { projectId: r.key, start: d, end: d } : { userId: r.key, start: d, end: d })} onBar={openBar} onMilestone={(m) => canEdit && setModal({ type: 'milestone', milestone: m })} />)}
          {rows.length > 0 && (
            <div className="sched-foot">
              <div className="sched-label"><span className="bold">Total por dia</span><span className="sub">{hoursText(footer.reduce((s, h) => s + h, 0))} no período</span></div>
              <div className="sched-totals">{footer.map((h, i) => <div key={range.days[i]} className={`sched-total ${h ? '' : 'empty'}`}>{h ? hoursText(h) : '–'}</div>)}</div>
            </div>
          )}
        </div>
      )}

      {modal?.type === 'assignment' && (
        <AssignmentModal assignment={modal.assignment} defaults={modal.defaults} users={users} readOnly={!canEdit} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); reload(); }}
          onDelete={(a, option) => setConfirm({ title: 'Excluir atribuição', danger: true, confirmLabel: 'Excluir', message: a.recurring?.seriesId ? `Excluir ${SERIES_LABEL[option].toLowerCase()} da série de ${a.userName} em ${a.projectName}?` : `Excluir a atribuição de ${a.userName} em ${a.projectName} (${fmtDate(dayOf(a.period.start))} – ${fmtDate(dayOf(a.period.end))})?`, onConfirm: async () => { await remove(a, option); setModal(null); } })}
          onCopy={(a) => setModal({ type: 'copy', assignment: a })} />
      )}
      {modal?.type === 'copy' && <CopyModal assignment={modal.assignment} users={users} onClose={() => setModal({ type: 'assignment', assignment: modal.assignment })} onDone={() => { setModal(null); reload(); }} />}
      {modal?.type === 'milestone' && <MilestoneModal milestone={modal.milestone} projects={projects} defaultDate={range.start} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {modal?.type === 'publish' && <PublishModal range={range} view={view} count={unpublished} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// Timeline row -----------------------------------------------------------------------------------------
function Row({ row: r, view, range, today, canEdit, onCell, onBar, onMilestone }) {
  const n = range.days.length;
  const { items, count } = useMemo(() => packLanes(r.list), [r.list]);
  const working = (d) => (view === 'team' ? r.workingDays.includes(dayName(d)) : !['SATURDAY', 'SUNDAY'].includes(dayName(d)));
  const milestones = (r.milestones || []).map((m) => ({ ...m, day: dayOf(m.date) })).filter((m) => m.day >= range.start && m.day <= range.end);
  return (
    <div className="sched-row">
      <div className="sched-label">
        {view === 'projects' ? <ProjectLabel project={r.project} /> : <span className="row gap"><Avatar user={r.user} size={24} /><span className="truncate">{r.user.name}</span></span>}
        <span className="sub">{hoursText(r.total)} no período{view === 'team' ? ` · capacidade ${hoursText(r.capacity)}/dia` : r.list.length ? ` · ${r.list.length} atribuição(ões)` : ''}</span>
      </div>
      <div>
        {milestones.length > 0 && (
          <div className="sched-ms">
            {milestones.map((m) => <div key={m.id} className={`sched-ms-marker ${canEdit ? '' : 'readonly'}`} style={{ gridColumn: `${daysBetween(range.start, m.day) + 1} / ${n + 1}`, gridRow: 1 }} title={`${m.name} – ${fmtDate(m.day)}`} onClick={() => onMilestone(m)}>◆ <span className="truncate">{m.name}</span></div>)}
          </div>
        )}
        <div className="sched-lanes" style={{ gridTemplateRows: `repeat(${count}, var(--sched-lane))` }}>
          {range.days.map((d, i) => <div key={d} className={`sched-cell ${canEdit ? 'clickable' : ''} ${d === today ? 'today' : ''} ${working(d) ? '' : 'off'}`} style={{ gridColumn: i + 1, gridRow: `1 / ${count + 1}` }} title={canEdit ? `Nova atribuição em ${fmtDate(d)}` : undefined} onClick={() => canEdit && onCell(d)} />)}
          {items.map((a) => {
            const cs = Math.max(0, daysBetween(range.start, a.start)); const ce = Math.min(n - 1, daysBetween(range.start, a.end));
            if (ce < cs) return null;
            const title = `${a.userName} · ${a.projectName}${a.taskName ? ` / ${a.taskName}` : ''}\n${fmtDate(a.start)} – ${fmtDate(a.end)} · ${hoursText(a.hoursPerDay)}/dia${a.startTime ? ` às ${a.startTime.slice(0, 5)}` : ''}${a.note ? `\n${a.note}` : ''}${a.published ? '' : '\n(não publicada)'}`;
            return (
              <div key={a.id} className={`sched-bar ${a.published ? '' : 'unpub'} ${a.start < range.start ? 'clip-start' : ''} ${a.end > range.end ? 'clip-end' : ''} ${canEdit ? '' : 'readonly'}`} style={{ gridColumn: `${cs + 1} / ${ce + 2}`, gridRow: a.lane + 1, background: a.projectColor || 'var(--primary)' }} title={title} onClick={() => onBar(a)}>
                <span className="t">{view === 'projects' ? a.userName : `${a.projectName}${a.taskName ? `: ${a.taskName}` : ''}`}</span>
                <span className="h">{hoursText(a.hoursPerDay)}/dia</span>
                {a.recurring?.seriesId && <span className="ico" title="Recorrente">↻</span>}
                {a.note && <span className="ico" title={a.note}>✎</span>}
              </div>
            );
          })}
        </div>
        <div className="sched-totals">
          {range.days.map((d, i) => {
            const h = r.dayHours[i] || 0; const off = !working(d);
            const cls = view === 'team' ? (h > r.capacity ? 'over' : h === r.capacity && h > 0 ? 'full' : h ? '' : 'empty') : (h ? '' : 'empty');
            return <div key={d} className={`sched-total ${cls} ${off && !h ? 'off' : ''}`} title={view === 'team' ? `${hoursText(h)} de ${hoursText(r.capacity)}` : hoursText(h)}>{h ? hoursText(h) : off ? '' : '–'}</div>;
          })}
        </div>
      </div>
    </div>
  );
}

// Assignment modal --------------------------------------------------------------------------------------
function AssignmentModal({ assignment: a, defaults = {}, users, readOnly, onClose, onSaved, onDelete, onCopy }) {
  const { workspace, user, timeZone, toast } = useStore();
  const wsId = workspace.id;
  const today = toLocalDateStr(new Date(), timeZone);
  const isSeries = !!a?.recurring?.seriesId;
  const [f, setF] = useState(() => (a ? {
    projectId: a.projectId, taskId: a.taskId || null, userId: a.userId, start: dayOf(a.period.start), end: dayOf(a.period.end), hoursPerDay: String(a.hoursPerDay), startTime: a.startTime ? a.startTime.slice(0, 5) : '',
    includeNonWorkingDays: !!a.includeNonWorkingDays, billable: a.billable == null ? '' : String(a.billable), note: a.note || '', recurring: false, weeks: a.recurring?.weeks || 1, publish: a.published, seriesOption: 'THIS_ONE',
  } : {
    projectId: defaults.projectId || null, taskId: null, userId: defaults.userId || users[0]?.id || user.id, start: defaults.start || today, end: defaults.end || defaults.start || today, hoursPerDay: '8', startTime: '',
    includeNonWorkingDays: false, billable: '', note: '', recurring: false, weeks: 4, publish: false, seriesOption: 'THIS_ONE',
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const days = f.start && f.end && f.end >= f.start ? daysBetween(f.start, f.end) + 1 : 0;

  async function save() {
    setBusy(true); setError(null);
    try {
      if (!f.projectId) throw new Error('Selecione o projeto');
      if (!f.userId) throw new Error('Selecione o membro');
      if (!f.start || !f.end) throw new Error('Informe o período');
      if (f.end < f.start) throw new Error('O fim deve ser depois do início');
      const hours = Number(String(f.hoursPerDay).replace(',', '.'));
      if (!(hours > 0) || hours > 24) throw new Error('Horas por dia deve estar entre 0 e 24');
      const body = { projectId: f.projectId, taskId: f.taskId || null, userId: f.userId, start: f.start, end: f.end, hoursPerDay: hours, startTime: f.startTime ? `${f.startTime}:00` : null, includeNonWorkingDays: f.includeNonWorkingDays, billable: f.billable === '' ? null : f.billable === 'true', note: f.note || null };
      if (a) {
        if (isSeries) await api.patch(`${ws(wsId)}/scheduling/assignments/recurring/${a.id}`, { ...body, seriesUpdateOption: f.seriesOption });
        else await api.put(`${ws(wsId)}/scheduling/assignments/${a.id}`, body);
        toast('Atribuição atualizada', 'success');
      } else {
        const weeks = f.recurring ? Math.max(1, Number(f.weeks) || 1) : 1;
        if (weeks > 1) await api.post(`${ws(wsId)}/scheduling/assignments/recurring`, { ...body, published: f.publish, recurringAssignment: { weeks, repeat: true } });
        else await api.post(`${ws(wsId)}/scheduling/assignments`, { ...body, published: f.publish });
        toast(weeks > 1 ? `${weeks} atribuições criadas` : 'Atribuição criada', 'success');
      }
      onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const excluded = (a?.excludeDays || []).map((x) => `${fmtDate(dayOf(x.date))} (${EXCLUDE_LABEL[x.type] || x.type})`);
  const userOptions = users.length ? users : (a ? [{ id: a.userId, name: a.userName }] : [user]);
  const title = readOnly ? 'Atribuição' : a ? 'Editar atribuição' : 'Nova atribuição';
  return (
    <Modal title={title} onClose={onClose} footer={<>
      {a && !readOnly && <button className="btn ghost" style={{ color: 'var(--danger)', marginRight: 'auto' }} disabled={busy} onClick={() => onDelete(a, f.seriesOption)}>Excluir</button>}
      {a && !readOnly && <button className="btn ghost" disabled={busy} onClick={() => onCopy(a)}>Copiar para…</button>}
      <button className="btn ghost" onClick={onClose}>{readOnly ? 'Fechar' : 'Cancelar'}</button>
      {!readOnly && <button className="btn" disabled={busy} onClick={save}>{a ? 'Salvar' : 'Criar'}</button>}
    </>}>
      <Alert type="error">{error}</Alert>
      {a && <div className="row gap wrap mb small">
        <span className={`badge ${a.published ? 'success' : 'warning'}`}>{a.published ? 'Publicada' : 'Não publicada'}</span>
        {isSeries && <span className="badge primary">Série semanal · {a.recurring.weeks} semana(s)</span>}
        {a.billable != null && <span className="badge">{a.billable ? 'Faturável' : 'Não faturável'}</span>}
      </div>}
      <div className="grid cols-2">
        <div className="field"><label>Projeto / tarefa</label>{readOnly ? <ProjectLabel project={{ id: a.projectId, name: a.projectName, color: a.projectColor, clientName: a.clientName }} task={a.taskName ? { name: a.taskName } : null} /> : <ProjectPicker projectId={f.projectId} taskId={f.taskId} onChange={(p, t) => { set('projectId', p); set('taskId', t); }} allowCreate={false} placeholder="Selecionar projeto" />}</div>
        <div className="field"><label>Membro</label><select value={f.userId} disabled={readOnly} onChange={(e) => set('userId', e.target.value)}>{userOptions.map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? `${u.name} (eu)` : u.name}</option>)}</select></div>
      </div>
      <div className="grid cols-3">
        <div className="field"><label>Início</label><input type="date" value={f.start} disabled={readOnly} onChange={(e) => { set('start', e.target.value); if (f.end < e.target.value) set('end', e.target.value); }} /></div>
        <div className="field"><label>Fim</label><input type="date" value={f.end} min={f.start} disabled={readOnly} onChange={(e) => set('end', e.target.value)} /></div>
        <div className="field"><label>Horas por dia</label><input type="number" min="0.5" max="24" step="0.5" value={f.hoursPerDay} disabled={readOnly} onChange={(e) => set('hoursPerDay', e.target.value)} /></div>
      </div>
      <div className="grid cols-3">
        <div className="field"><label>Hora de início</label><input type="time" value={f.startTime} disabled={readOnly} onChange={(e) => set('startTime', e.target.value)} /></div>
        <div className="field"><label>Faturável</label><select value={f.billable} disabled={readOnly} onChange={(e) => set('billable', e.target.value)}><option value="">Padrão do projeto</option><option value="true">Sim</option><option value="false">Não</option></select></div>
        <div className="field"><label>Dias não úteis</label><label className="checkbox" style={{ paddingTop: 7 }}><input type="checkbox" checked={f.includeNonWorkingDays} disabled={readOnly} onChange={(e) => set('includeNonWorkingDays', e.target.checked)} /> Incluir</label></div>
      </div>
      <div className="field"><label>Nota</label><textarea value={f.note} disabled={readOnly} onChange={(e) => set('note', e.target.value)} placeholder="Observações para o membro (opcional)" /></div>
      {!a && !readOnly && (
        <div className="row gap wrap mb">
          <label className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" checked={f.recurring} onChange={(e) => set('recurring', e.target.checked)} /> Repetir semanalmente</label>
          {f.recurring && <><span className="muted">por</span><input type="number" min="1" max="260" value={f.weeks} onChange={(e) => set('weeks', e.target.value)} style={{ width: 80 }} /><span className="muted">semanas</span></>}
          <label className="checkbox" style={{ marginBottom: 0, marginLeft: 'auto' }}><input type="checkbox" checked={f.publish} onChange={(e) => set('publish', e.target.checked)} /> Publicar imediatamente</label>
        </div>
      )}
      {a && isSeries && !readOnly && <div className="field"><label>Aplicar alterações / exclusão a</label><select value={f.seriesOption} onChange={(e) => set('seriesOption', e.target.value)}>{Object.entries(SERIES_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>}
      <div className="small light">{days ? `${days} dia(s) no período` : ''}{excluded.length ? ` · excluídos: ${excluded.join(', ')}` : ''}</div>
    </Modal>
  );
}

function CopyModal({ assignment: a, users, onClose, onDone }) {
  const { workspace, user, toast } = useStore();
  const [userId, setUserId] = useState(users.find((u) => u.id !== a.userId)?.id || user.id);
  const [option, setOption] = useState('THIS_ONE');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { const r = await api.post(`${ws(workspace.id)}/scheduling/assignments/${a.id}/copy`, { userId, seriesUpdateOption: option }); toast(`${r.length} atribuição(ões) copiada(s)`, 'success'); onDone(); } catch (e) { toast(errorMessage(e), 'error'); setBusy(false); }
  }
  return (
    <Modal title="Copiar atribuição para outro membro" size="sm" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Voltar</button><button className="btn" disabled={busy} onClick={go}>Copiar</button></>}>
      <p className="small muted">{a.projectName} · {fmtDate(dayOf(a.period.start))} – {fmtDate(dayOf(a.period.end))} · {hoursText(a.hoursPerDay)}/dia. A cópia é criada como não publicada.</p>
      <div className="field"><label>Membro</label><select value={userId} onChange={(e) => setUserId(e.target.value)}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      {a.recurring?.seriesId && <div className="field"><label>Copiar</label><select value={option} onChange={(e) => setOption(e.target.value)}>{Object.entries(SERIES_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>}
    </Modal>
  );
}

// Milestones ----------------------------------------------------------------------------------------------
function MilestoneModal({ milestone: m, projects, defaultDate, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const wsId = workspace.id;
  const [f, setF] = useState({ projectId: m?.projectId || projects[0]?.id || '', name: m?.name || '', date: m ? dayOf(m.date) : defaultDate });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function save() {
    setBusy(true); setError(null);
    try {
      if (!f.projectId) throw new Error('Selecione o projeto');
      if (!f.name.trim()) throw new Error('Informe o nome do marco');
      if (!f.date) throw new Error('Informe a data');
      if (m) await api.put(`${ws(wsId)}/scheduling/milestones/${m.id}`, { projectId: f.projectId, name: f.name.trim(), date: f.date });
      else await api.post(`${ws(wsId)}/scheduling/milestones`, { projectId: f.projectId, name: f.name.trim(), date: f.date });
      toast(m ? 'Marco atualizado' : 'Marco criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove() {
    try { await api.delete(`${ws(wsId)}/scheduling/milestones/${m.id}`); toast('Marco excluído', 'success'); onSaved(); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  return (
    <Modal title={m ? 'Editar marco' : 'Novo marco'} size="sm" onClose={onClose} footer={<>
      {m && <button className="btn ghost" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={() => setConfirm(true)}>Excluir</button>}
      <button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{m ? 'Salvar' : 'Criar'}</button>
    </>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Projeto</label><select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">Selecionar…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.clientName ? ` – ${p.clientName}` : ''}</option>)}</select></div>
      <div className="field"><label>Nome</label><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Entrega da fase 1" autoFocus /></div>
      <div className="field"><label>Data</label><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
      {confirm && <Confirm title="Excluir marco" danger confirmLabel="Excluir" message={`Excluir o marco “${m.name}”?`} onConfirm={remove} onClose={() => setConfirm(false)} />}
    </Modal>
  );
}

// Publish -------------------------------------------------------------------------------------------------
function PublishModal({ range, view, count, onClose, onDone }) {
  const { workspace, toast } = useStore();
  const [f, setF] = useState({ start: range.start, end: range.end, notifyUsers: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function go() {
    setBusy(true); setError(null);
    try {
      const r = await api.put(`${ws(workspace.id)}/scheduling/assignments/publish`, { start: f.start, end: f.end, notifyUsers: f.notifyUsers, viewType: view === 'team' ? 'TEAM' : 'PROJECTS' });
      toast(r.published ? `${r.published} atribuição(ões) publicada(s) para ${r.userIds.length} membro(s)` : 'Nenhuma atribuição pendente de publicação no período', r.published ? 'success' : 'info');
      onDone();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return (
    <Modal title="Publicar agenda" size="sm" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={go}>Publicar</button></>}>
      <Alert type="error">{error}</Alert>
      <p className="small muted">Publicar torna as atribuições visíveis aos membros. No período exibido há <b>{count}</b> atribuição(ões) não publicada(s).</p>
      <div className="grid cols-2">
        <div className="field"><label>De</label><input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></div>
        <div className="field"><label>Até</label><input type="date" value={f.end} min={f.start} onChange={(e) => setF({ ...f, end: e.target.value })} /></div>
      </div>
      <label className="checkbox"><input type="checkbox" checked={f.notifyUsers} onChange={(e) => setF({ ...f, notifyUsers: e.target.checked })} /> Notificar os membros (in-app e e-mail)</label>
    </Modal>
  );
}
