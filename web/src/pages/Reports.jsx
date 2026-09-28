import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { MultiPicker, useProjects, useTags, useUsers, useClients } from '../components/pickers.jsx';
import { Spinner, Empty, Alert, Modal, Confirm, Dropdown, Tabs, Switch, DateRangePicker, Pagination } from '../components/ui.jsx';
import EntryEditor from '../components/EntryEditor.jsx';
import { useAsync, useLocalState, useDebounce } from '../lib/hooks.js';
import { toLocalDateStr, addDays, startOfWeekStr, fmtDate, errorMessage, pad, WEEKDAYS, WEEKDAY_LABELS } from '../lib/format.js';
import { SummaryView, DetailedView, WeeklyView, AttendanceView, ExpenseReportView, GROUP_LABELS, REPORT_TYPES, REPORT_PATHS } from '../components/reportViews.jsx';
import './Reports.css';

// ---------------------------------------------------------------- periods
const PERIODS = [
  { value: 'TODAY', label: 'Hoje', unit: 'day' }, { value: 'YESTERDAY', label: 'Ontem', unit: 'day' },
  { value: 'THIS_WEEK', label: 'Esta semana', unit: 'week' }, { value: 'LAST_WEEK', label: 'Semana passada', unit: 'week' },
  { value: 'PAST_TWO_WEEKS', label: 'Últimas 2 semanas', unit: 'range' },
  { value: 'THIS_MONTH', label: 'Este mês', unit: 'month' }, { value: 'LAST_MONTH', label: 'Mês passado', unit: 'month' },
  { value: 'THIS_YEAR', label: 'Este ano', unit: 'year' }, { value: 'LAST_YEAR', label: 'Ano passado', unit: 'year' },
  { value: 'CUSTOM', label: 'Personalizado', unit: 'range' },
];
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const utcOf = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((utcOf(b) - utcOf(a)) / 86400000);

export function presetRange(p, today, weekStart) {
  const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7));
  switch (p) {
    case 'TODAY': return [today, today];
    case 'YESTERDAY': { const d = addDays(today, -1); return [d, d]; }
    case 'THIS_WEEK': { const s = startOfWeekStr(today, weekStart); return [s, addDays(s, 6)]; }
    case 'LAST_WEEK': { const s = addDays(startOfWeekStr(today, weekStart), -7); return [s, addDays(s, 6)]; }
    case 'PAST_TWO_WEEKS': { const s = addDays(startOfWeekStr(today, weekStart), -7); return [s, addDays(s, 13)]; }
    case 'THIS_MONTH': return [`${today.slice(0, 7)}-01`, monthEnd(y, m)];
    case 'LAST_MONTH': { const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1]; return [`${py}-${pad(pm)}-01`, monthEnd(py, pm)]; }
    case 'THIS_YEAR': return [`${y}-01-01`, `${y}-12-31`];
    case 'LAST_YEAR': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    default: return null;
  }
}
function shiftRange(start, end, unit, dir) {
  if (unit === 'month') { const [y, m] = start.split('-').map(Number); const nm = m + dir; const yy = y + Math.floor((nm - 1) / 12); const mm = ((((nm - 1) % 12) + 12) % 12) + 1; return [`${yy}-${pad(mm)}-01`, monthEnd(yy, mm)]; }
  if (unit === 'year') { const y = Number(start.slice(0, 4)) + dir; return [`${y}-01-01`, `${y}-12-31`]; }
  const len = dayDiff(start, end) + 1;
  return [addDays(start, dir * len), addDays(end, dir * len)];
}

const EMPTY_CONTAINS = { ids: [], contains: 'CONTAINS', status: 'ALL' };
const DEFAULT_FILTER = {
  period: 'THIS_WEEK', unit: 'week', start: null, end: null,
  users: EMPTY_CONTAINS, userGroups: EMPTY_CONTAINS, clients: EMPTY_CONTAINS, projects: EMPTY_CONTAINS, tasks: EMPTY_CONTAINS, tags: EMPTY_CONTAINS,
  billable: 'ALL', description: '', withoutDescription: false, invoicingState: 'ALL', approvalState: 'ALL',
  customFields: [], amountShown: 'EARNED', rounding: false, includeArchived: true,
};

// Loads tasks of the selected projects for the task filter
function useTasksOf(wsId, projectIds) {
  const [list, setList] = useState([]);
  const key = (projectIds || []).join(',');
  useEffect(() => {
    let alive = true;
    if (!wsId || !key) { setList([]); return undefined; }
    Promise.all(key.split(',').map((pid) => endpoints.tasks(wsId, pid).catch(() => []))).then((r) => alive && setList(r.flat()));
    return () => { alive = false; };
  }, [wsId, key]);
  return list;
}

