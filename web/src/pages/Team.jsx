import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints, request, ws } from '../api.js';
import { MultiPicker, invalidateCache } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, Tabs, Avatar, Money, Switch } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { fmtDuration, isoToSeconds, secondsToIso, parseDuration, errorMessage, WEEKDAYS, WEEKDAY_LABELS } from '../lib/format.js';
import { RateModal, CustomFieldInput } from './ProjectDetail.jsx';

const TABS = [{ value: 'members', label: 'Membros' }, { value: 'groups', label: 'Grupos' }, { value: 'reminders', label: 'Lembretes' }];

export default function Team() {
  const { '*': sub } = useParams();
  const navigate = useNavigate();
  const tab = TABS.some((t) => t.value === sub) ? sub : 'members';
  return (
    <div>
      <div className="page-header"><h1>Equipe</h1></div>
      <Tabs tabs={TABS} value={tab} onChange={(t) => navigate(`/team/${t}`)} />
      {tab === 'members' && <MembersTab />}
      {tab === 'groups' && <GroupsTab />}
      {tab === 'reminders' && <RemindersTab />}
    </div>
  );
}

const STATUS_LABEL = { ACTIVE: ['Ativo', 'success'], INACTIVE: ['Inativo', ''], PENDING: ['Convite pendente', 'warning'], DECLINED: ['Recusado', 'danger'] };

