import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { invalidateCache } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown } from '../components/ui.jsx';
import { useDebounce } from '../lib/hooks.js';
import { errorMessage } from '../lib/format.js';

export default function Clients() {
  const { workspace, settings, isAdmin, toast } = useStore();
  const wsId = workspace?.id;
  const [archived, setArchived] = useState('false');
  const [q, setQ] = useState('');
  const name = useDebounce(q, 300);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | {} | client
  const [confirm, setConfirm] = useState(null);
  const canCreate = isAdmin || settings.entityCreationPermissions?.whoCanCreateProjectsAndClients === 'EVERYONE';

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try { setList(await endpoints.clients(wsId, { archived, name: name || undefined })); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, archived, name]);
  useEffect(() => { load(); }, [load]);

  async function run(fn, msg) {
    try { await fn(); invalidateCache(wsId); if (msg) toast(msg, 'success'); load(); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  function archive(c) {
    setConfirm({
      title: 'Arquivar cliente', confirmLabel: 'Arquivar',
      message: <span>Arquivar o cliente <b>{c.name}</b>?<br /><label className="checkbox mt"><input type="checkbox" id="archive-projects" /> Arquivar também os projetos deste cliente</label></span>,
      onConfirm: () => { const also = document.getElementById('archive-projects')?.checked; return run(() => api.put(`${ws(wsId)}/clients/${c.id}${also ? '?archive-projects=true' : ''}`, { archived: true }), 'Cliente arquivado'); },
    });
  }
  const restore = (c) => run(() => api.put(`${ws(wsId)}/clients/${c.id}`, { archived: false }), 'Cliente restaurado');
  const remove = (c) => setConfirm({ title: 'Excluir cliente', danger: true, confirmLabel: 'Excluir', message: `Excluir permanentemente o cliente “${c.name}”? Os projetos ficarão sem cliente.`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/clients/${c.id}`), 'Cliente excluído') });

  return (
    <div>
      <div className="page-header">
        <h1>Clientes</h1>
        {canCreate && <button className="btn right" onClick={() => setEditing({})}>+ Criar cliente</button>}
      </div>
      <div className="card">
        <div className="filter-bar">
          <select value={archived} onChange={(e) => setArchived(e.target.value)}><option value="false">Ativos</option><option value="true">Arquivados</option><option value="">Todos</option></select>
          <input type="search" placeholder="Buscar por nome…" value={q} onChange={(e) => setQ(e.target.value)} className="right" style={{ minWidth: 200 }} />
        </div>
        <Alert type="error">{error}</Alert>
        {loading && list.length === 0 ? <Spinner block /> : list.length === 0 ? <Empty icon="🏢" title="Nenhum cliente encontrado">{canCreate ? 'Crie clientes para agrupar projetos e emitir faturas.' : 'Nenhum cliente cadastrado.'}</Empty> : (
          <table className="table">
            <thead><tr><th>Nome</th><th>E-mail</th><th>Endereço</th><th>Moeda</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} style={c.archived ? { opacity: .7 } : undefined}>
                  <td><span className="bold">{c.name}</span>{c.archived && <span className="badge warning ml">Arquivado</span>}{c.note && <div className="small muted truncate" style={{ maxWidth: 320 }} title={c.note}>{c.note}</div>}</td>
                  <td className="muted">{c.email || '—'}{c.ccEmails?.length > 0 && <div className="small light">cc: {c.ccEmails.join(', ')}</div>}</td>
                  <td className="muted small" style={{ whiteSpace: 'pre-line' }}>{c.address || '—'}</td>
                  <td>{c.currencyCode || <span className="light">Padrão</span>}</td>
                  <td className="actions">
                    {isAdmin && (
                      <Dropdown>
                        <button onClick={() => setEditing(c)}>Editar</button>
                        <Link to={`/projects?client=${c.id}`}>Ver projetos</Link>
                        <hr />
                        {c.archived ? <button onClick={() => restore(c)}>Restaurar</button> : <button onClick={() => archive(c)}>Arquivar</button>}
                        {c.archived && <button className="danger" onClick={() => remove(c)}>Excluir</button>}
                      </Dropdown>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <ClientModal client={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidateCache(wsId); load(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function ClientModal({ client, onClose, onSaved }) {
  const { workspace, toast } = useStore();
  const currencies = workspace?.currencies || [];
  const [f, setF] = useState({ name: client?.name || '', address: client?.address || '', email: client?.email || '', ccEmails: (client?.ccEmails || []).join(', '), note: client?.note || '', currencyId: client?.currencyId || '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    if (!f.name.trim()) { setError('Informe o nome do cliente'); return; }
    setBusy(true); setError(null);
    try {
      const body = { name: f.name.trim(), address: f.address, email: f.email.trim() || null, ccEmails: f.ccEmails.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean), note: f.note, currencyId: f.currencyId || null };
      if (client) await api.put(`${ws(workspace.id)}/clients/${client.id}`, body); else await api.post(`${ws(workspace.id)}/clients`, body);
      toast(client ? 'Cliente salvo' : 'Cliente criado', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={client ? 'Editar cliente' : 'Criar cliente'} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>{client ? 'Salvar' : 'Criar'}</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></div>
      <div className="grid cols-2">
        <div className="field"><label>E-mail</label><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="financeiro@cliente.com" /></div>
        <div className="field"><label>Moeda</label><select value={f.currencyId} onChange={(e) => set('currencyId', e.target.value)}><option value="">Padrão do workspace</option>{currencies.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></div>
      </div>
      <div className="field"><label>E-mails em cópia (separados por vírgula)</label><input value={f.ccEmails} onChange={(e) => set('ccEmails', e.target.value)} placeholder="a@cliente.com, b@cliente.com" /></div>
      <div className="field"><label>Endereço</label><textarea value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="Endereço para faturas" style={{ minHeight: 56 }} /></div>
      <div className="field"><label>Observação</label><textarea value={f.note} onChange={(e) => set('note', e.target.value)} style={{ minHeight: 56 }} /></div>
    </Modal>
  );
}