// Common filter state (persisted) + request body shared by every report tab
function useReportFilter() {
  const { workspace, settings, isAdmin, timeZone, weekStart, dateFormat, timeFormat, currency } = useStore();
  const wsId = workspace?.id;
  const [stored, setStored] = useLocalState('clockfy.reportFilters', DEFAULT_FILTER);
  const f = useMemo(() => ({ ...DEFAULT_FILTER, ...(stored || {}) }), [stored]);
  const patch = useCallback((p) => setStored((s) => ({ ...DEFAULT_FILTER, ...(s || {}), ...p })), [setStored]);
  const today = toLocalDateStr(new Date(), timeZone);
  const [start, end] = useMemo(() => (f.period !== 'CUSTOM' && presetRange(f.period, today, weekStart)) || [f.start || today, f.end || today], [f.period, f.start, f.end, today, weekStart]);
  const setRange = useCallback((s, e, unit = 'range') => patch({ period: 'CUSTOM', start: s, end: e, unit }), [patch]);
  const shift = useCallback((dir) => { const [s, e] = shiftRange(start, end, f.unit || 'range', dir); patch({ period: 'CUSTOM', start: s, end: e }); }, [start, end, f.unit, patch]);
  const reset = useCallback(() => setStored((s) => ({ ...DEFAULT_FILTER, period: s?.period || 'THIS_WEEK', unit: s?.unit || 'week', start: s?.start || null, end: s?.end || null })), [setStored]);

  const users = useUsers(wsId, { status: 'ALL' });
  const clients = useClients(wsId);
  const projects = useProjects(wsId);
  const archivedProjects = useProjects(wsId, { archived: true });
  const tags = useTags(wsId);
  const tasks = useTasksOf(wsId, f.projects.ids);
  const { data: groups } = useAsync(() => endpoints.groups(wsId), [wsId], { initial: [] });
  const { data: customFields } = useAsync(() => endpoints.customFields(wsId).then((r) => (Array.isArray(r) ? r : r?.customFields || []).filter((c) => c.entityType !== 'USER' && c.status !== 'INACTIVE')), [wsId], { initial: [] });

  const showRates = isAdmin || !settings.onlyAdminsSeeBillableRates;
  const amountOptions = isAdmin ? ['EARNED', 'COST', 'PROFIT', 'HIDE_AMOUNT'] : showRates ? ['EARNED', 'HIDE_AMOUNT'] : ['HIDE_AMOUNT'];
  const amount = amountOptions.includes(f.amountShown) ? f.amountShown : amountOptions[0];

  const body = useMemo(() => {
    const contains = (x) => (x.ids && x.ids.length ? { ids: x.ids, contains: x.contains || 'CONTAINS', status: x.status || 'ALL' } : undefined);
    const cfs = (f.customFields || []).filter((c) => c.isEmpty || (c.value !== '' && c.value != null && !(Array.isArray(c.value) && !c.value.length)))
      .map((c) => ({ id: c.id, value: c.isEmpty ? undefined : c.value, isEmpty: c.isEmpty || undefined, numberCondition: c.numberCondition || undefined }));
    const b = {
      dateRangeStart: start, dateRangeEnd: end, timeZone, weekStart,
      users: f.users.ids.length || (f.users.status && f.users.status !== 'ALL') ? { ids: f.users.ids, contains: f.users.contains || 'CONTAINS', status: f.users.status || 'ALL' } : undefined,
      userGroups: contains(f.userGroups), clients: contains(f.clients), projects: contains(f.projects), tasks: contains(f.tasks), tags: contains(f.tags),
      billable: f.billable === 'ALL' ? undefined : f.billable === 'YES',
      description: f.withoutDescription ? undefined : (f.description || '').trim() || undefined,
      withoutDescription: f.withoutDescription || undefined,
      invoicingState: f.invoicingState === 'ALL' ? undefined : f.invoicingState,
      approvalState: f.approvalState === 'ALL' ? undefined : f.approvalState,
      customFields: cfs.length ? cfs : undefined,
      amountShown: amount, amounts: [amount],
      rounding: settings.timeRoundingInReports ? !!f.rounding : undefined,
      archived: f.includeArchived ? undefined : false,
      dateFormat, timeFormat, userLocale: 'pt-BR',
    };
    return JSON.parse(JSON.stringify(b));
  }, [f, start, end, timeZone, weekStart, amount, dateFormat, timeFormat, settings.timeRoundingInReports]);

  return {
    f, patch, reset, start, end, setRange, shift, body, today, wsId, timeZone, weekStart, dateFormat, currency, isAdmin, settings, amount, amountOptions, showRates,
    hour12: timeFormat === 'HOUR12',
    options: { users, clients, projects: [...projects, ...archivedProjects.filter((p) => !projects.some((x) => x.id === p.id))], tags, tasks, groups: groups || [], customFields: customFields || [] },
  };
}

// ---------------------------------------------------------------- filter bar
function ContainsPicker({ label, value, onChange, options, getLabel, only = false, width = 170, disabled, children }) {
  const v = { ...EMPTY_CONTAINS, ...(value || {}) };
  return (
    <div className="fgroup" style={disabled ? { opacity: .5, pointerEvents: 'none' } : undefined}>
      <select className="fmode" value={v.contains} onChange={(e) => onChange({ ...v, contains: e.target.value })} title="Modo">
        <option value="CONTAINS">contém</option><option value="DOES_NOT_CONTAIN">não contém</option>{only && <option value="CONTAINS_ONLY">só contém</option>}
      </select>
      <MultiPicker options={options} value={v.ids} onChange={(ids) => onChange({ ...v, ids })} label={label} getLabel={getLabel} width={width} />
      {children}
    </div>
  );
}