function MembersTab() {
  const { workspace, user, isAdmin, isOwner, settings, toast, refreshWorkspace, currency } = useStore();
  const wsId = workspace?.id;
  const { data: users, loading, error, reload } = useAsync(() => endpoints.users(wsId, { 'include-roles': true, status: 'ALL' }), [wsId], { initial: [] });
  const { data: groups, reload: reloadGroups } = useAsync(() => endpoints.groups(wsId), [wsId], { initial: [] });
  const [status, setStatus] = useState('ALL');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null); // { type, user }
  const [confirm, setConfirm] = useState(null);
  const showRates = isAdmin || !settings.onlyAdminsSeeBillableRates;

  const list = useMemo(() => (users || []).filter((u) => (status === 'ALL' || u.memberStatus === status) && (!q || u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))), [users, status, q]);
  const roleOf = (u) => {
    const roles = u.roles || [];
    if (u.id === workspace.ownerId || roles.some((r) => r.role === 'OWNER')) return ['Proprietário', 'primary'];
    if (roles.some((r) => r.role === 'WORKSPACE_ADMIN')) return ['Administrador', 'primary'];
    if (roles.some((r) => r.role === 'TEAM_MANAGER')) return ['Gerente de equipe', 'success'];
    if (roles.some((r) => r.role === 'PROJECT_MANAGER')) return ['Gerente de projeto', 'success'];
    return ['Membro', ''];
  };
  const isWsAdmin = (u) => (u.roles || []).some((r) => r.role === 'WORKSPACE_ADMIN');
  const groupsOf = (uid) => (groups || []).filter((g) => (g.userIds || []).includes(uid));

  async function run(fn, msg) {
    try { await fn(); invalidateCache(wsId); if (msg) toast(msg, 'success'); reload(); reloadGroups(); refreshWorkspace().catch(() => {}); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  const setMemberStatus = (u, s) => run(() => api.put(`${ws(wsId)}/users/${u.id}`, { status: s }), s === 'ACTIVE' ? 'Membro ativado' : 'Membro desativado');
  const toggleAdmin = (u, on) => run(() => (on ? api.post(`${ws(wsId)}/users/${u.id}/roles`, { role: 'WORKSPACE_ADMIN' }) : request('DELETE', `${ws(wsId)}/users/${u.id}/roles`, { role: 'WORKSPACE_ADMIN' })), on ? 'Agora é administrador' : 'Permissão de administrador removida');
  const resend = (u) => run(() => api.post(`${ws(wsId)}/users/${u.id}/resend-invite`).then((r) => { if (r.inviteLink) setModal({ type: 'invited', results: [{ email: u.email, inviteLink: r.inviteLink }] }); }), 'Convite reenviado');
  const remove = (u) => setConfirm({ title: 'Remover membro', danger: true, confirmLabel: 'Remover', message: `Remover ${u.name} do workspace? Os registros de tempo serão mantidos.`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/users/${u.id}`), 'Membro removido') });
  const transfer = (u) => setConfirm({ title: 'Transferir propriedade', danger: true, confirmLabel: 'Transferir', message: `Transferir a propriedade do workspace para ${u.name}? Você continuará como administrador, mas não poderá desfazer esta ação.`, onConfirm: () => run(() => api.put(`${ws(wsId)}/transfer-ownership`, { userId: u.id }), 'Propriedade transferida') });

  return (
    <div className="card">
      <div className="filter-bar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="ALL">Todos</option><option value="ACTIVE">Ativos</option><option value="INACTIVE">Inativos</option><option value="PENDING">Convites pendentes</option></select>
        <input type="search" placeholder="Buscar por nome ou e-mail…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
        <span className="muted small">{list.length} membro(s)</span>
        {isAdmin && <button className="btn right" onClick={() => setModal({ type: 'invite' })}>+ Convidar membros</button>}
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      {loading && !users?.length ? <Spinner block /> : list.length === 0 ? <Empty icon="👥" title="Nenhum membro encontrado">Convide pessoas por e-mail para colaborar neste workspace.</Empty> : (
        <table className="table">
          <thead><tr><th>Membro</th><th>Papel</th><th>Status</th>{showRates && <th className="num">Taxa horária</th>}{isAdmin && <th className="num">Custo/hora</th>}<th>Grupos</th><th /></tr></thead>
          <tbody>
            {list.map((u) => {
              const [role, cls] = roleOf(u); const [st, stCls] = STATUS_LABEL[u.memberStatus] || [u.memberStatus, ''];
              const owner = u.id === workspace.ownerId; const me = u.id === user.id;
              const rateVisible = showRates || me;
              return (
                <tr key={u.id} style={u.memberStatus === 'INACTIVE' ? { opacity: .65 } : undefined}>
                  <td><span className="row gap"><Avatar user={u} size={32} /><span><div className="bold">{u.name}{me && <span className="light"> (eu)</span>}</div><div className="small muted">{u.email}</div></span></span></td>
                  <td><span className={`badge ${cls}`}>{role}</span></td>
                  <td><span className={`badge ${stCls}`}>{st}</span></td>
                  {showRates && <td className="num">{rateVisible && u.hourlyRate ? <Money cents={u.hourlyRate.amount} currency={u.hourlyRate.currency} /> : <span className="light">Padrão</span>}{isAdmin && <button className="btn ghost sm ml" title="Editar taxa" onClick={() => setModal({ type: 'rate', kind: 'hourly', user: u })}>✎</button>}</td>}
                  {isAdmin && <td className="num">{u.costRate ? <Money cents={u.costRate.amount} currency={u.costRate.currency} /> : <span className="light">Padrão</span>}<button className="btn ghost sm ml" title="Editar custo" onClick={() => setModal({ type: 'rate', kind: 'cost', user: u })}>✎</button></td>}
                  <td><span className="row gap wrap">{groupsOf(u.id).map((g) => <span key={g.id} className="chip">{g.name}</span>)}{groupsOf(u.id).length === 0 && <span className="light">—</span>}</span></td>
                  <td className="actions">
                    {(isAdmin || me) && (
                      <Dropdown>
                        <button onClick={() => setModal({ type: 'profile', user: u })}>Perfil do membro</button>
                        {isAdmin && !owner && <button onClick={() => toggleAdmin(u, !isWsAdmin(u))}>{isWsAdmin(u) ? 'Remover administrador' : 'Tornar administrador'}</button>}
                        {isAdmin && <button onClick={() => setModal({ type: 'manager', user: u })}>Gerente de equipe…</button>}
                        {isAdmin && <button onClick={() => setModal({ type: 'pin', user: u })}>PIN de quiosque</button>}
                        {isAdmin && u.memberStatus === 'PENDING' && <button onClick={() => resend(u)}>Reenviar convite</button>}
                        {isOwner && !owner && u.memberStatus === 'ACTIVE' && <button onClick={() => transfer(u)}>Transferir propriedade</button>}
                        {isAdmin && !owner && <hr />}
                        {isAdmin && !owner && (u.memberStatus === 'INACTIVE' ? <button onClick={() => setMemberStatus(u, 'ACTIVE')}>Ativar</button> : u.memberStatus === 'ACTIVE' && <button onClick={() => setMemberStatus(u, 'INACTIVE')}>Desativar</button>)}
                        {isAdmin && !owner && <button className="danger" onClick={() => remove(u)}>Remover do workspace</button>}
                      </Dropdown>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {modal?.type === 'invite' && <InviteModal onClose={() => setModal(null)} onInvited={(results) => { reload(); refreshWorkspace().catch(() => {}); setModal(results.some((r) => r.inviteLink) ? { type: 'invited', results } : null); }} />}
      {modal?.type === 'invited' && <InvitedModal results={modal.results} onClose={() => setModal(null)} />}
      {modal?.type === 'rate' && <RateModal title={`${modal.kind === 'hourly' ? 'Taxa horária' : 'Custo por hora'} – ${modal.user.name}`} value={(modal.kind === 'hourly' ? modal.user.hourlyRate : modal.user.costRate)?.amount} currency={currency} onClose={() => setModal(null)}
        onSave={(amount, since) => run(() => api.put(`${ws(wsId)}/users/${modal.user.id}/${modal.kind === 'hourly' ? 'hourly-rate' : 'cost-rate'}`, { amount, since }).then(() => setModal(null)), 'Taxa atualizada')} />}
      {modal?.type === 'profile' && <ProfileModal member={modal.user} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {modal?.type === 'manager' && <ManagerModal member={modal.user} users={users || []} groups={groups || []} onClose={() => setModal(null)} onChanged={reload} />}
      {modal?.type === 'pin' && <KioskPinModal member={modal.user} onClose={() => setModal(null)} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function InviteModal({ onClose, onInvited }) {
  const { workspace, toast } = useStore();
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function invite() {
    const emails = text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) { setError('Informe pelo menos um e-mail'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.post(`${ws(workspace.id)}/users`, { emails });
      toast(`${emails.length} convite(s) enviado(s)`, 'success');
      onInvited(r.invited || []);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Convidar membros" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={invite}>Convidar</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>E-mails (um por linha ou separados por vírgula)</label><textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={'ana@empresa.com\njoao@empresa.com'} style={{ minHeight: 110 }} /></div>
      <p className="small muted">Quem já tem conta é adicionado imediatamente. Novos usuários recebem um link de convite por e-mail (se o SMTP estiver configurado) – o link também será exibido aqui para você copiar.</p>
    </Modal>
  );
}

function InvitedModal({ results, onClose }) {
  const { toast } = useStore();
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Link copiado', 'success')).catch(() => toast('Não foi possível copiar', 'error'));
  return (
    <Modal title="Links de convite" onClose={onClose} footer={<button className="btn" onClick={onClose}>Fechar</button>}>
      <p className="small muted">Envie estes links para as pessoas convidadas. Cada link é válido por 30 dias.</p>
      {results.map((r) => (
        <div key={r.email} className="field">
          <label>{r.email}</label>
          {r.inviteLink ? <div className="row gap"><input readOnly value={r.inviteLink} onFocus={(e) => e.target.select()} /><button className="btn secondary sm" onClick={() => copy(r.inviteLink)}>Copiar</button></div> : <div className="small muted">Usuário já possuía conta – adicionado diretamente ao workspace.</div>}
        </div>
      ))}
    </Modal>
  );
}

function ProfileModal({ member, onClose, onSaved }) {
  const { workspace, isAdmin, user, toast } = useStore();
  const wsId = workspace?.id;
  const { data: profile, loading, error } = useAsync(() => api.get(`${ws(wsId)}/member-profile/${member.id}`), [wsId, member.id]);
  const { data: fields } = useAsync(() => endpoints.customFields(wsId, { 'entity-type': 'USER' }), [wsId], { initial: [] });
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { if (profile) setF({ name: profile.name, weekStart: profile.weekStart || 'MONDAY', workingDays: profile.workingDays || [], workCapacity: fmtDuration(isoToSeconds(profile.workCapacity || 'PT8H'), { seconds: false }), cf: Object.fromEntries((profile.userCustomFieldValues || []).map((v) => [v.customFieldId, v.value])) }); }, [profile]);
  const canEdit = isAdmin || member.id === user.id;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    const cap = parseDuration(f.workCapacity);
    if (cap == null) { setErr('Capacidade inválida (ex.: 8h)'); return; }
    setBusy(true); setErr(null);
    try {
      await api.patch(`${ws(wsId)}/member-profile/${member.id}`, { name: f.name.trim() || undefined, weekStart: f.weekStart, workingDays: f.workingDays, workCapacity: secondsToIso(cap), userCustomFields: Object.entries(f.cf).map(([customFieldId, value]) => ({ customFieldId, value })) });
      toast('Perfil salvo', 'success'); onSaved();
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Perfil – ${member.name}`} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Fechar</button>{canEdit && <button className="btn" disabled={busy || !f} onClick={save}>Salvar</button>}</>}>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      <Alert type="error">{err}</Alert>
      {loading || !f ? <Spinner block /> : (
        <>
          <div className="row gap mb"><Avatar user={{ name: profile.name, profilePicture: profile.imageUrl }} size={48} /><div><div className="bold">{profile.name}</div><div className="small muted">{profile.email}</div>{profile.hasPendingApprovalRequest && <span className="badge warning">Aprovação pendente</span>}</div></div>
          <div className="grid cols-2">
            <div className="field"><label>Nome</label><input value={f.name} onChange={(e) => set('name', e.target.value)} disabled={!canEdit} /></div>
            <div className="field"><label>Início da semana</label><select value={f.weekStart} onChange={(e) => set('weekStart', e.target.value)} disabled={!canEdit}>{WEEKDAYS.map((d) => <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>)}</select></div>
          </div>
          <div className="field"><label>Dias úteis</label><div className="row gap wrap">{WEEKDAYS.map((d) => <label key={d} className="checkbox"><input type="checkbox" disabled={!canEdit} checked={f.workingDays.includes(d)} onChange={(e) => set('workingDays', e.target.checked ? [...f.workingDays, d] : f.workingDays.filter((x) => x !== d))} />{WEEKDAY_LABELS[d].slice(0, 3)}</label>)}</div></div>
          <div className="field"><label>Capacidade diária</label><input value={f.workCapacity} onChange={(e) => set('workCapacity', e.target.value)} disabled={!canEdit} placeholder="8h" style={{ maxWidth: 160 }} /></div>
          {(fields || []).length > 0 && <><h3 className="mt">Campos personalizados</h3>{(fields || []).map((cf) => <div key={cf.id} className="field"><label>{cf.name}{cf.required && ' *'}</label><CustomFieldInput field={cf} value={f.cf[cf.id]} disabled={!canEdit || (cf.onlyAdminCanEdit && !isAdmin)} onChange={(v) => set('cf', { ...f.cf, [cf.id]: v })} /></div>)}</>}
        </>
      )}
    </Modal>
  );
}

