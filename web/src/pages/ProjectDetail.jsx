import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints, request, ws } from '../api.js';
import { MultiPicker, useUsers, invalidateCache } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, Tabs, ColorPicker, Switch, SettingRow, Avatar, Money } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { fmtDuration, isoToSeconds, secondsToIso, parseDuration, errorMessage } from '../lib/format.js';
import { Progress } from './Projects.jsx';

const TABS = [{ value: 'tasks', label: 'Tarefas' }, { value: 'access', label: 'Acesso' }, { value: 'status', label: 'Status' }, { value: 'settings', label: 'Configurações' }];
const centsToInput = (c) => (c == null ? '' : (Number(c) / 100).toFixed(2));
const inputToCents = (s) => { const n = parseFloat(String(s).replace(',', '.')); return Number.isNaN(n) ? null : Math.round(n * 100); };

export default function ProjectDetail() {
  const { id, '*': sub } = useParams();
  const navigate = useNavigate();
  const tab = TABS.some((t) => t.value === sub) ? sub : 'tasks';
  const { workspace, user, isAdmin, settings, toast } = useStore();
  const wsId = workspace?.id;
  const { data: project, loading, error, reload } = useAsync(() => endpoints.project(wsId, id, { hydrated: true }), [wsId, id]);
  const [roles, setRoles] = useState([]);
  useEffect(() => { if (wsId) api.get(`${ws(wsId)}/users/${user.id}/roles`).then(setRoles).catch(() => setRoles([])); }, [wsId, user.id]);
  const canManage = isAdmin || roles.some((r) => r.role?.name === 'PROJECT_MANAGER' && r.role?.entityId === id);
  const canEditRates = isAdmin || !settings.onlyAdminsSeeBillableRates;
  const showRates = canEditRates || canManage;
  const [confirm, setConfirm] = useState(null);

  async function act(fn, msg) {
    try { await fn(); invalidateCache(wsId); if (msg) toast(msg, 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); }
  }

  if (loading && !project) return <Spinner block />;
  if (error) return <Alert type="error">{errorMessage(error)}</Alert>;
  if (!project) return null;

  return (
    <div>
      <div className="page-header">
        <Link to="/projects" className="btn ghost icon" title="Voltar">←</Link>
        <span className="dot" style={{ background: project.color, width: 14, height: 14 }} />
        <h1 style={{ color: project.color }}>{project.name}</h1>
        {project.clientName && <span className="muted">– {project.clientName}</span>}
        {project.archived && <span className="badge warning">Arquivado</span>}
        {project.template && <span className="badge">Modelo</span>}
        <span className={`badge ${project.public ? 'primary' : ''}`}>{project.public ? 'Público' : 'Privado'}</span>
        {project.billable && <span className="badge success">Faturável</span>}
        <span className="right muted">Rastreado: <b className="mono">{fmtDuration(isoToSeconds(project.duration), { seconds: false })}</b></span>
        {canManage && (
          <Dropdown label="Ações ▾" className="secondary">
            <button onClick={() => act(() => api.put(`${ws(wsId)}/projects/${id}`, { archived: !project.archived }), project.archived ? 'Projeto restaurado' : 'Projeto arquivado')}>{project.archived ? 'Restaurar' : 'Arquivar'}</button>
            {isAdmin && <button onClick={() => act(() => api.patch(`${ws(wsId)}/projects/${id}/template`, { isTemplate: !project.template }), 'Modelo atualizado')}>{project.template ? 'Remover modelo' : 'Salvar como modelo'}</button>}
            <button onClick={() => act(() => api.post(`${ws(wsId)}/projects/from-template`, { name: `${project.name} (cópia)`, templateProjectId: id, clientId: project.clientId || null, color: project.color, isPublic: project.public }).then((p) => navigate(`/projects/${p.id}`)), 'Projeto duplicado')}>Duplicar</button>
            {project.archived && <hr />}
            {project.archived && <button className="danger" onClick={() => setConfirm({ title: 'Excluir projeto', danger: true, confirmLabel: 'Excluir', message: `Excluir permanentemente “${project.name}” e todos os seus registros? Esta ação não pode ser desfeita.`, onConfirm: () => act(() => api.delete(`${ws(wsId)}/projects/${id}`).then(() => navigate('/projects')), 'Projeto excluído') })}>Excluir</button>}
          </Dropdown>
        )}
      </div>
      <Tabs tabs={TABS} value={tab} onChange={(t) => navigate(`/projects/${id}/${t}`)} />
      {tab === 'tasks' && <TasksTab project={project} canManage={canManage} showRates={showRates} onChange={reload} />}
      {tab === 'access' && <AccessTab project={project} canManage={canManage} canEditRates={canEditRates} showRates={showRates} onChange={reload} />}
      {tab === 'status' && <StatusTab project={project} canManage={canManage} showRates={showRates} onChange={reload} />}
      {tab === 'settings' && <SettingsTab project={project} canManage={canManage} canEditRates={canEditRates} showRates={showRates} onChange={reload} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- Tarefas
function TasksTab({ project, canManage, onChange }) {
  const { workspace, isAdmin, settings, toast } = useStore();
  const wsId = workspace?.id;
  const users = useUsers(wsId);
  const [filter, setFilter] = useState('ACTIVE');
  const { data: tasks, loading, reload, setData } = useAsync(() => endpoints.tasks(wsId, project.id), [wsId, project.id], { initial: [] });
  const [name, setName] = useState('');
  const [estimate, setEstimate] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const canEdit = canManage || isAdmin || settings.entityCreationPermissions?.whoCanCreateTasks === 'EVERYONE' || settings.onlyAdminsCreateTask === false;
  const list = (tasks || []).filter((t) => filter === 'ALL' || t.status === filter);
  const userName = (uid) => users.find((u) => u.id === uid)?.name || '?';

  async function run(fn, msg) {
    try { await fn(); invalidateCache(wsId); if (msg) toast(msg, 'success'); reload(); onChange?.(); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  async function add() {
    if (!name.trim()) return;
    const secs = estimate ? parseDuration(estimate) : null;
    if (estimate && secs == null) { toast('Estimativa inválida', 'error'); return; }
    await run(() => api.post(`${ws(wsId)}/projects/${project.id}/tasks`, { name: name.trim(), estimate: secs ? secondsToIso(secs) : undefined }), 'Tarefa criada');
    setName(''); setEstimate('');
  }
  const setStatus = (t, status) => run(() => api.put(`${ws(wsId)}/projects/${project.id}/tasks/${t.id}`, { status }), status === 'DONE' ? 'Tarefa concluída' : 'Tarefa reaberta');
  const remove = (t) => setConfirm({ title: 'Excluir tarefa', danger: true, confirmLabel: 'Excluir', message: `Excluir a tarefa “${t.name}”? Os registros de tempo perderão a associação com ela.`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/projects/${project.id}/tasks/${t.id}`), 'Tarefa excluída') });

  return (
    <div className="card">
      <div className="filter-bar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="ACTIVE">Ativas</option><option value="DONE">Concluídas</option><option value="ALL">Todas</option></select>
        <span className="muted small">{list.length} tarefa(s)</span>
        {canEdit && <>
          <input className="right" placeholder="Nova tarefa…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} style={{ minWidth: 220 }} />
          <input placeholder="Estimativa (ex.: 8h)" value={estimate} onChange={(e) => setEstimate(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} style={{ width: 140 }} />
          <button className="btn" onClick={add} disabled={!name.trim()}>Adicionar</button>
        </>}
      </div>
      {loading && !tasks?.length ? <Spinner block /> : list.length === 0 ? <Empty icon="☑" title="Nenhuma tarefa">{canEdit ? 'Adicione tarefas para detalhar o trabalho do projeto.' : 'Este projeto ainda não tem tarefas.'}</Empty> : (
        <table className="table">
          <thead><tr><th>Tarefa</th><th>Responsáveis</th><th className="num">Estimativa</th><th className="num">Rastreado</th><th style={{ minWidth: 140 }}>Progresso</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.map((t) => {
              const est = isoToSeconds(t.estimate); const secs = isoToSeconds(t.duration); const pct = est ? Math.round((secs / est) * 100) : null;
              return (
                <tr key={t.id} style={t.status === 'DONE' ? { opacity: .7 } : undefined}>
                  <td className="bold" style={t.status === 'DONE' ? { textDecoration: 'line-through' } : undefined}>{t.name}{t.billable === false && <span className="badge ml">Não faturável</span>}</td>
                  <td>{t.assigneeIds?.length ? <span className="row gap wrap">{t.assigneeIds.map((uid) => <span key={uid} className="chip"><Avatar user={users.find((u) => u.id === uid) || { name: '?' }} size={18} />{userName(uid)}</span>)}</span> : <span className="light small">Qualquer pessoa</span>}</td>
                  <td className="num mono">{est ? fmtDuration(est, { seconds: false }) : '—'}</td>
                  <td className="num mono">{fmtDuration(secs, { seconds: false })}</td>
                  <td>{pct == null ? <span className="light small">—</span> : <div className="progress" title={`${pct}%`}><div className={pct > 100 ? 'over' : ''} style={{ width: `${Math.min(100, pct)}%` }} /></div>}</td>
                  <td>{t.status === 'DONE' ? <span className="badge success">Concluída</span> : <span className="badge primary">Ativa</span>}</td>
                  <td className="actions">
                    {canEdit && <Dropdown>
                      <button onClick={() => setEditing(t)}>Editar</button>
                      <button onClick={() => setStatus(t, t.status === 'DONE' ? 'ACTIVE' : 'DONE')}>{t.status === 'DONE' ? 'Reabrir' : 'Marcar como concluída'}</button>
                      <hr />
                      <button className="danger" onClick={() => remove(t)}>Excluir</button>
                    </Dropdown>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editing && <TaskModal task={editing} project={project} users={users} onClose={() => setEditing(null)} onSaved={(t) => { setEditing(null); setData((l) => l.map((x) => (x.id === t.id ? t : x))); invalidateCache(wsId); onChange?.(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function TaskModal({ task, project, users, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const [f, setF] = useState({ name: task.name, assigneeIds: task.assigneeIds || [], estimate: isoToSeconds(task.estimate) ? fmtDuration(isoToSeconds(task.estimate), { seconds: false }) : '', billable: task.billable == null ? '' : String(task.billable), status: task.status });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    const secs = f.estimate ? parseDuration(f.estimate) : null;
    if (f.estimate && secs == null) { setError('Estimativa inválida (ex.: 8h, 1:30)'); return; }
    setBusy(true); setError(null);
    try {
      const t = await api.put(`${ws(workspace.id)}/projects/${project.id}/tasks/${task.id}`, { name: f.name.trim(), assigneeIds: f.assigneeIds, estimate: secs ? secondsToIso(secs) : null, billable: f.billable === '' ? null : f.billable === 'true', status: f.status });
      toast('Tarefa salva', 'success'); onSaved(t);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Editar tarefa" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>Salvar</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
      <div className="field"><label>Responsáveis</label><MultiPicker options={users} value={f.assigneeIds} onChange={(v) => set('assigneeIds', v)} label="Qualquer pessoa" /></div>
      <div className="grid cols-3">
        <div className="field"><label>Estimativa</label><input value={f.estimate} onChange={(e) => set('estimate', e.target.value)} placeholder="ex.: 8h" /></div>
        <div className="field"><label>Faturável</label><select value={f.billable} onChange={(e) => set('billable', e.target.value)}><option value="">Herdar do projeto</option><option value="true">Sim</option><option value="false">Não</option></select></div>
        <div className="field"><label>Status</label><select value={f.status} onChange={(e) => set('status', e.target.value)}><option value="ACTIVE">Ativa</option><option value="DONE">Concluída</option></select></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Acesso
function AccessTab({ project, canManage, canEditRates, showRates, onChange }) {
  const { workspace, isAdmin, toast, currency } = useStore();
  const wsId = workspace?.id;
  const { data: users, reload: reloadUsers } = useAsync(() => endpoints.users(wsId, { 'include-roles': true, status: 'ALL' }), [wsId], { initial: [] });
  const { data: groups } = useAsync(() => endpoints.groups(wsId), [wsId], { initial: [] });
  const [addUsers, setAddUsers] = useState([]);
  const [addGroups, setAddGroups] = useState([]);
  const [rate, setRate] = useState(null); // { userId, kind }
  const [confirm, setConfirm] = useState(null);
  const members = project.memberships.filter((m) => m.membershipType === 'PROJECT');
  const groupMembers = project.memberships.filter((m) => m.membershipType === 'USERGROUP');
  const userOf = (id) => (users || []).find((u) => u.id === id);
  const isManager = (uid) => (userOf(uid)?.roles || []).some((r) => r.role === 'PROJECT_MANAGER' && r.entityId === project.id);
  const available = (users || []).filter((u) => u.memberStatus !== 'INACTIVE' && !members.some((m) => m.userId === u.id));
  const availableGroups = (groups || []).filter((g) => !groupMembers.some((m) => m.userId === g.id));

  async function run(fn, msg) {
    try { await fn(); invalidateCache(wsId); if (msg) toast(msg, 'success'); onChange(); reloadUsers(); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  const membership = (body) => api.post(`${ws(wsId)}/projects/${project.id}/memberships`, body);
  const roleBody = { role: 'PROJECT_MANAGER', entityId: project.id };
  const toggleManager = (uid, on) => run(() => (on ? api.post(`${ws(wsId)}/users/${uid}/roles`, roleBody) : request('DELETE', `${ws(wsId)}/users/${uid}/roles`, roleBody)), on ? 'Gerente de projeto adicionado' : 'Gerente de projeto removido');

  return (
    <div>
      {project.public && <Alert type="info">Este projeto é <b>público</b>: todos os membros do workspace podem registrar tempo nele. A lista abaixo define taxas específicas e gerentes do projeto.</Alert>}
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Membros</h3>
          {canManage && <div className="row gap right">
            <MultiPicker options={available} value={addUsers} onChange={setAddUsers} label="Adicionar membros…" width={240} />
            <button className="btn sm" disabled={!addUsers.length} onClick={() => run(() => membership({ userIds: addUsers }).then(() => setAddUsers([])), 'Membros adicionados')}>Adicionar</button>
          </div>}
        </div>
        {members.length === 0 ? <Empty icon="👥" title="Nenhum membro específico">{project.public ? 'Todos têm acesso por ser um projeto público.' : 'Adicione membros para que possam registrar tempo neste projeto privado.'}</Empty> : (
          <table className="table">
            <thead><tr><th>Membro</th>{showRates && <th className="num">Taxa horária</th>}{showRates && <th className="num">Custo/hora</th>}<th>Gerente</th><th /></tr></thead>
            <tbody>
              {members.map((m) => { const u = userOf(m.userId); return (
                <tr key={m.userId}>
                  <td><span className="row gap"><Avatar user={u || { name: '?' }} size={26} /><span><div>{u?.name || m.userId}</div><div className="small muted">{u?.email}</div></span>{u?.memberStatus === 'INACTIVE' && <span className="badge">Inativo</span>}</span></td>
                  {showRates && <td className="num">{m.hourlyRate ? <Money cents={m.hourlyRate.amount} currency={m.hourlyRate.currency} /> : <span className="light">Herdada</span>}{canEditRates && canManage && <button className="btn ghost sm ml" onClick={() => setRate({ userId: m.userId, kind: 'hourly', value: m.hourlyRate?.amount })}>✎</button>}</td>}
                  {showRates && <td className="num">{m.costRate ? <Money cents={m.costRate.amount} currency={m.costRate.currency} /> : <span className="light">Herdado</span>}{canEditRates && canManage && <button className="btn ghost sm ml" onClick={() => setRate({ userId: m.userId, kind: 'cost', value: m.costRate?.amount })}>✎</button>}</td>}
                  <td>{isAdmin ? <Switch value={isManager(m.userId)} onChange={(v) => toggleManager(m.userId, v)} /> : (isManager(m.userId) ? <span className="badge primary">Gerente</span> : <span className="light">—</span>)}</td>
                  <td className="actions">{canManage && <button className="btn ghost sm" onClick={() => setConfirm({ title: 'Remover membro', message: `Remover ${u?.name || 'este membro'} do projeto?`, confirmLabel: 'Remover', onConfirm: () => run(() => membership({ userIds: [m.userId], remove: true }), 'Membro removido') })}>Remover</button>}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Grupos</h3>
          {canManage && <div className="row gap right">
            <MultiPicker options={availableGroups} value={addGroups} onChange={setAddGroups} label="Adicionar grupos…" width={240} />
            <button className="btn sm" disabled={!addGroups.length} onClick={() => run(() => membership({ userGroupIds: addGroups }).then(() => setAddGroups([])), 'Grupos adicionados')}>Adicionar</button>
          </div>}
        </div>
        {groupMembers.length === 0 ? <div className="card-body muted small">Nenhum grupo com acesso a este projeto.</div> : (
          <table className="table">
            <thead><tr><th>Grupo</th><th className="num">Membros</th><th /></tr></thead>
            <tbody>{groupMembers.map((m) => { const g = (groups || []).find((x) => x.id === m.userId); return (
              <tr key={m.userId}><td className="bold">{g?.name || m.userId}</td><td className="num">{g?.userIds?.length ?? '—'}</td><td className="actions">{canManage && <button className="btn ghost sm" onClick={() => run(() => membership({ userGroupIds: [m.userId], remove: true }), 'Grupo removido')}>Remover</button>}</td></tr>
            ); })}</tbody>
          </table>
        )}
      </div>
      {rate && <RateModal title={rate.kind === 'hourly' ? 'Taxa horária do membro' : 'Custo por hora do membro'} value={rate.value} currency={project.hourlyRate?.currency || currency} onClose={() => setRate(null)}
        onSave={(amount, since) => run(() => api.put(`${ws(wsId)}/projects/${project.id}/users/${rate.userId}/${rate.kind === 'hourly' ? 'hourly-rate' : 'cost-rate'}`, { amount, since }).then(() => setRate(null)), 'Taxa atualizada')} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

export function RateModal({ title, value, currency, onClose, onSave }) {
  const [amount, setAmount] = useState(centsToInput(value));
  const [since, setSince] = useState('');
  const [busy, setBusy] = useState(false);
  const cents = inputToCents(amount);
  return (
    <Modal title={title} size="sm" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy || cents == null || cents < 0} onClick={async () => { setBusy(true); try { await onSave(cents, since ? `${since}T00:00:00Z` : undefined); } finally { setBusy(false); } }}>Salvar</button></>}>
      <div className="field"><label>Valor por hora ({currency})</label><input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></div>
      <div className="field"><label>Aplicar aos registros a partir de (opcional)</label><input type="date" value={since} onChange={(e) => setSince(e.target.value)} /><div className="small muted mt">Se informado, os registros existentes a partir desta data serão recalculados com a nova taxa.</div></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Status
function StatusTab({ project, canManage, showRates, onChange }) {
  const { workspace, toast, currency } = useStore();
  const wsId = workspace?.id;
  const { data: status, loading, reload } = useAsync(() => (canManage ? api.get(`${ws(wsId)}/projects/${project.id}/status`) : Promise.resolve(null)), [wsId, project.id, canManage]);
  const te = project.timeEstimate || {}; const be = project.budgetEstimate || {};
  const [f, setF] = useState({
    tActive: !!te.active, tType: te.type || 'AUTO', tHours: isoToSeconds(te.estimate) ? fmtDuration(isoToSeconds(te.estimate), { seconds: false }) : '', tNonBillable: te.includeNonBillable !== false, tReset: te.resetOption || '',
    bActive: !!be.active, bType: be.type || 'AUTO', bAmount: centsToInput(be.estimate || 0), bExpenses: !!be.includeExpenses, bReset: be.resetOption || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const cur = project.hourlyRate?.currency || currency;

  async function save() {
    const secs = f.tHours ? parseDuration(f.tHours) : 0;
    if (f.tHours && secs == null) { toast('Estimativa de tempo inválida', 'error'); return; }
    const cents = inputToCents(f.bAmount || '0');
    setBusy(true);
    try {
      await api.patch(`${ws(wsId)}/projects/${project.id}/estimate`, {
        timeEstimate: { active: f.tActive, type: f.tType, estimate: secondsToIso(secs || 0), includeNonBillable: f.tNonBillable, resetOption: f.tReset || null },
        budgetEstimate: { active: f.bActive, type: f.bType, estimate: cents || 0, includeExpenses: f.bExpenses, resetOption: f.bReset || null },
      });
      toast('Estimativas salvas', 'success'); invalidateCache(wsId); onChange(); reload();
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  }

  const tracked = isoToSeconds(project.duration);
  const ts = status?.timeEstimate; const bs = status?.budgetEstimate;
  return (
    <div>
      {canManage && (loading && !status ? <Spinner block /> : status && (
        <div className="grid cols-4 mb">
          <div className="card stat"><div className="label">Tempo rastreado</div><div className="value mono">{fmtDuration(status.trackedSeconds, { seconds: false })}</div></div>
          <div className="card stat"><div className="label">Faturável</div><div className="value mono">{fmtDuration(status.billableSeconds, { seconds: false })}</div></div>
          <div className="card stat"><div className="label">Valor</div><div className="value">{showRates ? <Money cents={status.earned} currency={cur} /> : '—'}</div></div>
          <div className="card stat"><div className="label">Custo</div><div className="value">{showRates ? <Money cents={status.cost} currency={cur} /> : '—'}</div></div>
        </div>
      ))}
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h3 style={{ margin: 0 }}>Estimativa de tempo</h3>{canManage && <span className="right"><Switch value={f.tActive} onChange={(v) => set('tActive', v)} /></span>}</div>
          <div className="card-body">
            {ts && ts.estimateSeconds ? (
              <div className="mb">
                <div className="row"><span className="muted small">{fmtDuration(ts.trackedSeconds, { seconds: false })} de {fmtDuration(ts.estimateSeconds, { seconds: false })}</span><span className="right bold mono">{ts.percent}%</span></div>
                <div className="progress mt"><div className={ts.percent > 100 ? 'over' : ''} style={{ width: `${Math.min(100, ts.percent || 0)}%` }} /></div>
                <div className="small muted mt">{ts.remainingSeconds >= 0 ? `Restam ${fmtDuration(ts.remainingSeconds, { seconds: false })}` : `Excedido em ${fmtDuration(-ts.remainingSeconds, { seconds: false })}`}</div>
              </div>
            ) : <div className="mb"><Progress project={project} /></div>}
            {canManage ? (
              <>
                <div className="field"><label>Tipo</label><select value={f.tType} onChange={(e) => set('tType', e.target.value)}><option value="MANUAL">Manual (estimativa do projeto)</option><option value="AUTO">Automática (soma das estimativas das tarefas)</option></select></div>
                {f.tType === 'MANUAL' && <div className="field"><label>Horas estimadas</label><input value={f.tHours} onChange={(e) => set('tHours', e.target.value)} placeholder="ex.: 120h ou 120:00" /></div>}
                <div className="field"><label>Reiniciar</label><select value={f.tReset} onChange={(e) => set('tReset', e.target.value)}><option value="">Nunca</option><option value="WEEKLY">Semanalmente</option><option value="MONTHLY">Mensalmente</option><option value="YEARLY">Anualmente</option></select></div>
                <label className="checkbox"><input type="checkbox" checked={f.tNonBillable} onChange={(e) => set('tNonBillable', e.target.checked)} /> Incluir horas não faturáveis</label>
              </>
            ) : <div className="muted small">Tempo rastreado: {fmtDuration(tracked, { seconds: false })}{te.estimate && isoToSeconds(te.estimate) ? ` · Estimativa: ${fmtDuration(isoToSeconds(te.estimate), { seconds: false })}` : ''}</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3 style={{ margin: 0 }}>Orçamento</h3>{canManage && <span className="right"><Switch value={f.bActive} onChange={(v) => set('bActive', v)} /></span>}</div>
          <div className="card-body">
            {bs && bs.estimate ? (
              <div className="mb">
                <div className="row"><span className="muted small"><Money cents={bs.used} currency={cur} /> de <Money cents={bs.estimate} currency={cur} /></span><span className="right bold mono">{bs.percent}%</span></div>
                <div className="progress mt"><div className={bs.percent > 100 ? 'over' : ''} style={{ width: `${Math.min(100, bs.percent || 0)}%` }} /></div>
                <div className="small muted mt">{bs.remaining >= 0 ? <>Restam <Money cents={bs.remaining} currency={cur} /></> : <>Excedido em <Money cents={-bs.remaining} currency={cur} /></>}</div>
              </div>
            ) : <div className="light small mb">{showRates ? 'Sem orçamento definido' : 'Orçamento visível apenas para administradores'}</div>}
            {canManage && showRates && (
              <>
                <div className="field"><label>Tipo</label><select value={f.bType} onChange={(e) => set('bType', e.target.value)}><option value="MANUAL">Manual (orçamento do projeto)</option><option value="AUTO">Automático (soma dos orçamentos das tarefas)</option></select></div>
                {f.bType === 'MANUAL' && <div className="field"><label>Orçamento ({cur})</label><input type="number" step="0.01" min="0" value={f.bAmount} onChange={(e) => set('bAmount', e.target.value)} /></div>}
                <div className="field"><label>Reiniciar</label><select value={f.bReset} onChange={(e) => set('bReset', e.target.value)}><option value="">Nunca</option><option value="WEEKLY">Semanalmente</option><option value="MONTHLY">Mensalmente</option><option value="YEARLY">Anualmente</option></select></div>
                <label className="checkbox"><input type="checkbox" checked={f.bExpenses} onChange={(e) => set('bExpenses', e.target.checked)} /> Incluir despesas</label>
              </>
            )}
          </div>
        </div>
      </div>
      {canManage && <div className="row mt"><button className="btn right" disabled={busy} onClick={save}>Salvar estimativas</button></div>}
    </div>
  );
}

// ---------------------------------------------------------------- Configurações
function SettingsTab({ project, canManage, canEditRates, showRates, onChange }) {
  const { workspace, isAdmin, toast, currency } = useStore();
  const wsId = workspace?.id;
  const { data: clients } = useAsync(() => endpoints.clients(wsId, { archived: false }), [wsId], { initial: [] });
  const { data: fields, reload: reloadFields } = useAsync(() => api.get(`${ws(wsId)}/projects/${project.id}/custom-fields`), [wsId, project.id], { initial: [] });
  const [f, setF] = useState({ name: project.name, clientId: project.clientId || '', color: project.color, isPublic: !!project.public, billable: !!project.billable, hourlyRate: centsToInput(project.hourlyRate?.amount), costRate: centsToInput(project.costRate?.amount), note: project.note || '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const cur = project.hourlyRate?.currency || currency;

  async function save() {
    if (!f.name.trim()) { toast('Informe o nome', 'error'); return; }
    setBusy(true);
    try {
      const body = { name: f.name.trim(), clientId: f.clientId || null, color: f.color, isPublic: f.isPublic, note: f.note };
      if (canEditRates) {
        body.billable = f.billable;
        const hr = f.hourlyRate === '' ? null : inputToCents(f.hourlyRate); const cr = f.costRate === '' ? null : inputToCents(f.costRate);
        if ((hr ?? null) !== (project.hourlyRate?.amount ?? null)) body.hourlyRate = hr == null ? null : { amount: hr, currency: cur };
        if ((cr ?? null) !== (project.costRate?.amount ?? null)) body.costRate = cr == null ? null : { amount: cr, currency: cur };
      }
      await api.put(`${ws(wsId)}/projects/${project.id}`, body);
      toast('Projeto salvo', 'success'); invalidateCache(wsId); onChange();
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  }
  async function patchField(cf, patch) {
    try { await api.patch(`${ws(wsId)}/projects/${project.id}/custom-fields/${cf.id}`, patch); reloadFields(); } catch (e) { toast(errorMessage(e), 'error'); }
  }

  if (!canManage) return <div className="card"><Empty icon="⚙" title="Somente gerentes do projeto e administradores podem alterar as configurações">Entre em contato com um administrador do workspace.</Empty></div>;
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Detalhes</h3></div>
        <div className="card-body">
          <div className="field"><label>Nome</label><input value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="field"><label>Cliente</label><select value={f.clientId} onChange={(e) => set('clientId', e.target.value)}><option value="">Sem cliente</option>{(clients || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}{project.clientId && !(clients || []).some((c) => c.id === project.clientId) && <option value={project.clientId}>{project.clientName}</option>}</select></div>
          <div className="field"><label>Cor</label><ColorPicker value={f.color} onChange={(c) => set('color', c)} /></div>
          <SettingRow title="Visibilidade" desc={f.isPublic ? 'Público: todos os membros do workspace podem registrar tempo.' : 'Privado: apenas membros e grupos adicionados na aba Acesso.'}><Switch value={f.isPublic} onChange={(v) => set('isPublic', v)} /></SettingRow>
          {canEditRates && <SettingRow title="Faturável por padrão" desc="Novos registros neste projeto serão marcados como faturáveis."><Switch value={f.billable} onChange={(v) => set('billable', v)} /></SettingRow>}
          {showRates && (
            <div className="grid cols-2 mt">
              <div className="field"><label>Taxa horária ({cur})</label><input type="number" step="0.01" min="0" value={f.hourlyRate} onChange={(e) => set('hourlyRate', e.target.value)} disabled={!canEditRates} placeholder="Herdada do workspace" /></div>
              <div className="field"><label>Custo por hora ({cur})</label><input type="number" step="0.01" min="0" value={f.costRate} onChange={(e) => set('costRate', e.target.value)} disabled={!canEditRates} placeholder="Herdado do workspace" /></div>
            </div>
          )}
          <div className="field"><label>Observação</label><textarea value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="Notas internas sobre o projeto" /></div>
          <div className="row"><button className="btn right" disabled={busy} onClick={save}>Salvar</button></div>
        </div>
      </div>
      <div>
        <div className="card">
          <div className="card-head"><h3 style={{ margin: 0 }}>Campos personalizados</h3></div>
          {(fields || []).filter((cf) => cf.entityType === 'TIMEENTRY').length === 0 ? <div className="card-body muted small">Nenhum campo personalizado de registro de tempo. {isAdmin && <Link to="/settings/custom-fields">Criar campos</Link>}</div> : (
            <table className="table compact">
              <thead><tr><th>Campo</th><th>Valor padrão no projeto</th><th>Status</th></tr></thead>
              <tbody>
                {(fields || []).filter((cf) => cf.entityType === 'TIMEENTRY').map((cf) => {
                  const pd = (cf.projectDefaultValues || []).find((d) => d.projectId === project.id);
                  return (
                    <tr key={cf.id}>
                      <td><div className="bold">{cf.name}</div><div className="small light">{cf.type}</div></td>
                      <td><CustomFieldInput field={cf} value={pd?.value ?? cf.workspaceDefaultValue} onChange={(v) => patchField(cf, { defaultValue: v })} /></td>
                      <td><select value={pd?.status || cf.status} onChange={(e) => patchField(cf, { status: e.target.value })} style={{ width: 'auto' }}><option value="VISIBLE">Visível</option><option value="INVISIBLE">Invisível</option><option value="INACTIVE">Inativo</option></select></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <div className="card-head"><h3 style={{ margin: 0 }}>Status do projeto</h3></div>
          <div className="card-body">
            <SettingRow title={project.archived ? 'Projeto arquivado' : 'Projeto ativo'} desc={project.archived ? 'Não aparece nos seletores; os registros existentes são mantidos.' : 'Arquivar oculta o projeto dos seletores sem excluir registros.'}>
              <button className="btn secondary sm" onClick={async () => { try { await api.put(`${ws(wsId)}/projects/${project.id}`, { archived: !project.archived }); invalidateCache(wsId); toast(project.archived ? 'Projeto restaurado' : 'Projeto arquivado', 'success'); onChange(); } catch (e) { toast(errorMessage(e), 'error'); } }}>{project.archived ? 'Restaurar' : 'Arquivar'}</button>
            </SettingRow>
            {isAdmin && <SettingRow title="Modelo" desc="Modelos podem ser usados para criar novos projetos com as mesmas tarefas, membros e taxas."><Switch value={!!project.template} onChange={async (v) => { try { await api.patch(`${ws(wsId)}/projects/${project.id}/template`, { isTemplate: v }); invalidateCache(wsId); onChange(); } catch (e) { toast(errorMessage(e), 'error'); } }} /></SettingRow>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CustomFieldInput({ field, value, onChange, disabled }) {
  const [v, setV] = useState(value ?? (field.type === 'DROPDOWN_MULTIPLE' ? [] : field.type === 'CHECKBOX' ? false : ''));
  useEffect(() => { setV(value ?? (field.type === 'DROPDOWN_MULTIPLE' ? [] : field.type === 'CHECKBOX' ? false : '')); }, [value, field.type]);
  const commit = (nv) => { setV(nv); if (JSON.stringify(nv) !== JSON.stringify(value ?? null)) onChange(nv); };
  switch (field.type) {
    case 'CHECKBOX': return <input type="checkbox" checked={!!v} disabled={disabled} onChange={(e) => commit(e.target.checked)} />;
    case 'NUMBER': return <input type="number" value={v ?? ''} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => commit(v === '' ? null : Number(v))} />;
    case 'DROPDOWN_SINGLE': return <select value={v ?? ''} disabled={disabled} onChange={(e) => commit(e.target.value || null)}><option value="">—</option>{(field.allowedValues || []).map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    case 'DROPDOWN_MULTIPLE': return <MultiPicker options={(field.allowedValues || []).map((o) => ({ id: o, name: o }))} value={Array.isArray(v) ? v : []} onChange={(nv) => commit(nv)} label="Selecionar…" />;
    case 'LINK': return <input type="url" value={v ?? ''} placeholder="https://" disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => commit(v || null)} />;
    default: return <input value={v ?? ''} placeholder={field.placeholder || ''} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => commit(v || null)} />;
  }
}