function CustomFieldFilters({ fields, value = [], onChange }) {
  const add = (id) => { if (!id) return; const field = fields.find((x) => x.id === id); onChange([...value, { id, value: field?.type === 'DROPDOWN_MULTIPLE' ? [] : field?.type === 'CHECKBOX' ? 'true' : '', isEmpty: false, numberCondition: 'EQUAL' }]); };
  const set = (i, p) => onChange(value.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const remove = (i) => onChange(value.filter((_, j) => j !== i));
  const available = fields.filter((x) => !value.some((c) => c.id === x.id));
  if (!fields.length) return null;
  return (
    <>
      {value.map((c, i) => {
        const field = fields.find((x) => x.id === c.id); if (!field) return null;
        return (
          <span key={c.id} className="cf-chip">
            <span className="bold">{field.name}</span>
            {!c.isEmpty && field.type === 'NUMBER' && <select value={c.numberCondition || 'EQUAL'} onChange={(e) => set(i, { numberCondition: e.target.value })}><option value="EQUAL">=</option><option value="GREATER_THAN">&gt;</option><option value="LESS_THAN">&lt;</option></select>}
            {!c.isEmpty && field.type === 'NUMBER' && <input type="number" value={c.value ?? ''} onChange={(e) => set(i, { value: e.target.value })} />}
            {!c.isEmpty && field.type === 'CHECKBOX' && <select value={String(c.value)} onChange={(e) => set(i, { value: e.target.value })}><option value="true">Sim</option><option value="false">Não</option></select>}
            {!c.isEmpty && field.type === 'DROPDOWN_SINGLE' && <select value={c.value || ''} onChange={(e) => set(i, { value: e.target.value })}><option value="">—</option>{(field.allowedValues || []).map((o) => <option key={o} value={o}>{o}</option>)}</select>}
            {!c.isEmpty && field.type === 'DROPDOWN_MULTIPLE' && <MultiPicker options={(field.allowedValues || []).map((o) => ({ id: o, name: o }))} value={Array.isArray(c.value) ? c.value : []} onChange={(v) => set(i, { value: v })} label="valores…" width={150} />}
            {!c.isEmpty && (field.type === 'TXT' || field.type === 'LINK') && <input value={c.value ?? ''} placeholder="contém…" onChange={(e) => set(i, { value: e.target.value })} />}
            <label className="checkbox" style={{ fontSize: 12, marginBottom: 0 }}><input type="checkbox" checked={!!c.isEmpty} onChange={(e) => set(i, { isEmpty: e.target.checked })} /> vazio</label>
            <span className="x" onClick={() => remove(i)} title="Remover">✕</span>
          </span>
        );
      })}
      {available.length > 0 && <select value="" onChange={(e) => add(e.target.value)} style={{ width: 'auto' }}><option value="">+ Campo personalizado</option>{available.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
    </>
  );
}

function FilterBar({ ctx, weekly = false }) {
  const { f, patch, reset, start, end, setRange, shift, dateFormat, weekStart, settings, amount, amountOptions, options } = ctx;
  const presets = weekly ? PERIODS.filter((p) => ['THIS_WEEK', 'LAST_WEEK', 'CUSTOM'].includes(p.value)) : PERIODS;
  const wkStart = startOfWeekStr(start, weekStart); const wkEnd = addDays(wkStart, 6);
  const selectPeriod = (v) => { if (v === 'CUSTOM') setRange(start, end, weekly ? 'week' : 'range'); else patch({ period: v, unit: PERIODS.find((p) => p.value === v)?.unit || 'range' }); };
  const period = weekly && !['THIS_WEEK', 'LAST_WEEK'].includes(f.period) ? 'CUSTOM' : f.period;
  const label = weekly ? `${fmtDate(wkStart, dateFormat)} – ${fmtDate(wkEnd, dateFormat)}` : start === end ? fmtDate(start, dateFormat) : `${fmtDate(start, dateFormat)} – ${fmtDate(end, dateFormat)}`;
  const AMOUNT = { EARNED: 'Valor faturável', COST: 'Custo', PROFIT: 'Lucro', HIDE_AMOUNT: 'Ocultar valores' };
  const active = f.users.ids.length + f.userGroups.ids.length + f.clients.ids.length + f.projects.ids.length + f.tasks.ids.length + f.tags.ids.length + (f.billable !== 'ALL') + (!!f.description || f.withoutDescription) + (f.invoicingState !== 'ALL') + (f.approvalState !== 'ALL') + (f.customFields || []).length + (f.users.status !== 'ALL');
  return (
    <div className="card mb no-print">
      <div className="filter-bar">
        <select value={period} onChange={(e) => selectPeriod(e.target.value)} style={{ minWidth: 150 }}>{presets.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
        <button type="button" className="btn ghost icon" title="Período anterior" onClick={() => (weekly ? setRange(addDays(wkStart, -7), addDays(wkEnd, -7), 'week') : shift(-1))}>‹</button>
        <span className="range-label">{label}</span>
        <button type="button" className="btn ghost icon" title="Próximo período" onClick={() => (weekly ? setRange(addDays(wkStart, 7), addDays(wkEnd, 7), 'week') : shift(1))}>›</button>
        {period === 'CUSTOM' && !weekly && <DateRangePicker start={start} end={end} onChange={(s, e) => setRange(s || start, e || end, 'range')} />}
        {period === 'CUSTOM' && weekly && <span className="row gap"><span className="muted small">Semana de</span><input type="date" value={wkStart} onChange={(e) => { if (!e.target.value) return; const s = startOfWeekStr(e.target.value, weekStart); setRange(s, addDays(s, 6), 'week'); }} style={{ width: 150 }} /></span>}
        <span className="right row gap wrap">
          {amountOptions.length > 1 && <select value={amount} onChange={(e) => patch({ amountShown: e.target.value })} title="Mostrar valores">{amountOptions.map((a) => <option key={a} value={a}>{AMOUNT[a]}</option>)}</select>}
          {settings.timeRoundingInReports && <span className="switch-label"><Switch value={!!f.rounding} onChange={(v) => patch({ rounding: v })} /> Arredondar</span>}
          <span className="switch-label"><Switch value={!!f.includeArchived} onChange={(v) => patch({ includeArchived: v })} /> Incluir arquivados</span>
        </span>
      </div>
      <div className="filter-bar" style={{ borderTop: '1px solid var(--border)' }}>
        <ContainsPicker label="Usuários" value={f.users} onChange={(v) => patch({ users: v })} options={options.users} width={160}>
          <select className="fmode" style={{ borderLeft: 'none', borderRight: '1px solid var(--border-strong)', borderRadius: '0 var(--radius) var(--radius) 0' }} value={f.users.status || 'ALL'} onChange={(e) => patch({ users: { ...f.users, status: e.target.value } })} title="Status do usuário"><option value="ALL">todos</option><option value="ACTIVE">ativos</option><option value="INACTIVE">inativos</option><option value="PENDING">pendentes</option></select>
        </ContainsPicker>
        {options.groups.length > 0 && <ContainsPicker label="Grupos" value={f.userGroups} onChange={(v) => patch({ userGroups: v })} options={options.groups} width={140} />}
        <ContainsPicker label="Clientes" value={f.clients} onChange={(v) => patch({ clients: v })} options={options.clients} width={150} />
        <ContainsPicker label="Projetos" value={f.projects} onChange={(v) => patch({ projects: v, tasks: EMPTY_CONTAINS })} options={options.projects} getLabel={(p) => `${p.name}${p.clientName ? ` – ${p.clientName}` : ''}${p.archived ? ' (arquivado)' : ''}`} width={180} />
        <ContainsPicker label={f.projects.ids.length ? 'Tarefas' : 'Tarefas (escolha projetos)'} value={f.tasks} onChange={(v) => patch({ tasks: v })} options={options.tasks} width={160} disabled={!f.projects.ids.length} />
        <ContainsPicker label="Etiquetas" value={f.tags} onChange={(v) => patch({ tags: v })} options={options.tags} only width={150} />
        <select value={f.billable} onChange={(e) => patch({ billable: e.target.value })} title="Faturável"><option value="ALL">Faturável: todos</option><option value="YES">Faturável</option><option value="NO">Não faturável</option></select>
        <span className="fgroup">
          <input className="desc" placeholder="Descrição contém…" value={f.description} disabled={f.withoutDescription} onChange={(e) => patch({ description: e.target.value })} style={{ borderRadius: 'var(--radius) 0 0 var(--radius)' }} />
          <label className="checkbox small" style={{ border: '1px solid var(--border-strong)', borderLeft: 'none', borderRadius: '0 var(--radius) var(--radius) 0', padding: '0 8px', background: '#f7fafc', marginBottom: 0 }} title="Somente registros sem descrição"><input type="checkbox" checked={!!f.withoutDescription} onChange={(e) => patch({ withoutDescription: e.target.checked })} /> sem descrição</label>
        </span>
        <select value={f.invoicingState} onChange={(e) => patch({ invoicingState: e.target.value })} title="Faturamento"><option value="ALL">Faturamento: todos</option><option value="INVOICED">Faturados</option><option value="UNINVOICED">Não faturados</option></select>
        <select value={f.approvalState} onChange={(e) => patch({ approvalState: e.target.value })} title="Aprovação"><option value="ALL">Aprovação: todos</option><option value="APPROVED">Aprovados</option><option value="UNAPPROVED">Não aprovados</option></select>
        <CustomFieldFilters fields={options.customFields} value={f.customFields} onChange={(v) => patch({ customFields: v })} />
        {active > 0 && <button type="button" className="btn link" onClick={reset}>Limpar filtros ({active})</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- export / share / schedule
function ReportActions({ type, body, loading }) {
  const { workspace, toast } = useStore();
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(null);
  async function exportAs(exportType) {
    setBusy(exportType);
    try { await api.download(`${ws(workspace.id)}/reports/${REPORT_PATHS[type]}`, { ...body, exportType }); } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(null); }
  }
  return (
    <span className="row gap wrap">
      {loading && <Spinner />}
      <Dropdown label={busy ? `Exportando ${busy}…` : 'Exportar ▾'} className="secondary">
        <button onClick={() => exportAs('CSV')}>CSV</button><button onClick={() => exportAs('XLSX')}>Excel (XLSX)</button><button onClick={() => exportAs('PDF')}>PDF</button>
      </Dropdown>
      <button type="button" className="btn secondary" onClick={() => setModal('share')}>Salvar / compartilhar</button>
      <button type="button" className="btn secondary" onClick={() => setModal('schedule')}>Agendar por e-mail</button>
      {modal === 'share' && <SharedReportModal type={type} filter={body} onClose={() => setModal(null)} />}
      {modal === 'schedule' && <ScheduledReportModal type={type} filter={body} onClose={() => setModal(null)} />}
    </span>
  );
}

const sharedLink = (id) => `${window.location.origin}/shared/${id}`;

function copy(text, toast) {
  const done = () => toast('Link copiado', 'success');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => window.prompt('Copie o link:', text));
  else window.prompt('Copie o link:', text);
}

export function SharedReportModal({ report, type, filter, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const wsId = workspace?.id;
  const users = useUsers(wsId);
  const { data: groups } = useAsync(() => endpoints.groups(wsId), [wsId], { initial: [] });
  const [f, setF] = useState({
    name: report?.name || '', type: report?.type || type || 'SUMMARY', isPublic: report ? !!report.isPublic : false, fixedDate: report ? !!report.fixedDate : false,
    visibleToUsers: (report?.visibleToUsers || []).map((u) => u.id || u), visibleToUserGroups: (report?.visibleToUserGroups || []).map((g) => g.id || g),
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  async function save() {
    if (!f.name.trim()) { setError('Informe um nome'); return; }
    setBusy(true); setError(null);
    try {
      const body = { name: f.name.trim(), type: f.type, isPublic: f.isPublic, fixedDate: f.fixedDate, visibleToUsers: f.visibleToUsers, visibleToUserGroups: f.visibleToUserGroups };
      if (filter) body.filter = filter;
      const r = report ? await api.put(`${ws(wsId)}/shared-reports/${report.id}`, body) : await api.post(`${ws(wsId)}/shared-reports`, body);
      toast(report ? 'Relatório compartilhado atualizado' : 'Relatório compartilhado criado', 'success');
      onSaved?.(r);
      if (report) onClose(); else setCreated(r);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  if (created) {
    const link = sharedLink(created.id);
    return (
      <Modal title="Relatório compartilhado" onClose={onClose} footer={<button className="btn" onClick={onClose}>Fechar</button>}>
        <Alert type="success">“{created.name}” foi salvo. {created.isPublic ? 'Qualquer pessoa com o link pode abri-lo.' : 'Apenas usuários autorizados podem abri-lo (é preciso entrar).'}</Alert>
        <div className="share-link"><input readOnly value={link} onFocus={(e) => e.target.select()} /><button className="btn secondary" onClick={() => copy(link, toast)}>Copiar</button><a className="btn ghost" href={link} target="_blank" rel="noreferrer">Abrir</a></div>
      </Modal>
    );
  }
  return (
    <Modal title={report ? 'Editar relatório compartilhado' : 'Salvar e compartilhar relatório'} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{report ? 'Salvar' : 'Criar link'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input value={f.name} autoFocus onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Horas do cliente ACME" /></div>
      <div className="grid cols-2">
        <div className="field"><label>Tipo</label><select value={f.type} disabled={!report && !!type} onChange={(e) => set('type', e.target.value)}>{Object.entries(REPORT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Período</label><label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" checked={f.fixedDate} onChange={(e) => set('fixedDate', e.target.checked)} /> Data fixa (quem abrir não muda o período)</label></div>
      </div>
      <div className="field"><label>Visibilidade</label>
        <label className="checkbox"><input type="radio" name="vis" checked={f.isPublic} onChange={() => set('isPublic', true)} /> Público – qualquer pessoa com o link</label>
        <label className="checkbox mt"><input type="radio" name="vis" checked={!f.isPublic} onChange={() => set('isPublic', false)} /> Privado – somente eu, administradores e os usuários/grupos abaixo</label>
      </div>
      {!f.isPublic && (
        <div className="grid cols-2">
          <div className="field"><label>Visível aos usuários</label><MultiPicker options={users} value={f.visibleToUsers} onChange={(v) => set('visibleToUsers', v)} label="Selecionar usuários…" /></div>
          <div className="field"><label>Visível aos grupos</label><MultiPicker options={groups || []} value={f.visibleToUserGroups} onChange={(v) => set('visibleToUserGroups', v)} label="Selecionar grupos…" /></div>
        </div>
      )}
      {!report && <p className="small muted">O relatório salvo usa os filtros atuais e roda com as suas permissões.</p>}
    </Modal>
  );
}

const FREQ = { DAILY: 'Diário', WEEKLY: 'Semanal', MONTHLY: 'Mensal' };

export function ScheduledReportModal({ report, type, filter, onClose, onSaved }) {
  const { workspace, user, toast } = useStore();
  const wsId = workspace?.id;
  const [f, setF] = useState({
    name: report?.name || '', type: report?.type || type || 'SUMMARY', frequency: report?.frequency || 'WEEKLY', dayOfWeek: report?.dayOfWeek || 'MONDAY', dayOfMonth: report?.dayOfMonth || 1,
    hour: report?.hour ?? 8, recipients: (report?.recipients || [user?.email]).filter(Boolean).join(', '), exportType: report?.exportType || 'PDF', enabled: report ? !!report.enabled : true,
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    const recipients = f.recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!f.name.trim()) { setError('Informe um nome'); return; }
    if (recipients.some((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))) { setError('Há um e-mail inválido nos destinatários'); return; }
    setBusy(true); setError(null);
    try {
      const body = { name: f.name.trim(), type: f.type, frequency: f.frequency, dayOfWeek: f.frequency === 'WEEKLY' ? f.dayOfWeek : null, dayOfMonth: f.frequency === 'MONTHLY' ? Number(f.dayOfMonth) : null, hour: Number(f.hour), recipients, exportType: f.exportType, enabled: f.enabled };
      if (filter) { const { dateRangeStart, dateRangeEnd, dateRangeType, exportType, ...rest } = filter; body.filter = rest; }
      const r = report ? await api.put(`${ws(wsId)}/scheduled-reports/${report.id}`, body) : await api.post(`${ws(wsId)}/scheduled-reports`, body);
      toast(report ? 'Agendamento atualizado' : 'Relatório agendado', 'success');
      onSaved?.(r); onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={report ? 'Editar agendamento' : 'Agendar envio por e-mail'} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{report ? 'Salvar' : 'Agendar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input value={f.name} autoFocus onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Resumo semanal da equipe" /></div>
      <div className="grid cols-3">
        <div className="field"><label>Tipo</label><select value={f.type} disabled={!report && !!type} onChange={(e) => set('type', e.target.value)}>{Object.entries(REPORT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Frequência</label><select value={f.frequency} onChange={(e) => set('frequency', e.target.value)}>{Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Formato</label><select value={f.exportType} onChange={(e) => set('exportType', e.target.value)}><option value="PDF">PDF</option><option value="CSV">CSV</option><option value="XLSX">Excel (XLSX)</option></select></div>
      </div>
      <div className="grid cols-3">
        {f.frequency === 'WEEKLY' && <div className="field"><label>Dia da semana</label><select value={f.dayOfWeek} onChange={(e) => set('dayOfWeek', e.target.value)}>{WEEKDAYS.map((d) => <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>)}</select></div>}
        {f.frequency === 'MONTHLY' && <div className="field"><label>Dia do mês</label><input type="number" min="1" max="31" value={f.dayOfMonth} onChange={(e) => set('dayOfMonth', e.target.value)} /></div>}
        <div className="field"><label>Hora</label><select value={f.hour} onChange={(e) => set('hour', e.target.value)}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{pad(h)}:00</option>)}</select></div>
        <div className="field"><label>Ativo</label><div style={{ paddingTop: 8 }}><Switch value={f.enabled} onChange={(v) => set('enabled', v)} /></div></div>
      </div>
      <div className="field"><label>Destinatários (separados por vírgula)</label><textarea value={f.recipients} onChange={(e) => set('recipients', e.target.value)} placeholder="nome@empresa.com, outro@empresa.com" /></div>
      <p className="small muted">O período enviado é o dia, a semana ou o mês anterior, conforme a frequência. Os demais filtros atuais são mantidos e o relatório roda com as suas permissões.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- tabs
// Runs a report whenever the (debounced) request changes
function useReport(path, wsId, request) {
  const key = useDebounce(JSON.stringify(request), 350);
  return useAsync(() => api.post(`${ws(wsId)}/reports/${path}`, request), [wsId, key]);
}

function ResultCard({ loading, error, children, toolbar }) {
  return (
    <div className="card">
      {toolbar}
      <Alert type="error">{error ? errorMessage(error) : null}</Alert>
      <div style={loading ? { opacity: .55, pointerEvents: 'none' } : undefined}>{children}</div>
    </div>
  );
}

const SUMMARY_GROUPS = ['PROJECT', 'CLIENT', 'USER', 'TASK', 'TAG', 'DATE', 'WEEK', 'MONTH', 'YEAR', 'USERGROUP', 'TIMEENTRY', 'BILLABILITY'];

function SummaryTab({ ctx }) {
  const [o, setO] = useLocalState('clockfy.reportSummary', { groups: ['PROJECT', 'TIMEENTRY'], sortColumn: 'GROUP', sortOrder: 'ASCENDING' });
  const groups = useMemo(() => { const g = (o.groups || []).filter(Boolean); return g.length ? g : ['PROJECT']; }, [o.groups]);
  const days = dayDiff(ctx.start, ctx.end) + 1;
  const request = useMemo(() => JSON.parse(JSON.stringify({ ...ctx.body, sortOrder: o.sortOrder, zoomLevel: days > 92 ? 'YEAR' : undefined, summaryFilter: { groups, sortColumn: o.sortColumn || 'GROUP', summaryChartType: 'PROJECT' } })), [ctx.body, o.sortOrder, o.sortColumn, groups, days]);
  const { data, loading, error } = useReport('summary', ctx.wsId, request);
  const setGroup = (i, v) => { const g = [...groups]; if (!v) g.splice(i); else g[i] = v; setO({ ...o, groups: g.length ? g : ['PROJECT'] }); };
  const groupOptions = (i) => [...SUMMARY_GROUPS.filter((g) => !groups.some((x, j) => j !== i && x === g)).map((g) => [g, GROUP_LABELS[g]]), ...ctx.options.customFields.filter((c) => !groups.some((x, j) => j !== i && x === c.id)).map((c) => [c.id, `Campo: ${c.name}`])];
  const sortOpts = [['GROUP', 'Nome'], ['DURATION', 'Duração'], ...(ctx.amount !== 'HIDE_AMOUNT' ? [['AMOUNT', 'Valor']] : [])];
  return (
    <>
      <FilterBar ctx={ctx} />
      <ResultCard loading={loading} error={error} toolbar={
        <div className="report-toolbar" style={{ borderTop: 'none' }}>
          <span className="muted small">Agrupar por</span>
          {[0, 1, 2].map((i) => (i === 0 || groups[i - 1]) && (
            <select key={i} value={groups[i] || ''} onChange={(e) => setGroup(i, e.target.value)}>
              {i > 0 && <option value="">—</option>}
              {groupOptions(i).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
          <span className="sep" />
          <span className="muted small">Ordenar</span>
          <select value={o.sortColumn || 'GROUP'} onChange={(e) => setO({ ...o, sortColumn: e.target.value })}>{sortOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button type="button" className="btn ghost sm" onClick={() => setO({ ...o, sortOrder: o.sortOrder === 'DESCENDING' ? 'ASCENDING' : 'DESCENDING' })} title="Inverter ordem">{o.sortOrder === 'DESCENDING' ? '▼ desc' : '▲ asc'}</button>
          <span className="right"><ReportActions type="SUMMARY" body={request} loading={loading} /></span>
        </div>
      }>
        {data ? <SummaryView result={data} groups={groups} currency={ctx.currency} dateFormat={ctx.dateFormat} customFields={ctx.options.customFields} /> : (loading ? <Spinner block /> : null)}
      </ResultCard>
    </>
  );
}

function DetailedTab({ ctx }) {
  const { user, isAdmin, toast } = useStore();
  const [o, setO] = useLocalState('clockfy.reportDetailed', { sortColumn: 'DATE', sortOrder: 'DESCENDING', pageSize: 50 });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const baseKey = JSON.stringify([ctx.body, o]);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [baseKey]);
  const request = useMemo(() => ({ ...ctx.body, sortOrder: o.sortOrder, detailedFilter: { page, pageSize: Number(o.pageSize) || 50, sortColumn: o.sortColumn || 'DATE' } }), [ctx.body, o, page]);
  const { data, loading, error, reload } = useReport('detailed', ctx.wsId, request);
  const onSort = (col) => setO({ ...o, sortColumn: col, sortOrder: o.sortColumn === col && o.sortOrder === 'ASCENDING' ? 'DESCENDING' : 'ASCENDING' });
  const toggle = (e) => setSelected((s) => { const n = new Set(s); if (n.has(e._id)) n.delete(e._id); else n.add(e._id); return n; });
  const toggleAll = (list) => setSelected((s) => (list.every((e) => s.has(e._id)) ? new Set() : new Set(list.map((e) => e._id))));
  const openEntry = (e) => {
    if (!(isAdmin || e.userId === user.id)) return;
    setEditing({ id: e._id, userId: e.userId, description: e.description, projectId: e.projectId, taskId: e.taskId, tagIds: (e.tags || []).map((t) => t._id), billable: e.billable, type: e.type, isLocked: e.isLocked, timeInterval: e.timeInterval });
  };
  const ids = [...selected];
  async function bulk(fn, msg) {
    const results = await Promise.allSettled(ids.map(fn));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast(`${msg}: ${ids.length - failed} ok, ${failed} com erro (${errorMessage(results.find((r) => r.status === 'rejected').reason)})`, 'error'); else toast(`${msg}: ${ids.length} registro(s)`, 'success');
    setSelected(new Set()); reload().catch(() => {});
  }
  const setBillable = (v) => bulk((id) => endpoints.patchEntry(ctx.wsId, id, { billable: v }), v ? 'Marcados como faturáveis' : 'Marcados como não faturáveis');
  const setInvoiced = async (v) => { try { await api.patch(`${ws(ctx.wsId)}/time-entries/invoiced`, { timeEntryIds: ids, invoiced: v }); toast(`${ids.length} registro(s) ${v ? 'marcados como faturados' : 'desmarcados'}`, 'success'); setSelected(new Set()); reload().catch(() => {}); } catch (e) { toast(errorMessage(e), 'error'); } };
  const remove = () => setConfirm({ title: 'Excluir registros', danger: true, confirmLabel: 'Excluir', message: `Excluir ${ids.length} registro(s) de tempo? Esta ação não pode ser desfeita.`, onConfirm: () => bulk((id) => endpoints.deleteEntry(ctx.wsId, id), 'Excluídos') });
  return (
    <>
      <FilterBar ctx={ctx} />
      <ResultCard loading={loading} error={error} toolbar={<>
        <div className="report-toolbar" style={{ borderTop: 'none' }}>
          <span className="muted small">Por página</span>
          <select value={o.pageSize || 50} onChange={(e) => setO({ ...o, pageSize: Number(e.target.value) })}>{[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          <span className="muted small">{data?.count != null ? `${data.count} registro(s)` : ''}</span>
          <span className="right"><ReportActions type="DETAILED" body={request} loading={loading} /></span>
        </div>
        {ids.length > 0 && (
          <div className="bulk-bar">
            <span className="bold small">{ids.length} selecionado(s)</span>
            <button className="btn sm secondary" onClick={() => setBillable(true)}>Marcar faturável</button>
            <button className="btn sm secondary" onClick={() => setBillable(false)}>Marcar não faturável</button>
            {isAdmin && <><button className="btn sm secondary" onClick={() => setInvoiced(true)}>Marcar como faturado</button><button className="btn sm secondary" onClick={() => setInvoiced(false)}>Desmarcar faturado</button></>}
            <button className="btn sm danger" onClick={remove}>Excluir</button>
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Limpar seleção</button>
          </div>
        )}
      </>}>
        {data ? <DetailedView result={data} currency={ctx.currency} timeZone={ctx.timeZone} hour12={ctx.hour12} dateFormat={ctx.dateFormat} selectable selected={selected} onToggle={toggle} onToggleAll={toggleAll} onRowClick={openEntry} sortColumn={o.sortColumn} sortOrder={o.sortOrder} onSort={onSort} /> : (loading ? <Spinner block /> : null)}
        {data && data.count > (data.pageSize || 50) && <Pagination page={page} pageSize={data.pageSize || 50} count={data.count} onChange={setPage} />}
      </ResultCard>
      {editing && <EntryEditor entry={editing} onClose={() => setEditing(null)} onSaved={() => reload().catch(() => {})} onDeleted={() => reload().catch(() => {})} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </>
  );
}

function WeeklyTab({ ctx }) {
  const [o, setO] = useLocalState('clockfy.reportWeekly', { group: 'PROJECT', subgroup: 'TIME', includeUsersWithoutTime: false });
  const wkStart = startOfWeekStr(ctx.start, ctx.weekStart); const wkEnd = addDays(wkStart, 6);
  const request = useMemo(() => ({ ...ctx.body, dateRangeStart: wkStart, dateRangeEnd: wkEnd, weeklyFilter: { group: o.group, subgroup: ctx.amount === 'HIDE_AMOUNT' ? 'TIME' : o.subgroup, includeUsersWithoutTime: !!o.includeUsersWithoutTime } }), [ctx.body, ctx.amount, wkStart, wkEnd, o]);
  const { data, loading, error } = useReport('weekly', ctx.wsId, request);
  return (
    <>
      <FilterBar ctx={ctx} weekly />
      <ResultCard loading={loading} error={error} toolbar={
        <div className="report-toolbar" style={{ borderTop: 'none' }}>
          <span className="muted small">Linhas</span>
          <select value={o.group} onChange={(e) => setO({ ...o, group: e.target.value })}><option value="PROJECT">Projetos</option><option value="USER">Usuários</option></select>
          <span className="muted small">Mostrar</span>
          <select value={ctx.amount === 'HIDE_AMOUNT' ? 'TIME' : o.subgroup} disabled={ctx.amount === 'HIDE_AMOUNT'} onChange={(e) => setO({ ...o, subgroup: e.target.value })}><option value="TIME">Tempo</option><option value="EARNINGS">Valores</option></select>
          <label className="checkbox small" style={{ marginBottom: 0 }}><input type="checkbox" checked={!!o.includeUsersWithoutTime} onChange={(e) => setO({ ...o, includeUsersWithoutTime: e.target.checked })} /> incluir usuários sem tempo</label>
          <span className="right"><ReportActions type="WEEKLY" body={request} loading={loading} /></span>
        </div>
      }>
        {data ? <WeeklyView result={data} currency={ctx.currency} dateFormat={ctx.dateFormat} today={ctx.today} /> : (loading ? <Spinner block /> : null)}
      </ResultCard>
    </>
  );
}

function AttendanceTab({ ctx }) {
  const [o, setO] = useLocalState('clockfy.reportAttendance', { sortColumn: 'USER', sortOrder: 'ASCENDING', hasTimeOff: true, pageSize: 50 });
  const [page, setPage] = useState(1);
  const baseKey = JSON.stringify([ctx.body, o]);
  useEffect(() => { setPage(1); }, [baseKey]);
  const request = useMemo(() => ({ ...ctx.body, sortOrder: o.sortOrder, attendanceFilter: { page, pageSize: Number(o.pageSize) || 50, sortColumn: o.sortColumn || 'USER', hasTimeOff: !!o.hasTimeOff } }), [ctx.body, o, page]);
  const { data, loading, error } = useReport('attendance', ctx.wsId, request);
  const onSort = (col) => setO({ ...o, sortColumn: col, sortOrder: o.sortColumn === col && o.sortOrder === 'ASCENDING' ? 'DESCENDING' : 'ASCENDING' });
  return (
    <>
      <FilterBar ctx={ctx} />
      <ResultCard loading={loading} error={error} toolbar={
        <div className="report-toolbar" style={{ borderTop: 'none' }}>
          <label className="checkbox small" style={{ marginBottom: 0 }}><input type="checkbox" checked={!!o.hasTimeOff} onChange={(e) => setO({ ...o, hasTimeOff: e.target.checked })} /> incluir folgas aprovadas</label>
          <span className="muted small">Por página</span>
          <select value={o.pageSize || 50} onChange={(e) => setO({ ...o, pageSize: Number(e.target.value) })}>{[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          <span className="right"><ReportActions type="ATTENDANCE" body={request} loading={loading} /></span>
        </div>
      }>
        {data ? <AttendanceView result={data} timeZone={ctx.timeZone} hour12={ctx.hour12} dateFormat={ctx.dateFormat} sortColumn={o.sortColumn} sortOrder={o.sortOrder} onSort={onSort} /> : (loading ? <Spinner block /> : null)}
        {data && data.count > (data.pageSize || 50) && <Pagination page={page} pageSize={data.pageSize || 50} count={data.count} onChange={setPage} />}
      </ResultCard>
    </>
  );
}

function ExpensesTab({ ctx }) {
  const [o, setO] = useLocalState('clockfy.reportExpenses', { sortColumn: 'DATE', sortOrder: 'DESCENDING', categories: [], note: '', withoutNote: false, pageSize: 50 });
  const [page, setPage] = useState(1);
  const { data: cats } = useAsync(() => api.get(`${ws(ctx.wsId)}/expenses/categories`, { 'page-size': 500 }).then((r) => r.categories || []), [ctx.wsId], { initial: [] });
  const baseKey = JSON.stringify([ctx.body, o]);
  useEffect(() => { setPage(1); }, [baseKey]);
  const request = useMemo(() => JSON.parse(JSON.stringify({
    ...ctx.body, sortOrder: o.sortOrder, sortColumn: o.sortColumn || 'DATE', page, pageSize: Number(o.pageSize) || 50,
    categories: o.categories?.length ? { ids: o.categories, contains: 'CONTAINS', status: 'ALL' } : undefined,
    note: o.withoutNote ? undefined : (o.note || '').trim() || undefined, withoutNote: o.withoutNote || undefined,
  })), [ctx.body, o, page]);
  const { data, loading, error } = useReport('expenses/detailed', ctx.wsId, request);
  const onSort = (col) => setO({ ...o, sortColumn: col, sortOrder: o.sortColumn === col && o.sortOrder === 'ASCENDING' ? 'DESCENDING' : 'ASCENDING' });
  return (
    <>
      <FilterBar ctx={ctx} />
      <ResultCard loading={loading} error={error} toolbar={
        <div className="report-toolbar" style={{ borderTop: 'none' }}>
          <MultiPicker options={cats || []} value={o.categories || []} onChange={(v) => setO({ ...o, categories: v })} label="Categorias" width={180} />
          <input placeholder="Observação contém…" value={o.note || ''} disabled={!!o.withoutNote} onChange={(e) => setO({ ...o, note: e.target.value })} style={{ width: 180 }} />
          <label className="checkbox small" style={{ marginBottom: 0 }}><input type="checkbox" checked={!!o.withoutNote} onChange={(e) => setO({ ...o, withoutNote: e.target.checked })} /> sem observação</label>
          <span className="right"><ReportActions type="EXPENSE_DETAILED" body={request} loading={loading} /></span>
        </div>
      }>
        {data ? <ExpenseReportView result={data} currency={ctx.currency} dateFormat={ctx.dateFormat} sortColumn={o.sortColumn} sortOrder={o.sortOrder} onSort={onSort} /> : (loading ? <Spinner block /> : null)}
        {data && data.totals?.expensesCount > (data.pageSize || 50) && <Pagination page={page} pageSize={data.pageSize || 50} count={data.totals.expensesCount} onChange={setPage} />}
      </ResultCard>
    </>
  );
}

function SharedTab({ ctx }) {
  const { user, isAdmin, toast } = useStore();
  const users = ctx.options.users;
  const { data, loading, error, reload } = useAsync(() => api.get(`${ws(ctx.wsId)}/shared-reports`, { 'page-size': 500 }), [ctx.wsId]);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const list = data?.reports || [];
  const nameOf = (id) => users.find((u) => u.id === id)?.name || (id === user.id ? user.name : '—');
  const remove = (r) => setConfirm({ title: 'Excluir relatório compartilhado', danger: true, confirmLabel: 'Excluir', message: `Excluir “${r.name}”? O link deixará de funcionar.`, onConfirm: async () => { try { await api.delete(`${ws(ctx.wsId)}/shared-reports/${r.id}`); toast('Relatório excluído', 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); } } });
  return (
    <div className="card">
      <div className="filter-bar"><span className="muted small">{list.length} relatório(s) compartilhado(s). Crie novos pelo botão “Salvar / compartilhar” em qualquer relatório.</span></div>
      <Alert type="error">{error ? errorMessage(error) : null}</Alert>
      {loading && !data ? <Spinner block /> : list.length === 0 ? <Empty icon="🔗" title="Nenhum relatório compartilhado">Salve um relatório para gerar um link compartilhável.</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nome</th><th>Tipo</th><th>Autor</th><th>Visibilidade</th><th>Período</th><th>Link</th><th className="actions" /></tr></thead>
          <tbody>
            {list.map((r) => {
              const link = sharedLink(r.id); const mine = r.reportAuthor === user.id || isAdmin;
              return (
                <tr key={r.id}>
                  <td className="bold"><Link to={`/shared/${r.id}`} target="_blank">{r.name}</Link></td>
                  <td>{REPORT_TYPES[r.type] || r.type}</td>
                  <td>{nameOf(r.reportAuthor)}</td>
                  <td>{r.isPublic ? <span className="badge success">Público</span> : <span className="badge" title={[...(r.visibleToUsers || []).map((u) => u.name), ...(r.visibleToUserGroups || []).map((g) => g.name)].join(', ')}>Privado{(r.visibleToUsers?.length || r.visibleToUserGroups?.length) ? ` · ${(r.visibleToUsers?.length || 0) + (r.visibleToUserGroups?.length || 0)}` : ''}</span>}</td>
                  <td className="muted small">{r.fixedDate ? 'Data fixa' : 'Livre'}</td>
                  <td><span className="share-link"><input readOnly value={link} style={{ width: 220, fontSize: 12 }} onFocus={(e) => e.target.select()} /><button className="btn ghost sm" onClick={() => copy(link, toast)}>Copiar</button></span></td>
                  <td className="actions">
                    <Dropdown>
                      <a href={link} target="_blank" rel="noreferrer">Abrir</a>
                      {mine && <button onClick={() => setEditing(r)}>Editar</button>}
                      {mine && <button className="danger" onClick={() => remove(r)}>Excluir</button>}
                    </Dropdown>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {editing && <SharedReportModal report={editing} onClose={() => setEditing(null)} onSaved={() => reload()} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function ScheduledTab({ ctx }) {
  const { user, isAdmin, toast, dateFormat, timeZone } = useStore();
  const users = ctx.options.users;
  const { data, loading, error, reload } = useAsync(() => api.get(`${ws(ctx.wsId)}/scheduled-reports`, { 'page-size': 500 }), [ctx.wsId], { initial: [] });
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [sending, setSending] = useState(null);
  const list = data || [];
  const nameOf = (id) => users.find((u) => u.id === id)?.name || (id === user.id ? user.name : '—');
  const when = (r) => `${FREQ[r.frequency] || r.frequency}${r.frequency === 'WEEKLY' ? ` (${WEEKDAY_LABELS[r.dayOfWeek] || r.dayOfWeek})` : r.frequency === 'MONTHLY' ? ` (dia ${r.dayOfMonth})` : ''} às ${pad(r.hour ?? 8)}:00`;
  const toggle = async (r, enabled) => { try { await api.put(`${ws(ctx.wsId)}/scheduled-reports/${r.id}`, { enabled }); reload(); } catch (e) { toast(errorMessage(e), 'error'); } };
  const send = async (r) => { setSending(r.id); try { const s = await api.post(`${ws(ctx.wsId)}/scheduled-reports/${r.id}/send`); toast(`Enviado para ${(s.recipients || []).join(', ')}`, 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); } finally { setSending(null); } };
  const remove = (r) => setConfirm({ title: 'Excluir agendamento', danger: true, confirmLabel: 'Excluir', message: `Excluir o agendamento “${r.name}”?`, onConfirm: async () => { try { await api.delete(`${ws(ctx.wsId)}/scheduled-reports/${r.id}`); toast('Agendamento excluído', 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); } } });
  return (
    <div className="card">
      <div className="filter-bar"><span className="muted small">{list.length} agendamento(s). Crie novos pelo botão “Agendar por e-mail” em qualquer relatório.</span></div>
      <Alert type="error">{error ? errorMessage(error) : null}</Alert>
      {loading && !list.length ? <Spinner block /> : list.length === 0 ? <Empty icon="✉" title="Nenhum relatório agendado">Agende o envio periódico de um relatório por e-mail.</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nome</th><th>Tipo</th><th>Quando</th><th>Destinatários</th><th>Formato</th><th>Autor</th><th>Último envio</th><th>Ativo</th><th className="actions" /></tr></thead>
          <tbody>
            {list.map((r) => {
              const mine = r.userId === user.id || isAdmin;
              return (
                <tr key={r.id}>
                  <td className="bold">{r.name}</td>
                  <td>{REPORT_TYPES[r.type] || r.type}</td>
                  <td className="nowrap">{when(r)}</td>
                  <td className="small muted" style={{ maxWidth: 240 }}><span className="truncate" style={{ display: 'inline-block', maxWidth: 240 }} title={(r.recipients || []).join(', ')}>{(r.recipients || []).join(', ')}</span></td>
                  <td>{r.exportType}</td>
                  <td>{nameOf(r.userId)}</td>
                  <td className="small muted nowrap">{r.lastSentAt ? `${fmtDate(toLocalDateStr(r.lastSentAt, timeZone), dateFormat)}` : 'nunca'}</td>
                  <td><Switch value={!!r.enabled} disabled={!mine} onChange={(v) => toggle(r, v)} /></td>
                  <td className="actions">
                    {mine && <Dropdown>
                      <button onClick={() => setEditing(r)}>Editar</button>
                      <button onClick={() => send(r)} disabled={sending === r.id}>{sending === r.id ? 'Enviando…' : 'Enviar agora'}</button>
                      <button className="danger" onClick={() => remove(r)}>Excluir</button>
                    </Dropdown>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {editing && <ScheduledReportModal report={editing} onClose={() => setEditing(null)} onSaved={() => reload()} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- page
export default function Reports() {
  const { settings } = useStore();
  const navigate = useNavigate();
  const loc = useLocation();
  const ctx = useReportFilter();
  const TABS = [
    { value: 'summary', label: 'Resumo' }, { value: 'detailed', label: 'Detalhado' }, { value: 'weekly', label: 'Semanal' }, { value: 'attendance', label: 'Presença' },
    ...(settings.expensesEnabled !== false ? [{ value: 'expenses', label: 'Despesas' }] : []),
    { value: 'shared', label: 'Compartilhados' }, { value: 'scheduled', label: 'Agendados' },
  ];
  const sub = loc.pathname.split('/')[2] || 'summary';
  const tab = TABS.some((t) => t.value === sub) ? sub : 'summary';
  if (!ctx.wsId) return <Spinner block />;
  return (
    <div>
      <div className="page-header"><h1>Relatórios</h1></div>
      <Tabs tabs={TABS} value={tab} onChange={(t) => navigate(`/reports/${t}`)} />
      <Routes>
        <Route index element={<Navigate to="summary" replace />} />
        <Route path="summary" element={<SummaryTab ctx={ctx} />} />
        <Route path="detailed" element={<DetailedTab ctx={ctx} />} />
        <Route path="weekly" element={<WeeklyTab ctx={ctx} />} />
        <Route path="attendance" element={<AttendanceTab ctx={ctx} />} />
        <Route path="expenses" element={<ExpensesTab ctx={ctx} />} />
        <Route path="shared" element={<SharedTab ctx={ctx} />} />
        <Route path="scheduled" element={<ScheduledTab ctx={ctx} />} />
        <Route path="*" element={<Navigate to="/reports/summary" replace />} />
      </Routes>
    </div>
  );
}