function ManagerModal({ member, users, groups, onClose, onChanged }) {
  const { workspace, toast } = useStore();
  const wsId = workspace?.id;
  const [roles, setRoles] = useState((member.roles || []).filter((r) => r.role === 'TEAM_MANAGER').map((r) => r.entityId));
  const [busy, setBusy] = useState(false);
  async function toggle(entityId, on) {
    setBusy(true);
    try {
      if (on) await api.post(`${ws(wsId)}/users/${member.id}/roles`, { role: 'TEAM_MANAGER', entityId });
      else await request('DELETE', `${ws(wsId)}/users/${member.id}/roles`, { role: 'TEAM_MANAGER', entityId });
      setRoles((l) => (on ? [...l, entityId] : l.filter((x) => x !== entityId)));
      onChanged();
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  }
  const others = users.filter((u) => u.id !== member.id && u.memberStatus !== 'INACTIVE');
  return (
    <Modal title={`Gerente de equipe – ${member.name}`} onClose={onClose} size="lg" footer={<button className="btn" onClick={onClose}>Concluir</button>}>
      <p className="small muted">Um gerente de equipe pode ver e editar registros de tempo, aprovar planilhas e folgas das pessoas e grupos que gerencia.</p>
      <div className="grid cols-2">
        <div>
          <h3>Pessoas</h3>
          {others.length === 0 && <div className="light small">Nenhum outro membro.</div>}
          {others.map((u) => <div key={u.id} className="row gap" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}><Avatar user={u} size={24} /><span className="grow truncate">{u.name}</span><Switch value={roles.includes(u.id)} disabled={busy} onChange={(v) => toggle(u.id, v)} /></div>)}
        </div>
        <div>
          <h3>Grupos</h3>
          {groups.length === 0 && <div className="light small">Nenhum grupo. <Link to="/team/groups">Criar grupos</Link></div>}
          {groups.map((g) => <div key={g.id} className="row gap" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}><span className="grow truncate">{g.name} <span className="light small">({g.userIds?.length || 0})</span></span><Switch value={roles.includes(g.id)} disabled={busy} onChange={(v) => toggle(g.id, v)} /></div>)}
        </div>
      </div>
    </Modal>
  );
}

