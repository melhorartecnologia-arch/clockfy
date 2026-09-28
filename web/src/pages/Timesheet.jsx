import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { ProjectPicker, useProjects, useUsers } from '../components/pickers.jsx';
import { Spinner, Alert, Modal, Confirm, ProjectLabel } from '../components/ui.jsx';
import EntryEditor from '../components/EntryEditor.jsx';
import { fmtDuration, entryDuration, toLocalDateStr, toLocalTimeStr, localToIso, parseDuration, addDays, startOfWeekStr, weekdayShort, fmtDate, errorMessage } from '../lib/format.js';

const shortDate = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const rowKey = (projectId, taskId, description = '') => `${projectId || ''}|${taskId || ''}|${(description || '').trim()}`;

export default function Timesheet() {
  const { workspace, user, timeZone, weekStart, settings, userSettings, isAdmin, toast, dateFormat } = useStore();
  const wsId = workspace?.id;
  const today = toLocalDateStr(new Date(), timeZone);
  const [weekOf, setWeekOf] = useState(() => startOfWeekStr(today, weekStart));
  const [viewUser, setViewUser] = useState(user.id);
  const users = useUsers(isAdmin ? wsId : null);
  const projects = useProjects(wsId);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [extraRows, setExtraRows] = useState([]); // blank rows added manually (reset when the viewed user changes)
  const [adding, setAdding] = useState(false);
  const [multi, setMulti] = useState(null); // { row, day, list }
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setWeekOf((w) => startOfWeekStr(w, weekStart)); }, [weekStart]);
  useEffect(() => { setExtraRows([]); }, [viewUser]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekOf, i)), [weekOf]);
  const weekEnd = days[6];
  const startIso = localToIso(weekOf, '00:00', timeZone);
  const endIso = localToIso(addDays(weekEnd, 1), '00:00', timeZone);

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try {
      const list = await endpoints.timeEntries(wsId, viewUser, { start: startIso, end: endIso, hydrated: true, 'page-size': 2000, 'in-progress': false });
      setEntries(list.filter((e) => e.type !== 'BREAK'));
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, viewUser, startIso, endIso]);
  useEffect(() => { load(); }, [load]);

  // Rows = project/task (+ optional description) combinations
  const rows = useMemo(() => {
    const map = new Map();
    const ensure = (key, meta) => { if (!map.has(key)) map.set(key, { key, ...meta, cells: Object.fromEntries(days.map((d) => [d, []])) }); return map.get(key); };
    for (const r of extraRows) ensure(r.key, { projectId: r.projectId, taskId: r.taskId, description: r.description || '', project: r.project, task: r.task });
    for (const e of entries) {
      const d = toLocalDateStr(e.timeInterval.start, timeZone);
      if (!days.includes(d)) continue;
      const withDesc = rowKey(e.projectId, e.taskId, e.description);
      const plain = rowKey(e.projectId, e.taskId, '');
      const key = map.has(withDesc) ? withDesc : plain;
      const row = ensure(key, { projectId: e.projectId, taskId: e.taskId, description: key === withDesc ? (e.description || '').trim() : '', project: e.project, task: e.task });
      if (!row.project && e.project) row.project = e.project;
      if (!row.task && e.task) row.task = e.task;
      row.cells[d].push(e);
    }
    return [...map.values()].sort((a, b) => (a.project?.name || 'zzz').localeCompare(b.project?.name || 'zzz') || (a.task?.name || '').localeCompare(b.task?.name || '') || a.description.localeCompare(b.description));
  }, [entries, extraRows, days, timeZone]);

  const cellTotal = (list) => list.reduce((s, e) => s + entryDuration(e), 0);
  const dayTotals = days.map((d) => rows.reduce((s, r) => s + cellTotal(r.cells[d]), 0));
  const weekTotal = dayTotals.reduce((a, b) => a + b, 0);
  const startOfDay = userSettings.myStartOfDay || '09:00';
  const isMe = viewUser === user.id;
  const createEntry = (body) => (isMe ? endpoints.createEntry(wsId, body) : endpoints.createEntryFor(wsId, viewUser, body));

  async function saveCell(row, day, text) {
    const secs = parseDuration(text);
    const list = row.cells[day];
    const current = cellTotal(list);
    if (secs == null && text.trim() !== '') { toast('Duração inválida. Use 1:30, 1h30m ou 1.5', 'error'); return; }
    const target = secs == null ? 0 : secs;
    if (target === current) return;
    try {
      if (list.length === 0) {
        if (target <= 0) return;
        const start = localToIso(day, startOfDay, timeZone);
        const project = row.project || projects.find((p) => p.id === row.projectId);
        const e = await createEntry({ start, end: new Date(new Date(start).getTime() + target * 1000).toISOString(), projectId: row.projectId || null, taskId: row.taskId || null, description: row.description || '', billable: !!project?.billable });
        setEntries((l) => [...l, { ...e, project: e.project || project || null, task: e.task || row.task || null }]);
      } else if (list.length === 1) {
        const e = list[0];
        if (target <= 0) {
          await endpoints.deleteEntry(wsId, e.id);
          setEntries((l) => l.filter((x) => x.id !== e.id));
          toast('Registro excluído');
        } else {
          const end = new Date(new Date(e.timeInterval.start).getTime() + target * 1000).toISOString();
          const r = await endpoints.patchEntry(wsId, e.id, { end });
          setEntries((l) => l.map((x) => (x.id === e.id ? { ...x, timeInterval: r.timeInterval } : x)));
        }
      } else {
        setMulti({ row, day, list });
      }
    } catch (err) { toast(errorMessage(err), 'error'); load(); }
  }

  function addRow(projectId, taskId, description) {
    const key = rowKey(projectId, taskId, description);
    if (rows.some((r) => r.key === key)) { toast('Essa linha já existe'); return; }
    const project = projects.find((p) => p.id === projectId) || null;
    setExtraRows((l) => [...l, { key, projectId, taskId, description: (description || '').trim(), project }]);
    setAdding(false);
  }
  function removeRow(row) {
    const has = days.some((d) => row.cells[d].length);
    if (has) { toast('A linha possui registros. Zere as células antes de removê-la.', 'error'); return; }
    setExtraRows((l) => l.filter((r) => r.key !== row.key));
  }

  async function copyPreviousWeek() {
    setBusy(true);
    try {
      const prev = await endpoints.timeEntries(wsId, viewUser, { start: localToIso(addDays(weekOf, -7), '00:00', timeZone), end: startIso, hydrated: false, 'page-size': 2000, 'in-progress': false });
      const list = prev.filter((e) => e.timeInterval.end && e.type !== 'BREAK');
      if (!list.length) { toast('A semana anterior não possui registros'); return; }
      let n = 0;
      for (const e of list) {
        const s = new Date(new Date(e.timeInterval.start).getTime() + 7 * 86400000).toISOString();
        const en = new Date(new Date(e.timeInterval.end).getTime() + 7 * 86400000).toISOString();
        await createEntry({ start: s, end: en, description: e.description, projectId: e.projectId, taskId: e.taskId, tagIds: e.tagIds, billable: e.billable, type: e.type });
        n++;
      }
      toast(`${n} registro(s) copiado(s)`, 'success');
      load();
    } catch (err) { toast(errorMessage(err), 'error'); load(); } finally { setBusy(false); }
  }

  async function submitApproval() {
    setBusy(true);
    try {
      await api.post(`${ws(wsId)}/approval-requests${isMe ? '' : `/users/${viewUser}`}`, { period: 'WEEKLY', periodStart: startIso });
      toast('Semana enviada para aprovação', 'success');
      load();
    } catch (err) {
      if (err.status === 404) toast('A funcionalidade de aprovações não está disponível neste servidor.', 'error');
      else toast(errorMessage(err), 'error');
    } finally { setBusy(false); }
  }

  const canAddManual = settings.timeTrackingMode !== 'STOPWATCH_ONLY' || isAdmin;
  const approvalsOn = settings.approvalsEnabled !== false;
  const hasEntries = entries.length > 0;
  const pendingApproval = entries.some((e) => e.approvalStatus === 'PENDING');
  const approved = entries.length > 0 && entries.every((e) => e.approvalStatus === 'APPROVED');

  return (
    <div>
      <div className="page-header">
        <h1>Planilha de horas</h1>
        <div className="btn-group">
          <button className="btn secondary sm" onClick={() => setWeekOf(addDays(weekOf, -7))} title="Semana anterior">‹</button>
          <button className="btn secondary sm" onClick={() => setWeekOf(startOfWeekStr(today, weekStart))}>Esta semana</button>
          <button className="btn secondary sm" onClick={() => setWeekOf(addDays(weekOf, 7))} title="Próxima semana">›</button>
        </div>
        <span className="muted">{fmtDate(weekOf, dateFormat)} – {fmtDate(weekEnd, dateFormat)}</span>
        <input type="date" value={weekOf} onChange={(e) => e.target.value && setWeekOf(startOfWeekStr(e.target.value, weekStart))} style={{ width: 150 }} />
        <div className="right row gap wrap">
          {isAdmin && users.length > 1 && <select style={{ width: 'auto' }} value={viewUser} onChange={(e) => setViewUser(e.target.value)}>{users.map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? `${u.name} (eu)` : u.name}</option>)}</select>}
          {canAddManual && <button className="btn secondary" disabled={busy} onClick={() => setConfirm({ title: 'Copiar semana anterior', message: 'Copiar todos os registros da semana anterior para esta semana?', onConfirm: copyPreviousWeek })}>Copiar semana anterior</button>}
          {approvalsOn && <button className="btn" disabled={busy || !hasEntries || pendingApproval || approved} onClick={() => setConfirm({ title: 'Enviar para aprovação', message: `Enviar a semana de ${fmtDate(weekOf, dateFormat)} a ${fmtDate(weekEnd, dateFormat)} para aprovação? Os registros ficarão bloqueados até a revisão.`, onConfirm: submitApproval })}>{approved ? 'Semana aprovada' : pendingApproval ? 'Aguardando aprovação' : 'Enviar para aprovação'}</button>}
        </div>
      </div>
      <Alert type="error">{error}</Alert>
      <div className="card" style={{ overflowX: 'auto' }}>
        {loading && entries.length === 0 ? <Spinner block /> : (
          <table className="table timesheet">
            <thead>
              <tr>
                <th style={{ minWidth: 260 }}>Projeto / tarefa</th>
                {days.map((d) => <th key={d} className={`center ${d === today ? 'today' : ''}`}><div>{weekdayShort(d)}</div><div className="light" style={{ fontWeight: 400 }}>{shortDate(d)}</div></th>)}
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={10} className="center muted" style={{ padding: 32 }}>Nenhum registro nesta semana. Clique em “Adicionar linha” para começar.</td></tr>}
              {rows.map((row) => {
                const total = days.reduce((s, d) => s + cellTotal(row.cells[d]), 0);
                return (
                  <tr key={row.key}>
                    <td>
                      <ProjectLabel project={row.project || projects.find((p) => p.id === row.projectId)} task={row.task} />
                      {row.description && <div className="small muted truncate" title={row.description}>{row.description}</div>}
                    </td>
                    {days.map((d) => <Cell key={d} list={row.cells[d]} today={d === today} disabled={!canAddManual} onSave={(text) => saveCell(row, d, text)} onMulti={() => setMulti({ row, day: d, list: row.cells[d] })} />)}
                    <td className="num total mono">{fmtDuration(total, { seconds: false })}</td>
                    <td className="actions"><button className="btn ghost icon sm" title="Remover linha" onClick={() => removeRow(row)}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="total">Total</td>
                {dayTotals.map((t, i) => <td key={days[i]} className={`center total mono ${days[i] === today ? 'today' : ''}`}>{fmtDuration(t, { seconds: false })}</td>)}
                <td className="num total mono">{fmtDuration(weekTotal, { seconds: false })}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
        <div className="filter-bar" style={{ borderTop: '1px solid var(--border)' }}>
          <button className="btn link" onClick={() => setAdding(true)}>+ Adicionar linha</button>
          <span className="light small right">Digite a duração em cada célula (ex.: 1:30, 1h30m, 1.5). Zerar exclui o registro.</span>
        </div>
      </div>

      {adding && <AddRowModal onClose={() => setAdding(false)} onAdd={addRow} />}
      {multi && (
        <Modal title={`Registros de ${fmtDate(multi.day, dateFormat)}`} onClose={() => setMulti(null)} size="lg">
          <p className="muted small">Existem vários registros nesta célula. Edite cada um individualmente.</p>
          <table className="table compact">
            <thead><tr><th>Descrição</th><th>Início</th><th>Término</th><th className="num">Duração</th><th /></tr></thead>
            <tbody>
              {(rows.find((r) => r.key === multi.row.key)?.cells[multi.day] || []).map((e) => (
                <tr key={e.id}>
                  <td>{e.description || <span className="light">(sem descrição)</span>}</td>
                  <td className="mono">{toLocalTimeStr(e.timeInterval.start, timeZone)}</td>
                  <td className="mono">{e.timeInterval.end ? toLocalTimeStr(e.timeInterval.end, timeZone) : '…'}</td>
                  <td className="num mono">{fmtDuration(entryDuration(e))}</td>
                  <td className="actions"><button className="btn ghost sm" onClick={() => setEditing(e)} disabled={e.isLocked && !isAdmin}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {editing && <EntryEditor entry={editing} userId={viewUser} onClose={() => setEditing(null)} onSaved={() => load()} onDeleted={() => load()} />}
      {confirm && <Confirm title={confirm.title} message={confirm.message} onConfirm={confirm.onConfirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function Cell({ list, today, disabled, onSave, onMulti }) {
  const total = list.reduce((s, e) => s + entryDuration(e), 0);
  const display = total ? fmtDuration(total, { seconds: false }) : '';
  const [text, setText] = useState(display);
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setText(display); }, [display, focus]);
  const locked = list.some((e) => e.isLocked);
  const multi = list.length > 1;
  return (
    <td className={`center ${today ? 'today' : ''}`} style={{ padding: 4, minWidth: 84 }}>
      <input
        value={text}
        placeholder="0:00"
        disabled={disabled || locked}
        title={multi ? `${list.length} registros – clique para ver` : locked ? 'Registro bloqueado' : ''}
        style={{ width: 80, fontWeight: total ? 600 : 400 }}
        onFocus={() => setFocus(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { setFocus(false); if (text !== display) onSave(text); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setText(display); e.target.blur(); } }}
      />
      {multi && <div><button className="btn link small" style={{ fontSize: 10 }} onClick={onMulti}>{list.length} registros</button></div>}
    </td>
  );
}

function AddRowModal({ onClose, onAdd }) {
  const [projectId, setProjectId] = useState(null);
  const [taskId, setTaskId] = useState(null);
  const [description, setDescription] = useState('');
  return (
    <Modal title="Adicionar linha" onClose={onClose} size="sm" footer={<>
      <button className="btn ghost" onClick={onClose}>Cancelar</button>
      <button className="btn" onClick={() => onAdd(projectId, taskId, description)}>Adicionar</button>
    </>}>
      <div className="field"><label>Projeto / tarefa</label><ProjectPicker projectId={projectId} taskId={taskId} onChange={(p, t) => { setProjectId(p); setTaskId(t); }} /></div>
      <div className="field"><label>Descrição (opcional)</label><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descrição padrão dos registros desta linha" /></div>
      <p className="small muted">Registros criados a partir desta linha usarão o projeto, a tarefa e a descrição informados.</p>
    </Modal>
  );
}

