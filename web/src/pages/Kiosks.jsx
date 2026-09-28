import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { MultiPicker, useProjects, useUsers } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, Switch, Avatar, ProjectLabel } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { errorMessage } from '../lib/format.js';

const DURATIONS = [[3600, '1 hora'], [4 * 3600, '4 horas'], [8 * 3600, '8 horas'], [12 * 3600, '12 horas'], [86400, '24 horas'], [7 * 86400, '7 dias'], [30 * 86400, '30 dias']];
function fmtDurationLabel(s) {
  const found = DURATIONS.find(([v]) => v === s);
  if (found) return found[1];
  if (s % 86400 === 0) return `${s / 86400} dia${s / 86400 > 1 ? 's' : ''}`;
  if (s % 3600 === 0) return `${s / 3600} hora${s / 3600 > 1 ? 's' : ''}`;
  return `${Math.round(s / 60)} min`;
}
const kioskUrl = (code) => `${window.location.origin}/kiosk/${code}`;

function useGroups(wsId) {
  const [list, setList] = useState([]);
  useEffect(() => { if (!wsId) return; endpoints.groups(wsId).then(setList).catch(() => setList([])); }, [wsId]);
  return list;
}

export default function Kiosks() {
  const { workspace, settings, toast } = useStore();
  const wsId = workspace?.id;
  const projects = useProjects(wsId);
  const users = useUsers(wsId);
  const groups = useGroups(wsId);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState({});
  const { data: list, loading, error, reload } = useAsync(() => api.get(`${ws(wsId)}/kiosks`), [wsId], { initial: [] });

  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Link copiado', 'success')).catch(() => toast('Não foi possível copiar', 'error'));
  async function run(id, fn, msg) {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await fn(); if (msg) toast(msg, 'success'); await reload(); } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy((b) => ({ ...b, [id]: false })); }
  }
  const toggle = (k, active) => run(k.id, () => api.put(`${ws(wsId)}/kiosks/${k.id}`, { active }), active ? 'Quiosque ativado' : 'Quiosque desativado (sessões encerradas)');
  const regenerate = (k) => setConfirm({ title: 'Regenerar código', confirmLabel: 'Regenerar', message: `Gerar um novo código para “${k.name}”? O link atual deixará de funcionar e todas as sessões abertas neste quiosque serão encerradas.`, onConfirm: () => run(k.id, () => api.post(`${ws(wsId)}/kiosks/${k.id}/regenerate-code`), 'Código regenerado') });
  const remove = (k) => setConfirm({ title: 'Excluir quiosque', danger: true, confirmLabel: 'Excluir', message: `Excluir o quiosque “${k.name}”? Os registros de tempo feitos por ele são mantidos.`, onConfirm: () => run(k.id, () => api.delete(`${ws(wsId)}/kiosks/${k.id}`), 'Quiosque excluído') });

  const membersText = (k) => {
    if (!k.userIds?.length && !k.groupIds?.length) return <span className="muted">Todos os membros</span>;
    const names = [...k.userIds.map((id) => users.find((u) => u.id === id)?.name || '…'), ...k.groupIds.map((id) => `Grupo: ${groups.find((g) => g.id === id)?.name || '…'}`)];
    return <span className="tag-list">{names.slice(0, 3).map((n, i) => <span key={i} className="chip">{n}</span>)}{names.length > 3 && <span className="chip" title={names.slice(3).join(', ')}>+{names.length - 3}</span>}</span>;
  };

  return (
    <div>
      <div className="page-header">
        <h1>Quiosque</h1>
        <button className="btn right" onClick={() => setEditing({})}>+ Criar quiosque</button>
      </div>
      <div className="card mb"><div className="card-body small">
        O quiosque é uma página pública para um tablet ou computador compartilhado: os membros escolhem o próprio nome, digitam o PIN e registram entrada, pausas e saída sem precisar de login. Cada quiosque tem um link próprio (<span className="kbd">/kiosk/&lt;código&gt;</span>); abra-o no dispositivo e, se quiser, deixe-o em tela cheia.
        {settings.kioskPinRequired === false && <span className="muted"> A exigência de PIN está desativada por padrão nas configurações do workspace.</span>}
      </div></div>

      <div className="card">
        <Alert type="error">{error ? errorMessage(error) : null}</Alert>
        {loading && !list.length ? <Spinner block /> : !list.length ? <Empty icon="🖥" title="Nenhum quiosque">Crie um quiosque para que a equipe registre ponto em um dispositivo compartilhado.</Empty> : (
          <table className="table">
            <thead><tr><th>Nome</th><th>Código / link</th><th>PIN</th><th>Sessão</th><th>Projeto padrão</th><th>Membros</th><th>Ativo</th><th /></tr></thead>
            <tbody>
              {list.map((k) => (
                <tr key={k.id} style={k.active ? undefined : { opacity: .65 }}>
                  <td className="bold">{k.name}</td>
                  <td className="nowrap">
                    <span className="kbd" style={{ fontSize: 14, letterSpacing: 1 }}>{k.code}</span>
                    <button className="btn ghost icon sm ml" title="Copiar link" onClick={() => copy(kioskUrl(k.code))}>⧉</button>
                    <a className="btn ghost icon sm" href={`/kiosk/${k.code}`} target="_blank" rel="noreferrer" title="Abrir quiosque em nova aba">↗</a>
                  </td>
                  <td>{k.pinRequired ? <span className="badge primary">Obrigatório</span> : <span className="badge">Sem PIN</span>}</td>
                  <td className="small">{fmtDurationLabel(k.sessionDurationSeconds)}</td>
                  <td>{k.defaultProjectId ? <ProjectLabel project={projects.find((p) => p.id === k.defaultProjectId) || { name: '…' }} /> : <span className="light">—</span>}</td>
                  <td className="small">{membersText(k)}</td>
                  <td><Switch value={k.active} disabled={busy[k.id]} onChange={(v) => toggle(k, v)} /></td>
                  <td className="actions">{busy[k.id] && <Spinner />}<Dropdown><button onClick={() => setEditing(k)}>Editar</button><button onClick={() => copy(kioskUrl(k.code))}>Copiar link</button><button onClick={() => regenerate(k)}>Regenerar código</button><hr /><button className="danger" onClick={() => remove(k)}>Excluir</button></Dropdown></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <MemberPins users={users} />

      {editing && <KioskModal kiosk={editing.id ? editing : null} projects={projects} users={users} groups={groups} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function KioskModal({ kiosk, projects, users, groups, onClose, onSaved }) {
  const { workspace, settings, toast } = useStore();
  const [f, setF] = useState({
    name: kiosk?.name || '', pinRequired: kiosk ? kiosk.pinRequired : settings.kioskPinRequired !== false, sessionDurationSeconds: kiosk?.sessionDurationSeconds || 86400,
    defaultProjectId: kiosk?.defaultProjectId || '', userIds: kiosk?.userIds || [], groupIds: kiosk?.groupIds || [], active: kiosk ? kiosk.active : true,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const customDuration = !DURATIONS.some(([v]) => v === f.sessionDurationSeconds);
  async function save() {
    if (!f.name.trim()) { setError('Informe o nome do quiosque'); return; }
    setBusy(true); setError(null);
    try {
      const body = { name: f.name.trim(), pinRequired: f.pinRequired, sessionDurationSeconds: Number(f.sessionDurationSeconds), defaultProjectId: f.defaultProjectId || null, userIds: f.userIds, groupIds: f.groupIds, active: f.active };
      if (kiosk) await api.put(`${ws(workspace.id)}/kiosks/${kiosk.id}`, body); else await api.post(`${ws(workspace.id)}/kiosks`, body);
      toast(kiosk ? 'Quiosque salvo' : 'Quiosque criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={kiosk ? 'Editar quiosque' : 'Criar quiosque'} onClose={onClose} size="lg" footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{kiosk ? 'Salvar' : 'Criar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="grid cols-2">
        <div className="field"><label>Nome</label><input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Recepção" /></div>
        <div className="field"><label>Duração da sessão</label>
          <select value={customDuration ? 'custom' : f.sessionDurationSeconds} onChange={(e) => set('sessionDurationSeconds', e.target.value === 'custom' ? 2 * 3600 : Number(e.target.value))}>
            {DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {customDuration && <option value="custom">Personalizada ({fmtDurationLabel(f.sessionDurationSeconds)})</option>}
          </select>
          <div className="small muted" style={{ marginTop: 4 }}>Após esse tempo o membro precisa entrar de novo no quiosque.</div>
        </div>
      </div>
      <div className="field"><label>Projeto padrão (usado ao registrar entrada)</label>
        <select value={f.defaultProjectId} onChange={(e) => set('defaultProjectId', e.target.value)}><option value="">Sem projeto</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.clientName ? ` – ${p.clientName}` : ''}</option>)}</select>
      </div>
      <div className="grid cols-2">
        <div className="field"><label>Usuários permitidos</label><MultiPicker options={users} value={f.userIds} onChange={(v) => set('userIds', v)} label="Todos os membros" /></div>
        <div className="field"><label>Grupos permitidos</label><MultiPicker options={groups} value={f.groupIds} onChange={(v) => set('groupIds', v)} label="Todos os grupos" /></div>
      </div>
      <div className="small muted mb">Deixe usuários e grupos vazios para permitir todos os membros ativos do workspace.</div>
      <div className="row gap mb"><Switch value={f.pinRequired} onChange={(v) => set('pinRequired', v)} /><span>Exigir PIN para entrar</span></div>
      <div className="row gap"><Switch value={f.active} onChange={(v) => set('active', v)} /><span>Quiosque ativo</span></div>
    </Modal>
  );
}

function MemberPins({ users }) {
  const { workspace, toast } = useStore();
  const wsId = workspace?.id;
  const [pins, setPins] = useState({}); // userId → boolean
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState(null);
  const [q, setQ] = useState('');

  const loadPins = useCallback(async () => {
    if (!wsId || !users.length) return;
    setLoading(true);
    const entries = await Promise.all(users.map((u) => api.get(`${ws(wsId)}/users/${u.id}/kiosk-pin`).then((r) => [u.id, !!r.kioskPinSet]).catch(() => [u.id, null])));
    setPins(Object.fromEntries(entries)); setLoading(false);
  }, [wsId, users]);
  useEffect(() => { loadPins(); }, [loadPins]);

  async function clearPin(u) {
    try { await api.delete(`${ws(wsId)}/users/${u.id}/kiosk-pin`); toast('PIN removido', 'success'); setPins((p) => ({ ...p, [u.id]: false })); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  const filtered = users.filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || (u.email || '').toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="card">
      <div className="card-head"><h3 style={{ margin: 0 }}>PINs dos membros</h3><span className="muted small">Cada membro precisa de um PIN de 4 a 6 dígitos para entrar em quiosques com PIN obrigatório.</span><input type="search" className="right" placeholder="Buscar membro…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} /></div>
      {!users.length ? <Spinner block /> : (
        <table className="table compact">
          <thead><tr><th>Membro</th><th>E-mail</th><th>PIN</th><th /></tr></thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id}>
                <td><span className="row gap"><Avatar user={u} size={26} /><span>{u.name}</span></span></td>
                <td className="muted small">{u.email}</td>
                <td>{loading && pins[u.id] === undefined ? <Spinner /> : pins[u.id] ? <span className="badge success">Definido</span> : pins[u.id] === null ? <span className="light small">?</span> : <span className="badge">Não definido</span>}</td>
                <td className="actions"><button className="btn secondary sm" onClick={() => setTarget(u)}>{pins[u.id] ? 'Alterar PIN' : 'Definir PIN'}</button>{pins[u.id] && <button className="btn ghost sm ml" onClick={() => clearPin(u)}>Remover</button>}</td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={4} className="muted center">Nenhum membro encontrado</td></tr>}
          </tbody>
        </table>
      )}
      {target && <PinModal user={target} onClose={() => setTarget(null)} onSaved={() => { setPins((p) => ({ ...p, [target.id]: true })); setTarget(null); }} />}
    </div>
  );
}

function PinModal({ user, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!/^\d{4,6}$/.test(pin)) { setError('O PIN deve ter de 4 a 6 dígitos numéricos'); return; }
    if (pin !== pin2) { setError('Os PINs não conferem'); return; }
    setBusy(true); setError(null);
    try { await api.put(`${ws(workspace.id)}/users/${user.id}/kiosk-pin`, { pin }); toast(`PIN de ${user.name} definido`, 'success'); onSaved(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const digits = (v) => v.replace(/\D/g, '').slice(0, 6);
  return (
    <Modal title={`PIN de ${user.name}`} onClose={onClose} size="sm" footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>Salvar PIN</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Novo PIN (4 a 6 dígitos)</label><input autoFocus type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(digits(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && save()} /></div>
      <div className="field"><label>Confirmar PIN</label><input type="password" inputMode="numeric" autoComplete="new-password" value={pin2} onChange={(e) => setPin2(digits(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && save()} /></div>
      <p className="small muted" style={{ margin: 0 }}>Informe o PIN ao membro pessoalmente; ele não é exibido depois de salvo.</p>
    </Modal>
  );
}