function KioskPinModal({ member, onClose }) {
  const { workspace, toast } = useStore();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!/^\d{4,8}$/.test(pin)) { setError('O PIN deve ter de 4 a 8 dígitos'); return; }
    setBusy(true); setError(null);
    try { await api.put(`${ws(workspace.id)}/users/${member.id}/kiosk-pin`, { pin }); toast('PIN definido', 'success'); onClose(); } catch (e) { setError(e.status === 404 ? 'O módulo de quiosque não está disponível neste servidor.' : errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`PIN de quiosque – ${member.name}`} size="sm" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>Salvar</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Novo PIN (4 a 8 dígitos)</label><input autoFocus inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} onKeyDown={(e) => e.key === 'Enter' && save()} /></div>
      <p className="small muted">O PIN é usado para registrar entrada e saída no modo quiosque.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- Grupos
function GroupsTab() {
  const { workspace, isAdmin, toast } = useStore();
  const wsId = workspace?.id;
  const { data: groups, loading, error, reload } = useAsync(() => endpoints.groups(wsId), [wsId], { initial: [] });
  const { data: users } = useAsync(() => endpoints.users(wsId), [wsId], { initial: [] });
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const nameOf = (uid) => (users || []).find((u) => u.id === uid)?.name || '?';
  const remove = (g) => setConfirm({ title: 'Excluir grupo', danger: true, confirmLabel: 'Excluir', message: `Excluir o grupo “${g.name}”? Os membros continuarão no workspace.`, onConfirm: async () => { try { await api.delete(`${ws(wsId)}/user-groups/${g.id}`); toast('Grupo excluído', 'success'); invalidateCache(wsId); reload(); } catch (e) { toast(errorMessage(e), 'error'); } } });
  return (
    <div className="card">
      <div className="filter-bar"><span className="muted small">{(groups || []).length} grupo(s)</span>{isAdmin && <button className="btn right" onClick={() => setEditing({})}>+ Criar grupo</button>}</div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      {loading && !groups?.length ? <Spinner block /> : (groups || []).length === 0 ? <Empty icon="👥" title="Nenhum grupo">Grupos facilitam dar acesso a projetos e definir gerentes de equipe.</Empty> : (
        <table className="table">
          <thead><tr><th>Grupo</th><th>Membros</th><th>Gerentes</th><th /></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td className="bold">{g.name}</td>
                <td><span className="row gap wrap">{(g.userIds || []).slice(0, 6).map((uid) => <span key={uid} className="chip"><Avatar user={(users || []).find((u) => u.id === uid) || { name: '?' }} size={18} />{nameOf(uid)}</span>)}{(g.userIds || []).length > 6 && <span className="chip">+{g.userIds.length - 6}</span>}{(g.userIds || []).length === 0 && <span className="light">—</span>}</span></td>
                <td className="muted small">{(g.teamManagers || []).map((m) => m.name).join(', ') || '—'}</td>
                <td className="actions">{isAdmin && <Dropdown><button onClick={() => setEditing(g)}>Editar</button><hr /><button className="danger" onClick={() => remove(g)}>Excluir</button></Dropdown>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <GroupModal group={editing.id ? editing : null} users={users || []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidateCache(wsId); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function GroupModal({ group, users, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const [name, setName] = useState(group?.name || '');
  const [userIds, setUserIds] = useState(group?.userIds || []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim()) { setError('Informe o nome do grupo'); return; }
    setBusy(true); setError(null);
    try {
      if (group) await api.put(`${ws(workspace.id)}/user-groups/${group.id}`, { name: name.trim(), userIds }); else await api.post(`${ws(workspace.id)}/user-groups`, { name: name.trim(), userIds });
      toast(group ? 'Grupo salvo' : 'Grupo criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={group ? 'Editar grupo' : 'Criar grupo'} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{group ? 'Salvar' : 'Criar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></div>
      <div className="field"><label>Membros</label><MultiPicker options={users} value={userIds} onChange={setUserIds} label="Selecionar membros…" /></div>
    </Modal>
  );
}

function RemindersTab() {
  return (
    <div className="card">
      <div className="card-body">
        <h3>Lembretes e alertas</h3>
        <p className="muted">Configure lembretes para membros que esqueceram de registrar horas, alertas de excesso de horas e avisos de orçamento de projetos na página de alertas.</p>
        <Link to="/alerts" className="btn secondary">Abrir alertas e lembretes</Link>
      </div>
    </div>
  );
}
