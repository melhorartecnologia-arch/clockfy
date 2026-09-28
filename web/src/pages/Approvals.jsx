import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, ws } from '../api.js';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, Tabs, Avatar, Money, ProjectLabel } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { fmtDuration, isoToSeconds, toLocalDateStr, toLocalTimeStr, localToIso, addDays, startOfWeekStr, fmtDate, pad, errorMessage } from '../lib/format.js';

// Period helpers (YYYY-MM-DD, in the user's time zone) --------------------------------------------
const PERIOD_LABEL = { WEEKLY: 'Semanal', SEMI_MONTHLY: 'Quinzenal', MONTHLY: 'Mensal' };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-based
const firstOf = (y, m) => { const d = new Date(Date.UTC(y, m - 1, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`; };

export function periodOf(kind, dateStr, weekStart) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (kind === 'MONTHLY') return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(lastDay(y, m))}`];
  if (kind === 'SEMI_MONTHLY') return d <= 15 ? [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-15`] : [`${y}-${pad(m)}-16`, `${y}-${pad(m)}-${pad(lastDay(y, m))}`];
  const s = startOfWeekStr(dateStr, weekStart);
  return [s, addDays(s, 6)];
}

export function shiftPeriod(kind, start, dir) {
  const [y, m, d] = start.split('-').map(Number);
  if (kind === 'WEEKLY') return addDays(start, 7 * dir);
  if (kind === 'MONTHLY') return firstOf(y, m + dir);
  if (dir > 0) return d === 1 ? `${y}-${pad(m)}-16` : firstOf(y, m + 1);
  if (d === 16) return `${y}-${pad(m)}-01`;
  const prev = firstOf(y, m - 1); const [py, pm] = prev.split('-').map(Number);
  return `${py}-${pad(pm)}-16`;
}

const STATE_LABEL = {
  PENDING: ['Pendente', 'warning'], APPROVED: ['Aprovada', 'success'], REJECTED: ['Rejeitada', 'danger'],
  WITHDRAWN_SUBMISSION: ['Envio retirado', ''], WITHDRAWN_APPROVAL: ['Aprovação retirada', ''],
};
const SUMMARY_LABEL = { PENDING: ['Pendente', 'warning'], UNSUBMITTED: ['Não enviada', 'danger'], REJECTED: ['Rejeitada', 'danger'], APPROVED: ['Aprovada', 'success'], NONE: ['Sem horas', ''] };
const TABS = [{ value: 'pending', label: 'Pendentes' }, { value: 'approved', label: 'Aprovadas' }, { value: 'rejected', label: 'Rejeitadas / Retiradas' }, { value: 'unsubmitted', label: 'Não enviadas' }];
const TAB_STATES = { pending: ['PENDING'], approved: ['APPROVED'], rejected: ['REJECTED', 'WITHDRAWN_SUBMISSION', 'WITHDRAWN_APPROVAL'] };

function StateBadge({ state }) { const [label, cls] = STATE_LABEL[state] || [state, '']; return <span className={`badge ${cls}`}>{label}</span>; }
const dur = (iso) => fmtDuration(isoToSeconds(iso), { seconds: false });
const rangeText = (r, tz, df) => `${fmtDate(toLocalDateStr(r.dateRange.start, tz), df)} – ${fmtDate(toLocalDateStr(r.dateRange.end, tz), df)}`;
const whenText = (iso, tz, df) => (iso ? `${fmtDate(toLocalDateStr(iso, tz), df)} ${toLocalTimeStr(iso, tz)}` : '');

function useMyRoles(wsId, userId) {
  const { data, loading } = useAsync(() => api.get(`${ws(wsId)}/users/${userId}/roles`), [wsId, userId], { initial: null });
  return { roles: (data || []).map((r) => r.role?.name).filter(Boolean), loading: loading || data == null };
}

// Page --------------------------------------------------------------------------------------------
export default function Approvals() {
  const { workspace, user, settings, isAdmin, timeZone, weekStart } = useStore();
  const wsId = workspace?.id;
  const { roles, loading: rolesLoading } = useMyRoles(wsId, user.id);
  const isTeamManager = roles.includes('TEAM_MANAGER');
  const isManager = isAdmin || isTeamManager;
  const [kind, setKind] = useState(settings.approvalPeriod || 'WEEKLY');
  const [anchor, setAnchor] = useState(() => toLocalDateStr(new Date(), timeZone));
  const [pStart, pEnd] = useMemo(() => periodOf(kind, anchor, weekStart), [kind, anchor, weekStart]);
  const period = useMemo(() => ({ kind, start: pStart, end: pEnd, startIso: localToIso(pStart, '00:00', timeZone), endIso: localToIso(addDays(pEnd, 1), '00:00', timeZone) }), [kind, pStart, pEnd, timeZone]);

  if (rolesLoading && !isAdmin) return <Spinner block />;
  const nav = (
    <>
      <div className="btn-group">
        <button className="btn secondary sm" onClick={() => setAnchor(shiftPeriod(kind, pStart, -1))} title="Período anterior">‹</button>
        <button className="btn secondary sm" onClick={() => setAnchor(toLocalDateStr(new Date(), timeZone))}>Atual</button>
        <button className="btn secondary sm" onClick={() => setAnchor(shiftPeriod(kind, pStart, 1))} title="Próximo período">›</button>
      </div>
      <input type="date" value={pStart} onChange={(e) => e.target.value && setAnchor(e.target.value)} style={{ width: 150 }} />
      <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>{Object.entries(PERIOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    </>
  );
  return isManager
    ? <ManagerView period={period} nav={nav} isTeamManager={isTeamManager} />
    : <MemberView period={period} nav={nav} />;
}

// Manager / admin view ---------------------------------------------------------------------------
function ManagerView({ period, nav, isTeamManager }) {
  const { '*': sub } = useParams();
  const navigate = useNavigate();
  const { dateFormat } = useStore();
  const tab = TABS.some((t) => t.value === sub) ? sub : 'pending';
  return (
    <div>
      <div className="page-header">
        <h1>Aprovações</h1>
        {nav}
        <span className="muted">{fmtDate(period.start, dateFormat)} – {fmtDate(period.end, dateFormat)}</span>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={(t) => navigate(`/approvals/${t}`)} />
      {tab === 'unsubmitted' ? <UnsubmittedTab period={period} /> : <RequestsTab key={tab} states={TAB_STATES[tab]} period={period} isTeamManager={isTeamManager} />}
    </div>
  );
}

function RequestsTab({ states, period, isTeamManager }) {
  const { workspace, user, isAdmin, timeZone, dateFormat, toast } = useStore();
  const wsId = workspace.id;
  const [allPeriods, setAllPeriods] = useState(false);
  const [detail, setDetail] = useState(null);
  const [action, setAction] = useState(null);
  const { data, loading, error, reload } = useAsync(
    () => api.get(`${ws(wsId)}/approval-requests`, { status: states, start: allPeriods ? undefined : period.startIso, end: allPeriods ? undefined : period.endIso, 'page-size': 500, 'sort-column': 'UPDATED_AT', 'sort-order': 'DESCENDING' }),
    [wsId, states.join(), allPeriods, period.startIso, period.endIso], { initial: [] },
  );
  const list = data || [];
  const canApprove = (r) => isAdmin || (isTeamManager && r.owner.userId !== user.id);
  const totals = useMemo(() => list.reduce((acc, d) => ({ tracked: acc.tracked + isoToSeconds(d.trackedTime), billable: acc.billable + isoToSeconds(d.billableTime), amount: acc.amount + (d.billableAmount || 0), cost: acc.cost + (d.costAmount || 0), expenses: acc.expenses + (d.expenseTotal || 0) }), { tracked: 0, billable: 0, amount: 0, cost: 0, expenses: 0 }), [list]);

  async function changeState(r, state, note) {
    try {
      await api.patch(`${ws(wsId)}/approval-requests/${r.id}`, { state, note: note || null });
      toast({ APPROVED: 'Planilha aprovada', REJECTED: 'Planilha rejeitada', WITHDRAWN_APPROVAL: 'Aprovação retirada', WITHDRAWN_SUBMISSION: 'Envio retirado', PENDING: 'Planilha reenviada para aprovação' }[state] || 'Atualizado', 'success');
      setDetail(null); reload();
    } catch (e) { toast(errorMessage(e), 'error'); throw e; }
  }
  const ask = (r, state) => setAction({ request: r, state });

  return (
    <div className="card">
      <div className="filter-bar">
        <label className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" style={{ minWidth: 0 }} checked={allPeriods} onChange={(e) => setAllPeriods(e.target.checked)} /> Todos os períodos</label>
        <span className="muted small">{list.length} planilha(s)</span>
        <button className="btn ghost sm right" onClick={reload} title="Atualizar">↻</button>
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      {loading && !list.length ? <Spinner block /> : list.length === 0 ? <Empty icon="✓" title="Nenhuma planilha">{allPeriods ? 'Nenhuma planilha com este status.' : 'Nenhuma planilha com este status no período selecionado.'}</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Membro</th><th>Período</th><th className="num">Rastreado</th><th className="num">Faturável</th><th className="num">Pausas</th>
                {isAdmin && <th className="num">Valor faturável</th>}{isAdmin && <th className="num">Custo</th>}<th className="num">Despesas</th><th>Status</th><th>Decisão</th><th />
              </tr>
            </thead>
            <tbody>
              {list.map((d) => {
                const r = d.approvalRequest; const st = r.status;
                return (
                  <tr key={r.id}>
                    <td><span className="row gap"><Avatar user={{ name: r.owner.userName }} size={26} /><span className="truncate" style={{ maxWidth: 200 }}>{r.owner.userName}</span></span></td>
                    <td className="nowrap"><button className="btn link" onClick={() => setDetail(d)}>{rangeText(r, timeZone, dateFormat)}</button><div className="light small">{PERIOD_LABEL[r.period] || r.period}</div></td>
                    <td className="num mono">{dur(d.trackedTime)}</td>
                    <td className="num mono">{dur(d.billableTime)}</td>
                    <td className="num mono">{dur(d.breakTime)}</td>
                    {isAdmin && <td className="num"><Money cents={d.billableAmount} /></td>}
                    {isAdmin && <td className="num"><Money cents={d.costAmount} /></td>}
                    <td className="num">{d.expenses.length ? <Money cents={Math.round(d.expenseTotal * 100)} /> : <span className="light">–</span>}</td>
                    <td><StateBadge state={st.state} />{st.note && <div className="small muted truncate" style={{ maxWidth: 180 }} title={st.note}>“{st.note}”</div>}</td>
                    <td className="small muted nowrap">{st.updatedByUserName && st.state !== 'PENDING' ? <>{st.updatedByUserName}<br />{whenText(st.updatedAt, timeZone, dateFormat)}</> : <span className="light">Enviada em {whenText(r.createdAt, timeZone, dateFormat)}</span>}</td>
                    <td className="actions">
                      {st.state === 'PENDING' && canApprove(d.approvalRequest) && <button className="btn success sm" onClick={() => ask(r, 'APPROVED')}>Aprovar</button>}
                      <Dropdown>
                        <button onClick={() => setDetail(d)}>Ver detalhes</button>
                        {st.state === 'PENDING' && canApprove(r) && <button onClick={() => ask(r, 'APPROVED')}>Aprovar</button>}
                        {st.state === 'PENDING' && canApprove(r) && <button className="danger" onClick={() => ask(r, 'REJECTED')}>Rejeitar…</button>}
                        {st.state === 'PENDING' && r.owner.userId === user.id && <button onClick={() => ask(r, 'WITHDRAWN_SUBMISSION')}>Retirar envio</button>}
                        {st.state === 'APPROVED' && canApprove(r) && <button className="danger" onClick={() => ask(r, 'WITHDRAWN_APPROVAL')}>Retirar aprovação</button>}
                        {['REJECTED', 'WITHDRAWN_SUBMISSION', 'WITHDRAWN_APPROVAL'].includes(st.state) && <button onClick={() => ask(r, 'PENDING')}>Reenviar para aprovação</button>}
                      </Dropdown>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="bold" colSpan={2}>Total</td>
                <td className="num mono bold">{fmtDuration(totals.tracked, { seconds: false })}</td>
                <td className="num mono bold">{fmtDuration(totals.billable, { seconds: false })}</td>
                <td />
                {isAdmin && <td className="num bold"><Money cents={totals.amount} /></td>}
                {isAdmin && <td className="num bold"><Money cents={totals.cost} /></td>}
                <td className="num bold"><Money cents={Math.round(totals.expenses * 100)} /></td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {detail && <RequestDetail details={detail} canApprove={canApprove(detail.approvalRequest)} onAction={(state) => ask(detail.approvalRequest, state)} onClose={() => setDetail(null)} />}
      {action && <StateModal request={action.request} state={action.state} onConfirm={(note) => changeState(action.request, action.state, note)} onClose={() => setAction(null)} />}
    </div>
  );
}

function UnsubmittedTab({ period }) {
  const { workspace, user, timeZone, dateFormat, toast } = useStore();
  const wsId = workspace.id;
  const [onlyPending, setOnlyPending] = useState(true);
  const [confirm, setConfirm] = useState(null);
  const { data, loading, error, reload } = useAsync(() => api.get(`${ws(wsId)}/approval-requests/pending-summary`, { start: period.startIso, end: period.endIso }), [wsId, period.startIso, period.endIso], { initial: [] });
  const list = (data || []).filter((r) => !onlyPending || isoToSeconds(r.unsubmittedTime) > 0);

  function submitFor(r) {
    setConfirm({
      title: 'Enviar para aprovação', confirmLabel: 'Enviar',
      message: `Enviar a planilha de ${r.userName} (${fmtDate(period.start, dateFormat)} – ${fmtDate(period.end, dateFormat)}) para aprovação em nome do membro? Os registros ficarão bloqueados até a revisão.`,
      onConfirm: async () => {
        try {
          // an existing request for the period (approved, rejected or withdrawn) is re-opened with the new items
          const hasPrev = r.requests.some((x) => x.state !== 'PENDING');
          await api.post(`${ws(wsId)}/approval-requests/users/${r.userId}${hasPrev ? '/resubmit-entries-for-approval' : ''}`, { period: period.kind, periodStart: period.startIso });
          toast('Planilha enviada para aprovação', 'success'); reload();
        } catch (e) { toast(errorMessage(e), 'error'); throw e; }
      },
    });
  }
  const remind = (r) => toast(`Lembrete enviado por e-mail para ${r.userName}`, 'success');

  return (
    <div className="card">
      <div className="filter-bar">
        <label className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" style={{ minWidth: 0 }} checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> Somente com horas não enviadas</label>
        <span className="muted small">{list.length} membro(s)</span>
        <button className="btn ghost sm right" onClick={reload} title="Atualizar">↻</button>
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      {loading && !data?.length ? <Spinner block /> : list.length === 0 ? <Empty icon="✓" title="Tudo enviado">Nenhum membro com horas não enviadas neste período.</Empty> : (
        <table className="table">
          <thead><tr><th>Membro</th><th className="num">Rastreado</th><th className="num">Não enviado</th><th className="num">Pendente</th><th className="num">Aprovado</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.map((r) => {
              const [label, cls] = SUMMARY_LABEL[r.status] || [r.status, ''];
              const unsubmitted = isoToSeconds(r.unsubmittedTime) > 0;
              const pending = r.requests.some((x) => x.state === 'PENDING');
              return (
                <tr key={r.userId}>
                  <td><span className="row gap"><Avatar user={{ name: r.userName }} size={26} /><span><div>{r.userName}{r.userId === user.id && <span className="light"> (eu)</span>}</div><div className="small light">{r.userEmail}</div></span></span></td>
                  <td className="num mono">{dur(r.trackedTime)}</td>
                  <td className="num mono" style={unsubmitted ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{dur(r.unsubmittedTime)}</td>
                  <td className="num mono">{dur(r.pendingTime)}</td>
                  <td className="num mono">{dur(r.approvedTime)}</td>
                  <td><span className={`badge ${cls}`}>{label}</span></td>
                  <td className="actions">
                    {unsubmitted && !pending && <button className="btn secondary sm" onClick={() => submitFor(r)}>Enviar em nome de</button>}
                    {unsubmitted && r.userId !== user.id && <button className="btn ghost sm ml" onClick={() => remind(r)} title="Lembrar por e-mail">✉ Lembrar</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
      <div className="small light" style={{ padding: '8px 14px' }}>Período: {fmtDate(period.start, dateFormat)} – {fmtDate(period.end, dateFormat)} · fuso {timeZone}</div>
    </div>
  );
}

// Member view ("Minhas planilhas") -------------------------------------------------------------------
function MemberView({ period, nav }) {
  const { workspace, user, dateFormat, timeZone, toast } = useStore();
  const wsId = workspace.id;
  const [detail, setDetail] = useState(null);
  const [action, setAction] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const summary = useAsync(() => api.get(`${ws(wsId)}/approval-requests/pending-summary`, { start: period.startIso, end: period.endIso }).then((l) => l.find((r) => r.userId === user.id) || null), [wsId, period.startIso, period.endIso], { initial: null });
  const history = useAsync(() => api.get(`${ws(wsId)}/approval-requests`, { 'page-size': 200, 'sort-column': 'START', 'sort-order': 'DESCENDING' }), [wsId], { initial: [] });
  const me = summary.data;
  const current = me?.requests?.find((r) => ['PENDING', 'APPROVED'].includes(r.state)) || me?.requests?.[0] || null;
  const unsubmitted = isoToSeconds(me?.unsubmittedTime) > 0;
  const reloadAll = () => { summary.reload().catch(() => {}); history.reload().catch(() => {}); };

  async function submit() {
    try {
      const hasPrev = me?.requests?.some((x) => x.state !== 'PENDING');
      await api.post(`${ws(wsId)}/approval-requests${hasPrev ? '/resubmit-entries-for-approval' : ''}`, { period: period.kind, periodStart: period.startIso });
      toast('Planilha enviada para aprovação', 'success'); reloadAll();
    } catch (e) { toast(errorMessage(e), 'error'); throw e; }
  }
  async function changeState(r, state, note) {
    try {
      await api.patch(`${ws(wsId)}/approval-requests/${r.id}`, { state, note: note || null });
      toast(state === 'WITHDRAWN_SUBMISSION' ? 'Envio retirado' : 'Planilha reenviada para aprovação', 'success');
      setDetail(null); reloadAll();
    } catch (e) { toast(errorMessage(e), 'error'); throw e; }
  }
  const [label, cls] = SUMMARY_LABEL[me?.status || 'NONE'] || ['', ''];
  const list = history.data || [];

  return (
    <div>
      <div className="page-header"><h1>Minhas planilhas</h1>{nav}<span className="muted">{fmtDate(period.start, dateFormat)} – {fmtDate(period.end, dateFormat)}</span></div>
      <div className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>Período atual</h3><span className={`badge ${cls} ml`}>{label}</span>
          <div className="right row gap wrap">
            {current?.state === 'PENDING' && <button className="btn secondary" onClick={() => setConfirm({ title: 'Retirar envio', confirmLabel: 'Retirar', message: 'Retirar o envio desta planilha? Os registros voltarão a ficar editáveis.', onConfirm: () => changeState(current, 'WITHDRAWN_SUBMISSION') })}>Retirar envio</button>}
            {unsubmitted && current?.state !== 'PENDING' && <button className="btn" onClick={() => setConfirm({ title: 'Enviar para aprovação', confirmLabel: 'Enviar', message: `Enviar a planilha de ${fmtDate(period.start, dateFormat)} a ${fmtDate(period.end, dateFormat)} para aprovação? Os registros ficarão bloqueados até a revisão.`, onConfirm: submit })}>Enviar para aprovação</button>}
          </div>
        </div>
        {summary.error && <Alert type="error">{errorMessage(summary.error)}</Alert>}
        {summary.loading && !me ? <Spinner block /> : (
          <div className="grid cols-4" style={{ padding: 16 }}>
            <div className="stat card"><div className="label">Rastreado</div><div className="value mono">{dur(me?.trackedTime)}</div></div>
            <div className="stat card"><div className="label">Não enviado</div><div className="value mono" style={unsubmitted ? { color: 'var(--danger)' } : undefined}>{dur(me?.unsubmittedTime)}</div></div>
            <div className="stat card"><div className="label">Pendente</div><div className="value mono">{dur(me?.pendingTime)}</div></div>
            <div className="stat card"><div className="label">Aprovado</div><div className="value mono" style={{ color: 'var(--success)' }}>{dur(me?.approvedTime)}</div></div>
          </div>
        )}
        {me && !unsubmitted && !me.requests.length && <div className="muted small" style={{ padding: '0 16px 16px' }}>Nenhum registro de tempo neste período. Registre horas no controle de tempo para enviá-las para aprovação.</div>}
        {me?.requests?.some((r) => r.state === 'REJECTED') && unsubmitted && <div style={{ padding: '0 16px 16px' }}><Alert type="warning">Sua planilha foi rejeitada. Corrija os registros e reenvie para aprovação.</Alert></div>}
      </div>

      <div className="card mt">
        <div className="card-head"><h3 style={{ margin: 0 }}>Histórico de envios</h3><span className="muted small ml">{list.length} envio(s)</span><button className="btn ghost sm right" onClick={reloadAll} title="Atualizar">↻</button></div>
        {history.error && <Alert type="error">{errorMessage(history.error)}</Alert>}
        {history.loading && !list.length ? <Spinner block /> : list.length === 0 ? <Empty icon="✓" title="Nenhum envio ainda">Envie seu período atual para aprovação para começar.</Empty> : (
          <table className="table">
            <thead><tr><th>Período</th><th className="num">Rastreado</th><th className="num">Faturável</th><th className="num">Despesas</th><th>Status</th><th>Nota</th><th>Decisão</th><th /></tr></thead>
            <tbody>
              {list.map((d) => {
                const r = d.approvalRequest; const st = r.status;
                return (
                  <tr key={r.id}>
                    <td className="nowrap"><button className="btn link" onClick={() => setDetail(d)}>{rangeText(r, timeZone, dateFormat)}</button><div className="light small">{PERIOD_LABEL[r.period] || r.period}</div></td>
                    <td className="num mono">{dur(d.trackedTime)}</td>
                    <td className="num mono">{dur(d.billableTime)}</td>
                    <td className="num">{d.expenses.length ? <Money cents={Math.round(d.expenseTotal * 100)} /> : <span className="light">–</span>}</td>
                    <td><StateBadge state={st.state} /></td>
                    <td className="small muted" style={{ maxWidth: 220 }}>{st.note || <span className="light">–</span>}</td>
                    <td className="small muted nowrap">{st.state !== 'PENDING' && st.updatedByUserName ? <>{st.updatedByUserName}<br />{whenText(st.updatedAt, timeZone, dateFormat)}</> : <span className="light">Enviada em {whenText(r.createdAt, timeZone, dateFormat)}</span>}</td>
                    <td className="actions">
                      <Dropdown>
                        <button onClick={() => setDetail(d)}>Ver detalhes</button>
                        {st.state === 'PENDING' && <button onClick={() => setAction({ request: r, state: 'WITHDRAWN_SUBMISSION' })}>Retirar envio</button>}
                        {['REJECTED', 'WITHDRAWN_SUBMISSION', 'WITHDRAWN_APPROVAL'].includes(st.state) && <button onClick={() => setAction({ request: r, state: 'PENDING' })}>Reenviar para aprovação</button>}
                      </Dropdown>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {detail && <RequestDetail details={detail} canApprove={false} onAction={(state) => setAction({ request: detail.approvalRequest, state })} onClose={() => setDetail(null)} />}
      {action && <StateModal request={action.request} state={action.state} onConfirm={(note) => changeState(action.request, action.state, note)} onClose={() => setAction(null)} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

// Detail modal ---------------------------------------------------------------------------------------
const ACTION_INFO = {
  APPROVED: { title: 'Aprovar planilha', label: 'Aprovar', cls: 'success', text: 'Os registros de tempo e despesas do período ficarão bloqueados.' },
  REJECTED: { title: 'Rejeitar planilha', label: 'Rejeitar', cls: 'danger', text: 'O membro será notificado e poderá corrigir os registros e reenviar.' },
  WITHDRAWN_APPROVAL: { title: 'Retirar aprovação', label: 'Retirar aprovação', cls: 'danger', text: 'Os registros voltarão a ficar editáveis.' },
  WITHDRAWN_SUBMISSION: { title: 'Retirar envio', label: 'Retirar envio', cls: '', text: 'Os registros voltarão a ficar editáveis.' },
  PENDING: { title: 'Reenviar para aprovação', label: 'Reenviar', cls: '', text: 'Os registros do período (inclusive os novos) serão anexados e bloqueados até a revisão.' },
};

function StateModal({ request, state, onConfirm, onClose }) {
  const { timeZone, dateFormat, user } = useStore();
  const info = ACTION_INFO[state];
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const withNote = ['APPROVED', 'REJECTED'].includes(state);
  return (
    <Modal title={info.title} size="sm" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancelar</button>
      <button className={`btn ${info.cls}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(note); onClose(); } catch { /* toast shown */ } finally { setBusy(false); } }}>{info.label}</button>
    </>}>
      <p>{request.owner.userId === user.id ? 'Sua planilha' : <>Planilha de <b>{request.owner.userName}</b></>} de {rangeText(request, timeZone, dateFormat)}.</p>
      <p className="muted small">{info.text}</p>
      {withNote && <div className="field"><label>Nota {state === 'REJECTED' ? '(motivo)' : '(opcional)'}</label><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={state === 'REJECTED' ? 'Explique o que precisa ser corrigido…' : 'Comentário para o membro…'} autoFocus /></div>}
    </Modal>
  );
}

