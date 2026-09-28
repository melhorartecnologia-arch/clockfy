import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, Tabs, Avatar, Switch, ColorPicker } from '../components/ui.jsx';
import { ProjectPicker, MultiPicker, useUsers, useProjects } from '../components/pickers.jsx';
import { useAsync } from '../lib/hooks.js';
import { toLocalDateStr, toLocalTimeStr, localToIso, addDays, startOfWeekStr, fmtDate, monthName, weekdayShort, pad, errorMessage } from '../lib/format.js';

// Constants ---------------------------------------------------------------------------------------
export const POLICY_ICONS = { UMBRELLA: '☂️', SNOWFLAKE: '❄️', FAMILY: '👨‍👩‍👧', PLANE: '✈️', STETHOSCOPE: '🩺', HEALTH_METRICS: '💗', CHILDCARE: '🧸', LUGGAGE: '🧳', MONETIZATION: '💰', CALENDAR: '📅' };
const ICON_LABEL = { UMBRELLA: 'Guarda-chuva', SNOWFLAKE: 'Floco de neve', FAMILY: 'Família', PLANE: 'Avião', STETHOSCOPE: 'Estetoscópio', HEALTH_METRICS: 'Saúde', CHILDCARE: 'Cuidado infantil', LUGGAGE: 'Bagagem', MONETIZATION: 'Remuneração', CALENDAR: 'Calendário' };
const STATUS_LABEL = { PENDING: ['Pendente', 'warning'], APPROVED: ['Aprovada', 'success'], REJECTED: ['Rejeitada', 'danger'], WITHDRAWN: ['Retirada', ''] };
const HALF_LABEL = { FIRST_HALF: 'manhã', SECOND_HALF: 'tarde' };

const unitText = (n, unit) => `${Number(n).toLocaleString('pt-BR')} ${unit === 'HOURS' ? 'h' : Number(n) === 1 ? 'dia' : 'dias'}`;
const whenText = (iso, tz, df) => (iso ? `${fmtDate(toLocalDateStr(iso, tz), df)} ${toLocalTimeStr(iso, tz)}` : '');
function PolicyLabel({ policy, name, color, icon }) {
  const c = policy?.color || color || '#999'; const i = policy?.icon || icon;
  return <span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: c, marginRight: 0 }} />{i && POLICY_ICONS[i] && <span>{POLICY_ICONS[i]}</span>}<span style={{ color: c, fontWeight: 500 }}>{policy?.name || name}</span></span>;
}
function StatusBadge({ status }) { const [l, cls] = STATUS_LABEL[status] || [status, '']; return <span className={`badge ${cls}`}>{l}</span>; }
function useMyRoles(wsId, userId) {
  const { data } = useAsync(() => api.get(`${ws(wsId)}/users/${userId}/roles`), [wsId, userId], { initial: [] });
  return (data || []).map((r) => r.role?.name).filter(Boolean);
}
function useGroups(wsId) {
  const { data } = useAsync(() => endpoints.groups(wsId), [wsId], { initial: [] });
  return data || [];
}

// Page ---------------------------------------------------------------------------------------------
export default function TimeOff() {
  const { '*': sub } = useParams();
  const navigate = useNavigate();
  const { workspace, user, isAdmin } = useStore();
  const wsId = workspace?.id;
  const roles = useMyRoles(wsId, user.id);
  const isTeamManager = roles.includes('TEAM_MANAGER');
  const tabs = [{ value: 'requests', label: 'Solicitações' }, { value: 'balances', label: 'Saldos' }, { value: 'calendar', label: 'Calendário' }, ...(isAdmin ? [{ value: 'policies', label: 'Políticas' }, { value: 'holidays', label: 'Feriados' }] : [])];
  const tab = tabs.some((t) => t.value === sub) ? sub : 'requests';
  const policies = useAsync(() => api.get(`${ws(wsId)}/time-off/policies`, { status: 'ALL', 'page-size': 500 }), [wsId], { initial: [] });
  const list = policies.data || [];
  return (
    <div>
      <div className="page-header"><h1>Folgas</h1></div>
      <Tabs tabs={tabs} value={tab} onChange={(t) => navigate(`/time-off/${t}`)} />
      {policies.error && <Alert type="error">{errorMessage(policies.error)}</Alert>}
      {tab === 'requests' && <RequestsTab policies={list} isTeamManager={isTeamManager} />}
      {tab === 'balances' && <BalancesTab policies={list} isTeamManager={isTeamManager} />}
      {tab === 'calendar' && <CalendarTab policies={list} />}
      {tab === 'policies' && isAdmin && <PoliciesTab policies={list} loading={policies.loading} reload={policies.reload} />}
      {tab === 'holidays' && isAdmin && <HolidaysTab />}
    </div>
  );
}

