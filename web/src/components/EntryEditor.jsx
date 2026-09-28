import React, { useState } from 'react';
import { Modal, Alert } from './ui.jsx';
import { ProjectPicker, TagPicker } from './pickers.jsx';
import { useStore } from '../store.jsx';
import { endpoints } from '../api.js';
import { toLocalDateStr, toLocalTimeStr, localToIso, parseDuration, fmtDuration, errorMessage } from '../lib/format.js';

// Modal to create/edit a time entry (used by tracker, calendar and timesheet)
export default function EntryEditor({ entry, userId, defaults = {}, onSaved, onClose, onDeleted }) {
  const { workspace, timeZone, user, settings, isAdmin } = useStore();
  const uid = userId || entry?.userId || user.id;
  const init = entry ? {
    description: entry.description, projectId: entry.projectId, taskId: entry.taskId, tagIds: entry.tagIds || [], billable: entry.billable, type: entry.type || 'REGULAR',
    date: toLocalDateStr(entry.timeInterval.start, timeZone), start: toLocalTimeStr(entry.timeInterval.start, timeZone), end: entry.timeInterval.end ? toLocalTimeStr(entry.timeInterval.end, timeZone) : '',
    endDate: entry.timeInterval.end ? toLocalDateStr(entry.timeInterval.end, timeZone) : toLocalDateStr(entry.timeInterval.start, timeZone),
  } : {
    description: '', projectId: null, taskId: null, tagIds: [], billable: !!settings.defaultBillableProjects && false, type: 'REGULAR',
    date: defaults.date || toLocalDateStr(new Date(), timeZone), endDate: defaults.date || toLocalDateStr(new Date(), timeZone), start: defaults.start || '09:00', end: defaults.end || '10:00', ...defaults,
  };
  const [f, setF] = useState(init);
  const [durationText, setDurationText] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const startIso = f.date && f.start ? localToIso(f.date, f.start, timeZone) : null;
  const endIso = f.endDate && f.end ? localToIso(f.endDate, f.end, timeZone) : null;
  const duration = startIso && endIso ? Math.round((new Date(endIso) - new Date(startIso)) / 1000) : 0;

  function applyDuration() {
    const secs = parseDuration(durationText);
    if (secs == null || !startIso) return;
    const end = new Date(new Date(startIso).getTime() + secs * 1000);
    set('end', toLocalTimeStr(end, timeZone)); set('endDate', toLocalDateStr(end, timeZone)); setDurationText('');
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const body = { description: f.description, projectId: f.projectId || null, taskId: f.taskId || null, tagIds: f.tagIds, billable: !!f.billable, type: f.type, start: startIso, end: endIso };
      if (endIso && new Date(endIso) <= new Date(startIso)) throw new Error('O término deve ser depois do início');
      const saved = entry ? await endpoints.updateEntry(workspace.id, entry.id, body) : (uid === user.id ? await endpoints.createEntry(workspace.id, body) : await endpoints.createEntryFor(workspace.id, uid, body));
      onSaved?.(saved); onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm('Excluir este registro de tempo?')) return;
    setBusy(true);
    try { await endpoints.deleteEntry(workspace.id, entry.id); onDeleted?.(entry); onClose(); } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  const locked = entry?.isLocked && !isAdmin;
  return (
    <Modal title={entry ? 'Editar registro' : 'Novo registro de tempo'} onClose={onClose} footer={<>
      {entry && <button className="btn ghost" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={remove} disabled={busy || locked}>Excluir</button>}
      <button className="btn ghost" onClick={onClose}>Cancelar</button>
      <button className="btn" onClick={save} disabled={busy || locked}>{entry ? 'Salvar' : 'Adicionar'}</button>
    </>}>
      <Alert type="error">{error}</Alert>
      {locked && <Alert type="warning">Este registro está bloqueado (aprovado, faturado ou anterior à data de bloqueio).</Alert>}
      <div className="field"><label>Descrição</label><input value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="No que você está trabalhando?" autoFocus /></div>
      <div className="row gap mb wrap">
        <ProjectPicker projectId={f.projectId} taskId={f.taskId} onChange={(p, t) => { set('projectId', p); set('taskId', t); }} />
        <TagPicker tagIds={f.tagIds} onChange={(v) => set('tagIds', v)} />
        <label className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" checked={!!f.billable} onChange={(e) => set('billable', e.target.checked)} /> Faturável</label>
        <select value={f.type} onChange={(e) => set('type', e.target.value)} style={{ width: 'auto' }}><option value="REGULAR">Trabalho</option><option value="BREAK">Pausa</option></select>
      </div>
      <div className="grid cols-3">
        <div className="field"><label>Data</label><input type="date" value={f.date} onChange={(e) => { set('date', e.target.value); if (f.endDate < e.target.value) set('endDate', e.target.value); }} /></div>
        <div className="field"><label>Início</label><input type="time" step="1" value={f.start} onChange={(e) => set('start', e.target.value)} /></div>
        <div className="field"><label>Término</label><input type="time" step="1" value={f.end} onChange={(e) => set('end', e.target.value)} /></div>
      </div>
      <div className="grid cols-3">
        <div className="field"><label>Data de término</label><input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></div>
        <div className="field"><label>Duração</label><input value={durationText} placeholder={fmtDuration(duration)} onChange={(e) => setDurationText(e.target.value)} onBlur={applyDuration} onKeyDown={(e) => e.key === 'Enter' && applyDuration()} title="Ex.: 1:30, 1h30m, 1.5" /></div>
        <div className="field"><label>Total</label><div className="mono bold" style={{ padding: '8px 0' }}>{fmtDuration(duration)}</div></div>
      </div>
    </Modal>
  );
}
