import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { api } from '../api.js';
import { Spinner, Alert, Empty, Modal, Confirm, Tabs } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { errorMessage } from '../lib/format.js';

// Administração › Contas de usuário: approval of accounts created through the public sign-up page.
const STATUS = {
  PENDING_APPROVAL: ['Aguardando aprovação', 'warning'], REJECTED: ['Recusada', 'danger'], ACTIVE: ['Ativa', 'success'],
  PENDING_EMAIL_VERIFICATION: ['Convite pendente', ''], NOT_REGISTERED: ['Sem acesso (quiosque)', ''], DELETED: ['Excluída', ''],
};
const fmtDate = (v) => (v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export default function Accounts() {
  const { isSystemAdmin, user, toast } = useStore();
  const [status, setStatus] = useState('PENDING_APPROVAL');
  const [q, setQ] = useState('');
  const [approve, setApprove] = useState(null);
  const [reject, setReject] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const { data: summary, reload: reloadSummary } = useAsync(() => (isSystemAdmin ? api.get('/admin/accounts/summary') : Promise.resolve(null)), [isSystemAdmin]);
  const { data, loading, error, reload } = useAsync(() => (isSystemAdmin ? api.get('/admin/accounts', { status, q: q.trim() || undefined, 'page-size': 200 }) : Promise.resolve(null)), [isSystemAdmin, status, q]);

  if (!isSystemAdmin) return <div className="card"><Empty icon="🛡" title="Somente administradores do sistema">A aprovação de novas contas é feita pelos administradores do sistema.</Empty></div>;
  const refresh = () => { reload().catch(() => {}); reloadSummary().catch(() => {}); window.dispatchEvent(new Event('clockfy:accounts-changed')); };
  const act = async (fn, okMessage) => {
    try { await fn(); toast(okMessage, 'success'); refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const list = data?.accounts || [];
  const tabs = [
    { value: 'PENDING_APPROVAL', label: `Aguardando aprovação${summary ? ` (${summary.pending})` : ''}` },
    { value: 'REJECTED', label: `Recusadas${summary ? ` (${summary.rejected})` : ''}` },
    { value: 'ACTIVE', label: 'Ativas' },
    { value: 'ALL', label: 'Todas' },
  ];

  return (
    <div>
      <div className="page-header"><h1>Contas de usuário</h1></div>
      <Alert type="info">
        Contas criadas pela página <b>Criar conta</b> só conseguem entrar depois de aprovadas aqui. Antes de aprovar, confirme que a pessoa é quem diz ser:
        o cadastro não comprova a posse do e-mail. Pessoas convidadas por um administrador ou importadas do Clockify não passam por esta fila.
        {summary && !summary.registrationApproval && <div className="mt"><b>Atenção:</b> a aprovação está desligada neste servidor (<code>REGISTRATION_APPROVAL=false</code>): novos cadastros entram direto.</div>}
      </Alert>
      <div className="card">
        <div className="card-head row gap wrap">
          <Tabs tabs={tabs} value={status} onChange={setStatus} />
          <input type="search" className="right" placeholder="Buscar por nome ou e-mail…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        </div>
        {error && <Alert type="error">{errorMessage(error)}</Alert>}
        {loading && !data ? <Spinner block /> : list.length === 0 ? (
          <Empty icon="✓" title={status === 'PENDING_APPROVAL' ? 'Nenhum cadastro aguardando aprovação' : 'Nenhuma conta encontrada'}>{status === 'PENDING_APPROVAL' ? 'Quando alguém criar uma conta, ela aparece aqui e os administradores recebem um aviso.' : null}</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Pessoa</th><th>Cadastro</th><th>Workspace pedido</th><th>Status</th><th /></tr></thead>
            <tbody>{list.map((a) => {
              const [label, cls] = STATUS[a.status] || [a.status, ''];
              return (
                <tr key={a.id}>
                  <td><div className="bold">{a.name}{a.systemAdmin && <span className="badge primary ml">Admin do sistema</span>}{a.id === user?.id && <span className="muted"> (você)</span>}</div><div className="small muted">{a.email}</div></td>
                  <td className="small">{fmtDate(a.createdAt)}{a.signup?.ip && <div className="muted">IP {a.signup.ip}</div>}</td>
                  <td className="small">{a.requestedWorkspaceName || <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${cls}`}>{label}</span>
                    {a.status === 'REJECTED' && <div className="small muted mt">{fmtDate(a.rejectedAt)}{a.rejectedBy?.name ? ` por ${a.rejectedBy.name}` : ''}{a.rejectionReason ? ` – ${a.rejectionReason}` : ''}</div>}
                    {a.status === 'ACTIVE' && a.approvedAt && <div className="small muted mt">aprovada {fmtDate(a.approvedAt)}{a.approvedBy?.name ? ` por ${a.approvedBy.name}` : ''}</div>}
                  </td>
                  <td className="actions">
                    <div className="row gap" style={{ justifyContent: 'flex-end' }}>
                      {['PENDING_APPROVAL', 'REJECTED'].includes(a.status) && <button className="btn sm" onClick={() => setApprove(a)}>Aprovar</button>}
                      {a.status === 'PENDING_APPROVAL' && <button className="btn secondary sm" onClick={() => setReject(a)}>Recusar</button>}
                      {['PENDING_APPROVAL', 'REJECTED'].includes(a.status) && (
                        <button className="btn ghost sm" onClick={() => setConfirm({ title: 'Excluir cadastro', danger: true, confirmLabel: 'Excluir', message: `Excluir o cadastro de ${a.name} <${a.email}>? O e-mail fica livre para um novo cadastro.`, onConfirm: () => act(() => api.delete(`/admin/accounts/${a.id}`), 'Cadastro excluído') })}>Excluir</button>
                      )}
                      {a.status === 'ACTIVE' && (a.systemAdmin
                        ? <button className="btn ghost sm" onClick={() => setConfirm({ title: 'Remover administrador do sistema', confirmLabel: 'Remover', message: `${a.name} deixará de aprovar novas contas.`, onConfirm: () => act(() => api.put(`/admin/accounts/${a.id}/system-admin`, { systemAdmin: false }), 'Papel removido') })}>Remover admin</button>
                        : <button className="btn ghost sm" onClick={() => setConfirm({ title: 'Tornar administrador do sistema', confirmLabel: 'Tornar administrador', message: `${a.name} poderá aprovar, recusar e excluir cadastros e gerenciar os administradores do sistema.`, onConfirm: () => act(() => api.put(`/admin/accounts/${a.id}/system-admin`, { systemAdmin: true }), 'Agora é administrador do sistema') })}>Tornar admin</button>)}
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {approve && <ApproveModal account={approve} onClose={() => setApprove(null)} onDone={(msg) => { setApprove(null); toast(msg, 'success'); refresh(); }} />}
      {reject && <RejectModal account={reject} onClose={() => setReject(null)} onDone={() => { setReject(null); toast('Cadastro recusado', 'success'); refresh(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function ApproveModal({ account, onClose, onDone }) {
  const { workspace } = useStore();
  const { data: workspaces } = useAsync(() => api.get('/admin/workspaces'), []);
  const alreadyMember = (account.workspaces || 0) > 0; // e.g. invited to a workspace while waiting
  const [mode, setMode] = useState(alreadyMember ? 'keep' : 'own');
  const [name, setName] = useState(account.requestedWorkspaceName || `Workspace de ${account.name}`);
  const [workspaceId, setWorkspaceId] = useState(workspace?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit() {
    setBusy(true); setError(null);
    try {
      const body = mode === 'existing' ? { workspaceId } : mode === 'own' ? { workspaceName: name.trim() || undefined } : {};
      const r = await api.post(`/admin/accounts/${account.id}/approve`, body);
      onDone(r.workspace ? `Conta aprovada – workspace ${r.workspace.name}` : 'Conta aprovada');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Aprovar conta" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancelar</button>
      <button className="btn" disabled={busy || (mode === 'existing' && !workspaceId)} onClick={submit}>{busy ? 'Aprovando…' : 'Aprovar'}</button>
    </>}>
      <Alert type="error">{error}</Alert>
      <p><b>{account.name}</b> &lt;{account.email}&gt; poderá entrar com a senha que cadastrou e receberá um e-mail avisando.</p>
      <div className="field"><label>Onde a pessoa vai trabalhar</label>
        {alreadyMember && <label className="checkbox"><input type="radio" checked={mode === 'keep'} onChange={() => setMode('keep')} /> Manter nos workspaces em que já foi incluída</label>}
        <label className="checkbox mt"><input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Adicionar a um workspace existente</label>
        {mode === 'existing' && (
          <select className="mt" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">Escolha…</option>
            {(workspaces || []).map((w) => <option key={w.id} value={w.id}>{w.name}{w.ownerName ? ` – dono: ${w.ownerName}` : ''} ({w.members} membro(s))</option>)}
          </select>
        )}
        <label className="checkbox mt"><input type="radio" checked={mode === 'own'} onChange={() => setMode('own')} /> Criar um workspace próprio</label>
        {mode === 'own' && <input className="mt" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do workspace" />}
      </div>
    </Modal>
  );
}

function RejectModal({ account, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit() {
    setBusy(true); setError(null);
    try { await api.post(`/admin/accounts/${account.id}/reject`, { reason: reason.trim() || undefined, notify }); onDone(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Recusar cadastro" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancelar</button>
      <button className="btn danger" disabled={busy} onClick={submit}>{busy ? 'Recusando…' : 'Recusar'}</button>
    </>}>
      <Alert type="error">{error}</Alert>
      <p><b>{account.name}</b> &lt;{account.email}&gt; não conseguirá entrar. O cadastro fica na aba “Recusadas” (pode ser aprovado depois ou excluído).</p>
      <div className="field"><label>Motivo (opcional)</label><textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: não faz parte da empresa" /></div>
      <label className="checkbox"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Avisar a pessoa por e-mail</label>
      <div className="small muted mt">Deixe desmarcado em cadastros suspeitos: o e-mail informado pode não ser de quem se cadastrou.</div>
    </Modal>
  );
}