// Requests -----------------------------------------------------------------------------------------
function RequestsTab({ policies, isTeamManager }) {
  const { workspace, user, isAdmin, timeZone, dateFormat, toast } = useStore();
  const wsId = workspace.id;
  const canPickUsers = isAdmin || isTeamManager;
  const users = useUsers(canPickUsers ? wsId : null);
  const [f, setF] = useState({ status: 'ALL', users: [], policy: '', start: '', end: '' });
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null); // { type: 'new' | 'edit' | 'decide', request, status }
  const [confirm, setConfirm] = useState(null);
  const pageSize = 50;
  const body = useMemo(() => ({
    statuses: f.status === 'ALL' ? undefined : [f.status], users: f.users.length ? f.users : undefined, policies: f.policy ? [f.policy] : undefined,
    start: f.start ? localToIso(f.start, '00:00', timeZone) : undefined, end: f.end ? localToIso(f.end, '23:59', timeZone) : undefined, page, pageSize,
  }), [f, page, timeZone]);
  const { data, loading, error, reload } = useAsync(() => api.post(`${ws(wsId)}/time-off/requests`, body), [wsId, JSON.stringify(body)], { initial: null });
  const list = data?.requests || [];
  const policyOf = (r) => policies.find((p) => p.id === r.policyId);
  const canApprove = (r) => {
    if (isAdmin) return true;
    const a = policyOf(r)?.approve || {};
    if (a.specificMembers && (a.userIds || []).includes(user.id)) return true;
    return isTeamManager && a.teamManagers && r.userId !== user.id;
  };
  const isMine = (r) => r.userId === user.id || r.requesterUserId === user.id;

  async function run(fn, msg) { try { await fn(); if (msg) toast(msg, 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); throw e; } }
  const withdraw = (r) => setConfirm({ title: 'Retirar solicitação', confirmLabel: 'Retirar', message: `Retirar a solicitação de ${r.policyName} (${periodText(r)})?${r.status.statusType === 'APPROVED' ? ' O saldo será devolvido e os registros automáticos removidos.' : ''}`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/time-off/policies/${r.policyId}/requests/${r.id}`), 'Solicitação retirada') });
  const remove = (r) => setConfirm({ title: 'Excluir solicitação', danger: true, confirmLabel: 'Excluir', message: `Excluir permanentemente a solicitação de ${r.userName} (${r.policyName}, ${periodText(r)})?`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/time-off/policies/${r.policyId}/requests/${r.id}`), 'Solicitação excluída') });
  const periodText = (r) => {
    const s = toLocalDateStr(r.timeOffPeriod.period.start, r.userTimeZone || timeZone); const e = toLocalDateStr(r.timeOffPeriod.period.end, r.userTimeZone || timeZone);
    return s === e ? fmtDate(s, dateFormat) : `${fmtDate(s, dateFormat)} – ${fmtDate(e, dateFormat)}`;
  };

  return (
    <div className="card">
      <div className="filter-bar">
        <select value={f.status} onChange={(e) => { setPage(1); setF({ ...f, status: e.target.value }); }}><option value="ALL">Todos os status</option><option value="PENDING">Pendentes</option><option value="APPROVED">Aprovadas</option><option value="REJECTED">Rejeitadas</option><option value="WITHDRAWN">Retiradas</option></select>
        <select value={f.policy} onChange={(e) => { setPage(1); setF({ ...f, policy: e.target.value }); }}><option value="">Todas as políticas</option>{policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {canPickUsers && <MultiPicker options={users} value={f.users} onChange={(v) => { setPage(1); setF({ ...f, users: v }); }} label="Todos os membros" width={200} />}
        <input type="date" value={f.start} onChange={(e) => { setPage(1); setF({ ...f, start: e.target.value }); }} style={{ width: 150 }} title="De" />
        <span className="muted">–</span>
        <input type="date" value={f.end} onChange={(e) => { setPage(1); setF({ ...f, end: e.target.value }); }} style={{ width: 150 }} title="Até" />
        {(f.start || f.end || f.users.length || f.policy || f.status !== 'ALL') && <button className="btn link" onClick={() => { setPage(1); setF({ status: 'ALL', users: [], policy: '', start: '', end: '' }); }}>Limpar</button>}
        <button className="btn right" onClick={() => setModal({ type: 'new' })}>+ Solicitar folga</button>
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      {loading && !data ? <Spinner block /> : list.length === 0 ? <Empty icon="🌴" title="Nenhuma solicitação">{policies.length ? 'Solicite uma folga usando o botão acima.' : isAdmin ? 'Crie uma política de folga na aba “Políticas” para começar.' : 'Nenhuma política de folga disponível para você.'}</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Membro</th><th>Política</th><th>Período</th><th className="num">Duração</th><th>Status</th><th>Nota</th><th>Decisão</th><th /></tr></thead>
            <tbody>
              {list.map((r) => {
                const st = r.status; const tp = r.timeOffPeriod;
                return (
                  <tr key={r.id}>
                    <td><span className="row gap"><Avatar user={{ name: r.userName }} size={26} /><span><div>{r.userName}{r.userId === user.id && <span className="light"> (eu)</span>}</div>{r.requesterUserId !== r.userId && <div className="small light">solicitado por {r.requesterUserName}</div>}</span></span></td>
                    <td><PolicyLabel policy={policyOf(r)} name={r.policyName} /></td>
                    <td className="nowrap">{periodText(r)}{tp.halfDay && <div className="small muted">Meio dia ({HALF_LABEL[tp.halfDayPeriod] || 'não definido'})</div>}</td>
                    <td className="num mono">{unitText(r.balanceDiff, r.timeUnit)}</td>
                    <td><StatusBadge status={st.statusType} /></td>
                    <td className="small muted" style={{ maxWidth: 220 }}>{r.note || <span className="light">–</span>}{st.note && <div className="small" style={{ color: 'var(--text)' }}>↳ {st.note}</div>}</td>
                    <td className="small muted nowrap">{st.changedByUserName ? <>{st.changedByUserName}<br />{whenText(st.changedAt, timeZone, dateFormat)}</> : <span className="light">Criada em {whenText(r.createdAt, timeZone, dateFormat)}</span>}</td>
                    <td className="actions">
                      {st.statusType === 'PENDING' && canApprove(r) && <button className="btn success sm" onClick={() => setModal({ type: 'decide', request: r, status: 'APPROVED' })}>Aprovar</button>}
                      <Dropdown>
                        {st.statusType === 'PENDING' && canApprove(r) && <button onClick={() => setModal({ type: 'decide', request: r, status: 'APPROVED' })}>Aprovar</button>}
                        {st.statusType === 'PENDING' && canApprove(r) && <button className="danger" onClick={() => setModal({ type: 'decide', request: r, status: 'REJECTED' })}>Rejeitar…</button>}
                        {st.statusType === 'APPROVED' && canApprove(r) && <button className="danger" onClick={() => setModal({ type: 'decide', request: r, status: 'REJECTED' })}>Rejeitar (reverter)…</button>}
                        {st.statusType === 'PENDING' && (isMine(r) || isAdmin) && <button onClick={() => setModal({ type: 'edit', request: r })}>Editar</button>}
                        {['PENDING', 'APPROVED'].includes(st.statusType) && isMine(r) && !isAdmin && <button onClick={() => withdraw(r)}>Retirar</button>}
                        {isAdmin && <button className="danger" onClick={() => remove(r)}>Excluir</button>}
                        {!canApprove(r) && !isMine(r) && !isAdmin && <button disabled>Sem ações disponíveis</button>}
                      </Dropdown>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.count > pageSize && (
        <div className="pagination">
          <span className="muted small">Página {page} de {Math.ceil(data.count / pageSize)} · {data.count} solicitação(ões)</span>
          <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Anterior</button>
          <button className="btn ghost sm" disabled={page * pageSize >= data.count} onClick={() => setPage(page + 1)}>Próxima ›</button>
        </div>
      )}
      {(modal?.type === 'new' || modal?.type === 'edit') && <RequestModal policies={policies} request={modal.request} canPickUsers={canPickUsers} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {modal?.type === 'decide' && <DecideModal request={modal.request} status={modal.status} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function DecideModal({ request: r, status, onClose, onDone }) {
  const { workspace, toast } = useStore();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const approve = status === 'APPROVED';
  async function go() {
    setBusy(true);
    try { await api.patch(`${ws(workspace.id)}/time-off/policies/${r.policyId}/requests/${r.id}`, { status, note: note || null }); toast(approve ? 'Solicitação aprovada' : 'Solicitação rejeitada', 'success'); onDone(); } catch (e) { toast(errorMessage(e), 'error'); setBusy(false); }
  }
  return (
    <Modal title={approve ? 'Aprovar solicitação' : 'Rejeitar solicitação'} size="sm" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className={`btn ${approve ? 'success' : 'danger'}`} disabled={busy} onClick={go}>{approve ? 'Aprovar' : 'Rejeitar'}</button></>}>
      <p><b>{r.userName}</b> · {r.policyName} · {unitText(r.balanceDiff, r.timeUnit)}</p>
      {approve ? <p className="muted small">O saldo do membro será descontado{r.status.statusType === 'PENDING' ? '' : ''} e, se a política permitir, os registros de tempo de folga serão criados automaticamente.</p> : <p className="muted small">{r.status.statusType === 'APPROVED' ? 'A aprovação será revertida: o saldo é devolvido e os registros automáticos removidos.' : 'O membro será notificado.'}</p>}
      <div className="field"><label>Nota {approve ? '(opcional)' : '(motivo)'}</label><textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></div>
    </Modal>
  );
}

function RequestModal({ policies, request, canPickUsers, onClose, onSaved }) {
  const { workspace, user, timeZone, dateFormat, toast } = useStore();
  const wsId = workspace.id;
  const users = useUsers(canPickUsers ? wsId : null);
  const today = toLocalDateStr(new Date(), timeZone);
  const init = request ? {
    policyId: request.policyId, userId: request.userId, start: toLocalDateStr(request.timeOffPeriod.period.start, request.userTimeZone || timeZone), end: toLocalDateStr(request.timeOffPeriod.period.end, request.userTimeZone || timeZone),
    halfDay: !!request.timeOffPeriod.halfDay, halfDayPeriod: request.timeOffPeriod.halfDayPeriod === 'SECOND_HALF' ? 'SECOND_HALF' : 'FIRST_HALF', note: request.note || '',
  } : { policyId: '', userId: user.id, start: today, end: today, halfDay: false, halfDayPeriod: 'FIRST_HALF', note: '' };
  const [f, setF] = useState(init);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const eligible = useMemo(() => policies.filter((p) => !p.archived && (p.userIds || []).includes(f.userId)), [policies, f.userId]);
  const policy = policies.find((p) => p.id === f.policyId);
  useEffect(() => { if (!request && (!f.policyId || !eligible.some((p) => p.id === f.policyId))) set('policyId', eligible[0]?.id || ''); }, [eligible, f.policyId, request]);
  useEffect(() => { if (policy && !policy.allowHalfDay && f.halfDay) set('halfDay', false); }, [policy, f.halfDay]);
  const balances = useAsync(() => api.get(`${ws(wsId)}/time-off/balance/user/${f.userId}`, { 'page-size': 500 }).then((r) => r.balances), [wsId, f.userId], { initial: [] });
  const balance = (balances.data || []).find((b) => b.policyId === f.policyId);

  async function save() {
    setBusy(true); setError(null);
    try {
      if (!f.policyId) throw new Error('Selecione uma política');
      if (!f.start) throw new Error('Informe a data inicial');
      const end = f.halfDay ? f.start : (f.end || f.start);
      if (end < f.start) throw new Error('A data final deve ser depois da inicial');
      const body = { timeOffPeriod: { period: { start: f.start, end }, isHalfDay: f.halfDay, halfDayPeriod: f.halfDay ? f.halfDayPeriod : 'NOT_DEFINED' }, note: f.note || null };
      if (request) await api.put(`${ws(wsId)}/time-off/policies/${request.policyId}/requests/${request.id}`, body);
      else if (f.userId === user.id) await api.post(`${ws(wsId)}/time-off/policies/${f.policyId}/requests`, body);
      else await api.post(`${ws(wsId)}/time-off/policies/${f.policyId}/users/${f.userId}/requests`, body);
      toast(request ? 'Solicitação atualizada' : 'Solicitação enviada', 'success');
      onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={request ? 'Editar solicitação de folga' : 'Solicitar folga'} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy || !eligible.length} onClick={save}>{request ? 'Salvar' : 'Enviar solicitação'}</button></>}>
      <Alert type="error">{error}</Alert>
      {canPickUsers && !request && <div className="field"><label>Membro</label><select value={f.userId} onChange={(e) => set('userId', e.target.value)}>{(users.length ? users : [user]).map((u) => <option key={u.id} value={u.id}>{u.id === user.id ? `${u.name} (eu)` : u.name}</option>)}</select></div>}
      <div className="field">
        <label>Política</label>
        {eligible.length === 0 ? <Alert type="warning">Nenhuma política de folga disponível para este membro.</Alert>
          : <select value={f.policyId} disabled={!!request} onChange={(e) => set('policyId', e.target.value)}>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.timeUnit === 'HOURS' ? 'horas' : 'dias'})</option>)}</select>}
        {policy && <div className="small muted mt row gap wrap"><PolicyLabel policy={policy} /><span>· Saldo disponível: <b>{balance ? unitText(balance.balance, policy.timeUnit) : balances.loading ? '…' : unitText(0, policy.timeUnit)}</b>{policy.allowNegativeBalance && <span className="light"> (saldo negativo permitido{policy.negativeBalance?.amount ? ` até ${unitText(policy.negativeBalance.amount, policy.timeUnit)}` : ''})</span>}</span>{!policy.approve?.requiresApproval && <span className="badge success">Aprovação automática</span>}</div>}
      </div>
      <div className="grid cols-2">
        <div className="field"><label>Início</label><input type="date" value={f.start} onChange={(e) => { set('start', e.target.value); if (f.end < e.target.value) set('end', e.target.value); }} /></div>
        <div className="field"><label>Fim</label><input type="date" value={f.halfDay ? f.start : f.end} disabled={f.halfDay} min={f.start} onChange={(e) => set('end', e.target.value)} /></div>
      </div>
      {policy?.allowHalfDay && (
        <div className="row gap wrap mb">
          <label className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" checked={f.halfDay} onChange={(e) => set('halfDay', e.target.checked)} /> Meio dia</label>
          {f.halfDay && <select value={f.halfDayPeriod} onChange={(e) => set('halfDayPeriod', e.target.value)} style={{ width: 'auto' }}><option value="FIRST_HALF">Manhã (primeira metade)</option><option value="SECOND_HALF">Tarde (segunda metade)</option></select>}
        </div>
      )}
      <div className="field"><label>Nota</label><textarea value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="Motivo ou observações (opcional)" /></div>
      <div className="small light">Somente dias úteis do membro contam; feriados são descontados automaticamente. Período: {fmtDate(f.start, dateFormat)}{!f.halfDay && f.end && f.end !== f.start ? ` – ${fmtDate(f.end, dateFormat)}` : ''}.</div>
    </Modal>
  );
}

// Balances -----------------------------------------------------------------------------------------
function BalancesTab({ policies, isTeamManager }) {
  const { workspace, user, isAdmin, toast } = useStore();
  const wsId = workspace.id;
  const matrix = isAdmin || isTeamManager;
  const active = useMemo(() => policies.filter((p) => !p.archived), [policies]);
  const [showArchived, setShowArchived] = useState(false);
  const cols = showArchived ? policies : active;
  const [q, setQ] = useState('');
  const [adjust, setAdjust] = useState(null); // { policyId, userIds }
  const { data, loading, error, reload } = useAsync(async () => {
    if (!matrix) return (await api.get(`${ws(wsId)}/time-off/balance/user/${user.id}`, { 'page-size': 500 })).balances;
    const all = await Promise.all(cols.map((p) => api.get(`${ws(wsId)}/time-off/balance/policy/${p.id}`, { 'page-size': 5000 }).then((r) => r.balances).catch(() => [])));
    return all.flat();
  }, [wsId, matrix, cols.map((p) => p.id).join()], { initial: [] });
  const balances = data || [];
  const rowsByUser = useMemo(() => {
    const m = new Map();
    for (const b of balances) { if (!m.has(b.userId)) m.set(b.userId, { userId: b.userId, userName: b.userName, cells: {} }); m.get(b.userId).cells[b.policyId] = b; }
    return [...m.values()].filter((r) => !q || r.userName.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.userName.localeCompare(b.userName));
  }, [balances, q]);

  if (!matrix) {
    return (
      <div className="card">
        {error && <Alert type="error">{errorMessage(error)}</Alert>}
        {loading && !balances.length ? <Spinner block /> : balances.length === 0 ? <Empty icon="🌴" title="Nenhum saldo">Você ainda não está incluído em nenhuma política de folga.</Empty> : (
          <table className="table">
            <thead><tr><th>Política</th><th className="num">Total</th><th className="num">Usado</th><th className="num">Saldo</th></tr></thead>
            <tbody>{balances.map((b) => <tr key={b.id} style={b.policyArchived ? { opacity: .6 } : undefined}><td><PolicyLabel policy={policies.find((p) => p.id === b.policyId)} name={b.policyName} />{b.policyArchived && <span className="badge ml">Arquivada</span>}</td><td className="num mono">{unitText(b.total, b.policyTimeUnit)}</td><td className="num mono">{unitText(b.used, b.policyTimeUnit)}</td><td className="num mono bold" style={b.balance < 0 ? { color: 'var(--danger)' } : undefined}>{unitText(b.balance, b.policyTimeUnit)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    );
  }
  return (
    <div className="card">
      <div className="filter-bar">
        <input type="search" placeholder="Buscar membro…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 200 }} />
        <label className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" style={{ minWidth: 0 }} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Incluir políticas arquivadas</label>
        <span className="muted small">{rowsByUser.length} membro(s)</span>
        {isAdmin && <button className="btn right" disabled={!active.length} onClick={() => setAdjust({ policyId: active[0]?.id, userIds: [] })}>Ajustar saldo</button>}
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      {loading && !balances.length ? <Spinner block /> : cols.length === 0 ? <Empty icon="🌴" title="Nenhuma política">{isAdmin ? 'Crie uma política de folga na aba “Políticas”.' : 'Nenhuma política de folga ativa.'}</Empty> : rowsByUser.length === 0 ? <Empty icon="👥" title="Nenhum membro">Nenhum saldo encontrado.</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Membro</th>{cols.map((p) => <th key={p.id} className="num"><PolicyLabel policy={p} /><div className="light" style={{ fontWeight: 400, textTransform: 'none' }}>saldo · usado / total ({p.timeUnit === 'HOURS' ? 'h' : 'dias'})</div></th>)}</tr></thead>
            <tbody>
              {rowsByUser.map((r) => (
                <tr key={r.userId}>
                  <td><span className="row gap"><Avatar user={{ name: r.userName }} size={26} />{r.userName}{r.userId === user.id && <span className="light"> (eu)</span>}</span></td>
                  {cols.map((p) => { const b = r.cells[p.id]; return (
                    <td key={p.id} className="num" style={isAdmin && b ? { cursor: 'pointer' } : undefined} title={isAdmin && b ? 'Ajustar saldo' : undefined} onClick={() => isAdmin && b && setAdjust({ policyId: p.id, userIds: [r.userId] })}>
                      {b ? <><span className="bold mono" style={b.balance < 0 ? { color: 'var(--danger)' } : undefined}>{Number(b.balance).toLocaleString('pt-BR')}</span><span className="light small"> · {Number(b.used).toLocaleString('pt-BR')} / {Number(b.total).toLocaleString('pt-BR')}</span></> : <span className="light">–</span>}
                    </td>
                  ); })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adjust && <AdjustModal policies={active} initial={adjust} onClose={() => setAdjust(null)} onSaved={() => { setAdjust(null); reload(); }} />}
    </div>
  );
}

function AdjustModal({ policies, initial, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const wsId = workspace.id;
  const users = useUsers(wsId);
  const [f, setF] = useState({ policyId: initial.policyId || policies[0]?.id || '', userIds: initial.userIds || [], value: '', note: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const policy = policies.find((p) => p.id === f.policyId);
  const options = useMemo(() => users.filter((u) => !policy || (policy.userIds || []).includes(u.id)), [users, policy]);
  async function save() {
    setBusy(true); setError(null);
    try {
      const value = Number(String(f.value).replace(',', '.'));
      if (!f.policyId) throw new Error('Selecione a política');
      if (!f.userIds.length) throw new Error('Selecione ao menos um membro');
      if (!value || Number.isNaN(value)) throw new Error('Informe um valor diferente de zero');
      await api.patch(`${ws(wsId)}/time-off/balance/policy/${f.policyId}`, { userIds: f.userIds, value, note: f.note || null });
      toast('Saldo ajustado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Ajustar saldo" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>Aplicar</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Política</label><select value={f.policyId} onChange={(e) => setF({ ...f, policyId: e.target.value, userIds: [] })}>{policies.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.timeUnit === 'HOURS' ? 'horas' : 'dias'})</option>)}</select></div>
      <div className="field"><label>Membros</label><MultiPicker options={options} value={f.userIds} onChange={(v) => setF({ ...f, userIds: v })} label="Selecionar membros…" /></div>
      <div className="grid cols-2">
        <div className="field"><label>Valor ({policy?.timeUnit === 'HOURS' ? 'horas' : 'dias'})</label><input type="number" step="0.5" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder="Ex.: 5 ou -2" autoFocus /></div>
        <div className="field"><label>Nota</label><input type="text" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Motivo (opcional)" /></div>
      </div>
      <div className="small light">O valor é somado ao total do membro (use negativo para reduzir). O histórico do saldo é registrado.</div>
    </Modal>
  );
}

// Policies (admin) -----------------------------------------------------------------------------------
function PoliciesTab({ policies, loading, reload }) {
  const { workspace, toast } = useStore();
  const wsId = workspace.id;
  const [status, setStatus] = useState('ACTIVE');
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const users = useUsers(wsId);
  const groups = useGroups(wsId);
  const list = policies.filter((p) => status === 'ALL' || (status === 'ARCHIVED') === p.archived);
  async function run(fn, msg) { try { await fn(); if (msg) toast(msg, 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); throw e; } }
  const archive = (p) => run(() => api.patch(`${ws(wsId)}/time-off/policies/${p.id}`, { status: p.archived ? 'ACTIVE' : 'ARCHIVED' }), p.archived ? 'Política restaurada' : 'Política arquivada');
  const remove = (p) => setConfirm({ title: 'Excluir política', danger: true, confirmLabel: 'Excluir', message: `Excluir permanentemente a política “${p.name}”? Saldos e solicitações vinculados serão removidos.`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/time-off/policies/${p.id}`), 'Política excluída') });
  const approvalText = (p) => {
    const a = p.approve || {};
    if (!a.requiresApproval) return 'Automática';
    const parts = []; if (a.teamManagers) parts.push('gerentes de equipe'); if (a.specificMembers) parts.push(`${(a.userIds || []).length} membro(s) específico(s)`);
    return parts.length ? `Obrigatória: ${parts.join(' e ')}` : 'Obrigatória: administradores';
  };
  const membersText = (p) => (p.everyoneIncludingNew ? 'Todos (incluindo novos)' : [p.userIds?.length ? `${p.userIds.length} membro(s)` : null, p.userGroupIds?.length ? `${p.userGroupIds.length} grupo(s)` : null].filter(Boolean).join(', ') || 'Ninguém');
  return (
    <div className="card">
      <div className="filter-bar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Ativas</option><option value="ARCHIVED">Arquivadas</option><option value="ALL">Todas</option></select>
        <span className="muted small">{list.length} política(s)</span>
        <button className="btn right" onClick={() => setEditing({})}>+ Criar política</button>
      </div>
      {loading && !policies.length ? <Spinner block /> : list.length === 0 ? <Empty icon="🌴" title="Nenhuma política">Crie políticas como “Férias” ou “Atestado” para que os membros solicitem folgas.</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Política</th><th>Unidade</th><th>Membros</th><th>Aprovação</th><th>Acúmulo</th><th>Registros automáticos</th><th>Opções</th><th /></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} style={p.archived ? { opacity: .65 } : undefined}>
                  <td><PolicyLabel policy={p} />{p.archived && <span className="badge ml">Arquivada</span>}</td>
                  <td>{p.timeUnit === 'HOURS' ? 'Horas' : 'Dias'}</td>
                  <td className="small">{membersText(p)}</td>
                  <td className="small">{approvalText(p)}</td>
                  <td className="small">{p.automaticAccrual ? `${unitText(p.automaticAccrual.amount, p.timeUnit)} por ${p.automaticAccrual.period === 'YEAR' ? 'ano' : 'mês'}` : <span className="light">–</span>}</td>
                  <td className="small">{p.automaticTimeEntryCreation?.enabled ? <span className="badge success">Sim</span> : <span className="light">Não</span>}</td>
                  <td className="small">{[p.allowHalfDay ? 'meio dia' : null, p.allowNegativeBalance ? `saldo negativo${p.negativeBalance?.amount ? ` até ${unitText(p.negativeBalance.amount, p.timeUnit)}` : ''}` : null].filter(Boolean).join(', ') || <span className="light">–</span>}</td>
                  <td className="actions">
                    <Dropdown>
                      <button onClick={() => setEditing(p)}>Editar</button>
                      <button onClick={() => archive(p)}>{p.archived ? 'Restaurar' : 'Arquivar'}</button>
                      <hr />
                      <button className="danger" onClick={() => remove(p)}>Excluir</button>
                    </Dropdown>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <PolicyModal policy={editing.id ? editing : null} users={users} groups={groups} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function PolicyModal({ policy: p, users, groups, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const wsId = workspace.id;
  const [f, setF] = useState(() => ({
    name: p?.name || '', color: p?.color || '#03A9F4', icon: p?.icon || 'UMBRELLA', timeUnit: p?.timeUnit || 'DAYS',
    allowHalfDay: !!p?.allowHalfDay, allowNegativeBalance: !!p?.allowNegativeBalance, negativeLimit: p?.negativeBalance?.amount ? String(p.negativeBalance.amount) : '',
    requiresApproval: p ? !!p.approve?.requiresApproval : true, teamManagers: p ? !!p.approve?.teamManagers : true, specificMembers: !!p?.approve?.specificMembers, approverIds: p?.approve?.userIds || [],
    accrualOn: !!p?.automaticAccrual, accrualAmount: p?.automaticAccrual ? String(p.automaticAccrual.amount) : '', accrualPeriod: p?.automaticAccrual?.period || 'MONTH',
    atecOn: !!p?.automaticTimeEntryCreation?.enabled, projectId: p?.automaticTimeEntryCreation?.defaultEntities?.projectId || null, taskId: p?.automaticTimeEntryCreation?.defaultEntities?.taskId || null,
    everyone: p ? !!p.everyoneIncludingNew : true, userIds: p && !p.everyoneIncludingNew ? (p.userIds || []) : [], groupIds: p?.userGroupIds || [], archived: !!p?.archived,
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const unit = f.timeUnit === 'HOURS' ? 'horas' : 'dias';
  async function save() {
    setBusy(true); setError(null);
    try {
      if (!f.name.trim()) throw new Error('Informe o nome da política');
      if (f.atecOn && !f.projectId) throw new Error('Selecione o projeto padrão para a criação automática de registros');
      if (f.accrualOn && !(Number(String(f.accrualAmount).replace(',', '.')) > 0)) throw new Error('Informe a quantidade do acúmulo automático');
      const body = {
        name: f.name.trim(), color: f.color, icon: f.icon, timeUnit: f.timeUnit, allowHalfDay: f.allowHalfDay, allowNegativeBalance: f.allowNegativeBalance,
        negativeBalance: f.allowNegativeBalance && Number(String(f.negativeLimit).replace(',', '.')) > 0 ? { amount: Number(String(f.negativeLimit).replace(',', '.')), timeUnit: f.timeUnit } : null,
        approve: { requiresApproval: f.requiresApproval, teamManagers: f.requiresApproval && f.teamManagers, specificMembers: f.requiresApproval && f.specificMembers, userIds: f.requiresApproval && f.specificMembers ? f.approverIds : [] },
        automaticAccrual: f.accrualOn ? { amount: Number(String(f.accrualAmount).replace(',', '.')), period: f.accrualPeriod, timeUnit: f.timeUnit } : null,
        automaticTimeEntryCreation: f.atecOn ? { enabled: true, defaultEntities: { projectId: f.projectId, taskId: f.taskId || null } } : null,
        everyoneIncludingNew: f.everyone, users: { ids: f.everyone ? [] : f.userIds }, userGroups: { ids: f.everyone ? [] : f.groupIds }, archived: f.archived,
      };
      if (p) await api.put(`${ws(wsId)}/time-off/policies/${p.id}`, body); else await api.post(`${ws(wsId)}/time-off/policies`, body);
      toast(p ? 'Política atualizada' : 'Política criada', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={p ? `Editar política – ${p.name}` : 'Nova política de folga'} size="lg" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{p ? 'Salvar' : 'Criar política'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="grid cols-2">
        <div className="field"><label>Nome</label><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Férias" autoFocus /></div>
        <div className="field"><label>Ícone</label><select value={f.icon} onChange={(e) => set('icon', e.target.value)}>{Object.keys(POLICY_ICONS).map((k) => <option key={k} value={k}>{POLICY_ICONS[k]} {ICON_LABEL[k]}</option>)}</select></div>
      </div>
      <div className="field"><label>Cor</label><ColorPicker value={f.color} onChange={(c) => set('color', c)} /></div>
      <div className="grid cols-2">
        <div className="field"><label>Unidade de tempo</label><select value={f.timeUnit} onChange={(e) => set('timeUnit', e.target.value)}><option value="DAYS">Dias</option><option value="HOURS">Horas</option></select></div>
        <div className="field"><label>Opções</label>
          <label className="checkbox"><input type="checkbox" checked={f.allowHalfDay} onChange={(e) => set('allowHalfDay', e.target.checked)} /> Permitir meio dia</label>
          <label className="checkbox mt"><input type="checkbox" checked={f.allowNegativeBalance} onChange={(e) => set('allowNegativeBalance', e.target.checked)} /> Permitir saldo negativo</label>
          {f.allowNegativeBalance && <div className="row gap mt"><input type="number" min="0" step="0.5" value={f.negativeLimit} onChange={(e) => set('negativeLimit', e.target.value)} placeholder="Sem limite" style={{ width: 130 }} /><span className="muted small">limite em {unit} (vazio = sem limite)</span></div>}
        </div>
      </div>

      <h3>Aprovação</h3>
      <div className="row gap mb"><Switch value={f.requiresApproval} onChange={(v) => set('requiresApproval', v)} /><span>Solicitações exigem aprovação</span></div>
      {f.requiresApproval ? (
        <div className="mb" style={{ paddingLeft: 8 }}>
          <label className="checkbox"><input type="checkbox" checked={f.teamManagers} onChange={(e) => set('teamManagers', e.target.checked)} /> Gerentes de equipe do membro</label>
          <label className="checkbox mt"><input type="checkbox" checked={f.specificMembers} onChange={(e) => set('specificMembers', e.target.checked)} /> Membros específicos</label>
          {f.specificMembers && <div className="mt" style={{ maxWidth: 360 }}><MultiPicker options={users} value={f.approverIds} onChange={(v) => set('approverIds', v)} label="Selecionar aprovadores…" /></div>}
          <div className="small light mt">Administradores do workspace sempre podem aprovar.</div>
        </div>
      ) : <div className="small light mb">As solicitações serão aprovadas automaticamente.</div>}

      <h3>Acúmulo automático</h3>
      <div className="row gap mb wrap"><Switch value={f.accrualOn} onChange={(v) => set('accrualOn', v)} /><span>Creditar saldo automaticamente</span>
        {f.accrualOn && <><input type="number" min="0" step="0.5" value={f.accrualAmount} onChange={(e) => set('accrualAmount', e.target.value)} style={{ width: 110 }} placeholder="Qtd." /><span className="muted">{unit} por</span><select value={f.accrualPeriod} onChange={(e) => set('accrualPeriod', e.target.value)} style={{ width: 'auto' }}><option value="MONTH">mês</option><option value="YEAR">ano</option></select></>}
      </div>

      <h3>Registros de tempo automáticos</h3>
      <div className="row gap mb wrap"><Switch value={f.atecOn} onChange={(v) => set('atecOn', v)} /><span>Criar registros de folga ao aprovar</span>
        {f.atecOn && <ProjectPicker projectId={f.projectId} taskId={f.taskId} onChange={(pid, tid) => { set('projectId', pid); set('taskId', tid); }} placeholder="Projeto padrão" allowCreate={false} />}
      </div>

      <h3>Membros</h3>
      <div className="row gap mb wrap">
        <label className="checkbox" style={{ marginBottom: 0 }}><input type="radio" name="pol-members" checked={f.everyone} onChange={() => set('everyone', true)} /> Todos (incluindo novos membros)</label>
        <label className="checkbox" style={{ marginBottom: 0 }}><input type="radio" name="pol-members" checked={!f.everyone} onChange={() => set('everyone', false)} /> Usuários ou grupos específicos</label>
      </div>
      {!f.everyone && (
        <div className="grid cols-2 mb">
          <div className="field"><label>Usuários</label><MultiPicker options={users} value={f.userIds} onChange={(v) => set('userIds', v)} label="Selecionar usuários…" /></div>
          <div className="field"><label>Grupos</label><MultiPicker options={groups} value={f.groupIds} onChange={(v) => set('groupIds', v)} label="Selecionar grupos…" /></div>
        </div>
      )}
      {p && <label className="checkbox mt"><input type="checkbox" checked={f.archived} onChange={(e) => set('archived', e.target.checked)} /> Arquivada (não aceita novas solicitações)</label>}
    </Modal>
  );
}

// Holidays (admin) -----------------------------------------------------------------------------------
function HolidaysTab() {
  const { workspace, timeZone, dateFormat, toast } = useStore();
  const wsId = workspace.id;
  const [year, setYear] = useState(() => Number(toLocalDateStr(new Date(), timeZone).slice(0, 4)));
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const users = useUsers(wsId);
  const groups = useGroups(wsId);
  const projects = useProjects(wsId);
  const { data, loading, error, reload } = useAsync(() => api.get(`${ws(wsId)}/holidays/in-period`, { start: `${year}-01-01`, end: `${year}-12-31` }), [wsId, year], { initial: [] });
  const list = data || [];
  async function run(fn, msg) { try { await fn(); if (msg) toast(msg, 'success'); reload(); } catch (e) { toast(errorMessage(e), 'error'); throw e; } }
  const edit = async (h) => { try { setEditing(await api.get(`${ws(wsId)}/holidays/${h.id}`)); } catch (e) { toast(errorMessage(e), 'error'); } };
  const remove = (h) => setConfirm({ title: 'Excluir feriado', danger: true, confirmLabel: 'Excluir', message: `Excluir o feriado “${h.name}”?${h.occursAnnually ? ' Todas as ocorrências anuais serão removidas.' : ''} Registros automáticos ainda não aprovados serão removidos.`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/holidays/${h.id}`), 'Feriado excluído') });
  const membersText = (h) => (h.everyoneIncludingNew ? 'Todos' : [h.userIds?.length ? `${h.userIds.length} membro(s)` : null, h.userGroupIds?.length ? `${h.userGroupIds.length} grupo(s)` : null].filter(Boolean).join(', ') || 'Ninguém');
  return (
    <div className="card">
      <div className="filter-bar">
        <div className="btn-group"><button className="btn secondary sm" onClick={() => setYear(year - 1)}>‹</button><button className="btn secondary sm" onClick={() => setYear(Number(toLocalDateStr(new Date(), timeZone).slice(0, 4)))}>{year}</button><button className="btn secondary sm" onClick={() => setYear(year + 1)}>›</button></div>
        <span className="muted small">{list.length} feriado(s) em {year}</span>
        <button className="btn right" onClick={() => setEditing({})}>+ Criar feriado</button>
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      {loading && !list.length ? <Spinner block /> : list.length === 0 ? <Empty icon="📅" title={`Nenhum feriado em ${year}`}>Feriados são descontados das folgas e podem gerar registros de tempo automáticos.</Empty> : (
        <table className="table">
          <thead><tr><th>Feriado</th><th>Período</th><th>Recorrência</th><th>Membros</th><th>Registros automáticos</th><th /></tr></thead>
          <tbody>
            {list.map((h, i) => (
              <tr key={`${h.id}-${h.datePeriod.startDate}-${i}`}>
                <td><span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: h.color || '#999', marginRight: 0 }} /><span style={{ fontWeight: 500 }}>{h.name}</span></span></td>
                <td className="nowrap">{fmtDate(h.datePeriod.startDate, dateFormat)}{h.datePeriod.endDate !== h.datePeriod.startDate && ` – ${fmtDate(h.datePeriod.endDate, dateFormat)}`}<span className="light small ml">{weekdayShort(h.datePeriod.startDate)}</span></td>
                <td>{h.occursAnnually ? <span className="badge primary">Anual</span> : <span className="light">Único</span>}</td>
                <td className="small">{membersText(h)}</td>
                <td className="small">{h.automaticTimeEntryCreation ? <span>{projects.find((p) => p.id === h.projectId)?.name || 'Sim'}</span> : <span className="light">Não</span>}</td>
                <td className="actions"><Dropdown><button onClick={() => edit(h)}>Editar</button><button className="danger" onClick={() => remove(h)}>Excluir</button></Dropdown></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <HolidayModal holiday={editing.id ? editing : null} users={users} groups={groups} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function HolidayModal({ holiday: h, users, groups, onClose, onSaved }) {
  const { workspace, timeZone, toast } = useStore();
  const wsId = workspace.id;
  const today = toLocalDateStr(new Date(), timeZone);
  const [f, setF] = useState(() => ({
    name: h?.name || '', color: h?.color || '#F44336', startDate: h?.datePeriod?.startDate || today, endDate: h?.datePeriod?.endDate || today, occursAnnually: !!h?.occursAnnually,
    everyone: h ? !!h.everyoneIncludingNew : true, userIds: h?.userIds || [], groupIds: h?.userGroupIds || [], atecOn: !!h?.automaticTimeEntryCreation, projectId: h?.projectId || null, taskId: h?.taskId || null,
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    setBusy(true); setError(null);
    try {
      if (!f.name.trim()) throw new Error('Informe o nome do feriado');
      if (!f.startDate) throw new Error('Informe a data inicial');
      if (f.endDate && f.endDate < f.startDate) throw new Error('A data final deve ser depois da inicial');
      if (f.atecOn && !f.projectId) throw new Error('Selecione o projeto padrão para a criação automática de registros');
      const body = {
        name: f.name.trim(), color: f.color, datePeriod: { startDate: f.startDate, endDate: f.endDate || f.startDate }, occursAnnually: f.occursAnnually,
        everyoneIncludingNew: f.everyone, users: { ids: f.everyone ? [] : f.userIds }, userGroups: { ids: f.everyone ? [] : f.groupIds },
        automaticTimeEntryCreation: { enabled: f.atecOn, defaultEntities: f.atecOn ? { projectId: f.projectId, taskId: f.taskId || null } : null },
      };
      if (h) await api.put(`${ws(wsId)}/holidays/${h.id}`, body); else await api.post(`${ws(wsId)}/holidays`, body);
      toast(h ? 'Feriado atualizado' : 'Feriado criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={h ? `Editar feriado – ${h.name}` : 'Novo feriado'} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{h ? 'Salvar' : 'Criar feriado'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Natal" autoFocus /></div>
      <div className="field"><label>Cor</label><ColorPicker value={f.color} onChange={(c) => set('color', c)} /></div>
      <div className="grid cols-2">
        <div className="field"><label>Data inicial</label><input type="date" value={f.startDate} onChange={(e) => { set('startDate', e.target.value); if (f.endDate < e.target.value) set('endDate', e.target.value); }} /></div>
        <div className="field"><label>Data final</label><input type="date" value={f.endDate} min={f.startDate} onChange={(e) => set('endDate', e.target.value)} /></div>
      </div>
      <label className="checkbox mb"><input type="checkbox" checked={f.occursAnnually} onChange={(e) => set('occursAnnually', e.target.checked)} /> Repete anualmente</label>
      <div className="row gap mb wrap"><Switch value={f.atecOn} onChange={(v) => set('atecOn', v)} /><span>Criar registros de tempo automaticamente</span>
        {f.atecOn && <ProjectPicker projectId={f.projectId} taskId={f.taskId} onChange={(pid, tid) => { set('projectId', pid); set('taskId', tid); }} placeholder="Projeto padrão" allowCreate={false} />}
      </div>
      <h3>Aplica-se a</h3>
      <div className="row gap mb wrap">
        <label className="checkbox" style={{ marginBottom: 0 }}><input type="radio" name="hol-members" checked={f.everyone} onChange={() => set('everyone', true)} /> Todos (incluindo novos membros)</label>
        <label className="checkbox" style={{ marginBottom: 0 }}><input type="radio" name="hol-members" checked={!f.everyone} onChange={() => set('everyone', false)} /> Usuários ou grupos específicos</label>
      </div>
      {!f.everyone && (
        <div className="grid cols-2">
          <div className="field"><label>Usuários</label><MultiPicker options={users} value={f.userIds} onChange={(v) => set('userIds', v)} label="Selecionar usuários…" /></div>
          <div className="field"><label>Grupos</label><MultiPicker options={groups} value={f.groupIds} onChange={(v) => set('groupIds', v)} label="Selecionar grupos…" /></div>
        </div>
      )}
    </Modal>
  );
}

// Calendar --------------------------------------------------------------------------------------------
function CalendarTab({ policies }) {
  const { workspace, timeZone, weekStart, user } = useStore();
  const wsId = workspace.id;
  const today = toLocalDateStr(new Date(), timeZone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const first = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const last = `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  const gridStart = startOfWeekStr(first, weekStart);
  const days = useMemo(() => { const out = []; let d = gridStart; while (out.length < 42 && (d <= last || out.length % 7 !== 0)) { out.push(d); d = addDays(d, 1); } return out; }, [gridStart, last]);
  const gridEnd = days[days.length - 1];
  const { data, loading, error } = useAsync(async () => {
    const [reqs, hols] = await Promise.all([
      api.post(`${ws(wsId)}/time-off/requests`, { start: localToIso(gridStart, '00:00', timeZone), end: localToIso(gridEnd, '23:59', timeZone), statuses: ['APPROVED', 'PENDING'], pageSize: 1000 }).then((r) => r.requests),
      api.get(`${ws(wsId)}/holidays/in-period`, { start: gridStart, end: gridEnd }),
    ]);
    return { reqs, hols };
  }, [wsId, gridStart, gridEnd], { initial: null });
  const byDay = useMemo(() => {
    const map = new Map();
    const add = (d, item) => { if (!map.has(d)) map.set(d, []); map.get(d).push(item); };
    for (const h of data?.hols || []) { let d = h.datePeriod.startDate; while (d <= h.datePeriod.endDate) { add(d, { kind: 'holiday', key: `${h.id}-${d}`, label: h.name, color: h.color || '#607D8B' }); d = addDays(d, 1); } }
    for (const r of data?.reqs || []) {
      const tz = r.userTimeZone || timeZone; const s = toLocalDateStr(r.timeOffPeriod.period.start, tz); const e = toLocalDateStr(r.timeOffPeriod.period.end, tz);
      const p = policies.find((x) => x.id === r.policyId);
      let d = s; while (d <= e) { add(d, { kind: 'off', key: `${r.id}-${d}`, label: `${r.userName.split(' ')[0]} · ${r.policyName}${r.timeOffPeriod.halfDay ? ' (½)' : ''}`, title: `${r.userName} – ${r.policyName} (${STATUS_LABEL[r.status.statusType]?.[0] || r.status.statusType})`, color: p?.color || '#03A9F4', icon: p?.icon, pending: r.status.statusType === 'PENDING', mine: r.userId === user.id }); d = addDays(d, 1); }
    }
    return map;
  }, [data, policies, timeZone, user.id]);
  const weekdays = useMemo(() => days.slice(0, 7).map((d) => weekdayShort(d)), [days]);
  return (
    <div className="card">
      <div className="filter-bar">
        <div className="btn-group"><button className="btn secondary sm" onClick={() => setMonth(addDays(first, -1).slice(0, 7))}>‹</button><button className="btn secondary sm" onClick={() => setMonth(today.slice(0, 7))}>Hoje</button><button className="btn secondary sm" onClick={() => setMonth(addDays(last, 1).slice(0, 7))}>›</button></div>
        <span className="bold">{monthName(first).charAt(0).toUpperCase() + monthName(first).slice(1)}</span>
        {loading && <Spinner />}
        <span className="right row gap small muted"><span className="chip" style={{ background: '#e9eef1' }}>Feriado</span><span className="chip" style={{ background: 'var(--primary-light)' }}>Folga aprovada</span><span className="chip" style={{ background: '#fff', border: '1px dashed var(--border-strong)' }}>Folga pendente</span></span>
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', borderTop: '1px solid var(--border)' }}>
        {weekdays.map((w) => <div key={w} className="small muted center" style={{ padding: '6px 4px', borderBottom: '1px solid var(--border)', background: '#fafcfd' }}>{w}</div>)}
        {days.map((d) => {
          const inMonth = d.slice(0, 7) === month; const items = byDay.get(d) || [];
          return (
            <div key={d} style={{ minHeight: 92, padding: 4, borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)', background: d === today ? '#f7fcff' : inMonth ? '#fff' : '#fafafa', opacity: inMonth ? 1 : .55 }}>
              <div className="small" style={{ fontWeight: d === today ? 700 : 400, color: d === today ? 'var(--primary)' : 'var(--text-muted)', marginBottom: 2 }}>{Number(d.slice(8))}</div>
              {items.slice(0, 4).map((it) => (
                <div key={it.key} title={it.title || it.label} className="truncate" style={{ fontSize: 11, lineHeight: '16px', padding: '0 5px', borderRadius: 3, marginBottom: 2, background: it.kind === 'holiday' ? it.color : it.pending ? '#fff' : `${it.color}22`, color: it.kind === 'holiday' ? '#fff' : it.color, border: it.pending ? `1px dashed ${it.color}` : '1px solid transparent', fontWeight: it.mine ? 600 : 400 }}>
                  {it.kind === 'holiday' ? '📅 ' : it.icon && POLICY_ICONS[it.icon] ? `${POLICY_ICONS[it.icon]} ` : ''}{it.label}
                </div>
              ))}
              {items.length > 4 && <div className="small light">+{items.length - 4}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