export function RequestDetail({ details: d, canApprove, onAction, onClose }) {
  const { user, isAdmin, timeZone, dateFormat, timeFormat } = useStore();
  const r = d.approvalRequest; const st = r.status;
  const isOwner = r.owner.userId === user.id;
  const hour12 = timeFormat === 'HOUR12';
  const byDay = useMemo(() => {
    const m = new Map();
    for (const e of d.entries) { const day = toLocalDateStr(e.timeInterval.start, timeZone); if (!m.has(day)) m.set(day, []); m.get(day).push(e); }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [d.entries, timeZone]);
  const footer = (
    <>
      <button className="btn ghost" onClick={onClose}>Fechar</button>
      {st.state === 'PENDING' && isOwner && <button className="btn secondary" onClick={() => onAction('WITHDRAWN_SUBMISSION')}>Retirar envio</button>}
      {st.state === 'PENDING' && canApprove && <button className="btn danger" onClick={() => onAction('REJECTED')}>Rejeitar…</button>}
      {st.state === 'PENDING' && canApprove && <button className="btn success" onClick={() => onAction('APPROVED')}>Aprovar</button>}
      {st.state === 'APPROVED' && canApprove && <button className="btn danger" onClick={() => onAction('WITHDRAWN_APPROVAL')}>Retirar aprovação</button>}
      {['REJECTED', 'WITHDRAWN_SUBMISSION', 'WITHDRAWN_APPROVAL'].includes(st.state) && (isOwner || canApprove) && <button className="btn" onClick={() => onAction('PENDING')}>Reenviar para aprovação</button>}
    </>
  );
  return (
    <Modal title={`Planilha de ${r.owner.userName} · ${rangeText(r, timeZone, dateFormat)}`} size="xl" onClose={onClose} footer={footer}>
      <div className="row gap wrap mb">
        <StateBadge state={st.state} />
        <span className="muted small">{PERIOD_LABEL[r.period] || r.period} · enviada por {r.creator.userName} em {whenText(r.createdAt, timeZone, dateFormat)}</span>
        {st.state !== 'PENDING' && st.updatedByUserName && <span className="muted small">· {st.state === 'APPROVED' ? 'aprovada' : st.state === 'REJECTED' ? 'rejeitada' : 'alterada'} por {st.updatedByUserName} em {whenText(st.updatedAt, timeZone, dateFormat)}</span>}
      </div>
      {st.note && <Alert type={st.state === 'REJECTED' ? 'warning' : 'info'}><b>Nota:</b> {st.note}</Alert>}
      <div className="grid cols-4 mb">
        <div className="stat card"><div className="label">Rastreado</div><div className="value mono">{dur(d.trackedTime)}</div></div>
        <div className="stat card"><div className="label">Faturável</div><div className="value mono">{dur(d.billableTime)}</div></div>
        <div className="stat card"><div className="label">Pausas</div><div className="value mono">{dur(d.breakTime)}</div></div>
        <div className="stat card"><div className="label">{isAdmin ? 'Valor faturável' : 'Aprovado'}</div><div className="value mono">{isAdmin ? <Money cents={d.billableAmount} /> : dur(d.approvedTime)}</div></div>
      </div>
      {isAdmin && <div className="row gap wrap mb small muted"><span>Custo: <b><Money cents={d.costAmount} /></b></span><span>· Pendente: <b className="mono">{dur(d.pendingTime)}</b></span><span>· Aprovado: <b className="mono">{dur(d.approvedTime)}</b></span></div>}

      <h3>Registros de tempo <span className="muted small">({d.entries.length})</span></h3>
      {d.entries.length === 0 ? <div className="muted small mb">Nenhum registro de tempo.</div> : (
        <div style={{ overflowX: 'auto' }} className="mb">
          <table className="table compact">
            <thead><tr><th>Data</th><th>Descrição</th><th>Projeto / tarefa</th><th>Etiquetas</th><th>Horário</th><th className="num">Duração</th><th /></tr></thead>
            <tbody>
              {byDay.map(([day, list]) => list.map((e, i) => {
                const secs = e.timeInterval.end ? Math.round((new Date(e.timeInterval.end) - new Date(e.timeInterval.start)) / 1000) : isoToSeconds(e.timeInterval.duration);
                return (
                  <tr key={e.id}>
                    <td className="nowrap">{i === 0 ? fmtDate(day, dateFormat) : ''}</td>
                    <td>{e.description || <span className="light">(sem descrição)</span>}</td>
                    <td><ProjectLabel project={e.project} task={e.task} /></td>
                    <td>{e.tags?.length ? <span className="tag-list">{e.tags.map((t) => <span key={t.id} className="chip">{t.name}</span>)}</span> : <span className="light">–</span>}</td>
                    <td className="nowrap muted small">{toLocalTimeStr(e.timeInterval.start, timeZone, { hour12 })} – {e.timeInterval.end ? toLocalTimeStr(e.timeInterval.end, timeZone, { hour12 }) : '…'}</td>
                    <td className="num mono">{fmtDuration(secs)}</td>
                    <td className="nowrap">{e.billable && <span title="Faturável" style={{ color: 'var(--primary)' }}>$</span>}{e.type === 'BREAK' && <span className="badge ml">Pausa</span>}{e.type === 'TIME_OFF' && <span className="badge warning ml">Folga</span>}{e.type === 'HOLIDAY' && <span className="badge warning ml">Feriado</span>}</td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Despesas <span className="muted small">({d.expenses.length})</span></h3>
      {d.expenses.length === 0 ? <div className="muted small">Nenhuma despesa.</div> : (
        <table className="table compact">
          <thead><tr><th>Data</th><th>Categoria</th><th>Projeto</th><th>Observações</th><th className="num">Qtd.</th><th className="num">Total</th></tr></thead>
          <tbody>
            {d.expenses.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{fmtDate(e.date, dateFormat)}</td>
                <td>{e.category?.name || <span className="light">–</span>}</td>
                <td><ProjectLabel project={e.project} task={e.task} /></td>
                <td className="small">{e.notes}{e.fileUrl && <> · <a href={e.fileUrl} target="_blank" rel="noreferrer">anexo</a></>}</td>
                <td className="num">{e.quantity}</td>
                <td className="num"><Money cents={Math.round(e.total * 100)} currency={e.currency} />{e.billable && <span title="Faturável" className="ml" style={{ color: 'var(--primary)' }}>$</span>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={5} className="bold">Total</td><td className="num bold"><Money cents={Math.round(d.expenseTotal * 100)} /></td></tr></tfoot>
        </table>
      )}
    </Modal>
  );
}
