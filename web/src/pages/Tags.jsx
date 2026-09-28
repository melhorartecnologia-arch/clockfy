import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { invalidateCache } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Confirm, Dropdown } from '../components/ui.jsx';
import { useDebounce } from '../lib/hooks.js';
import { errorMessage } from '../lib/format.js';

export default function Tags() {
  const { workspace, settings, isAdmin, toast } = useStore();
  const wsId = workspace?.id;
  const [archived, setArchived] = useState('false');
  const [q, setQ] = useState('');
  const name = useDebounce(q, 300);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(null); // { id, name }
  const [confirm, setConfirm] = useState(null);
  const canCreate = isAdmin || settings.entityCreationPermissions?.whoCanCreateTags === 'EVERYONE' || settings.onlyAdminsCreateTag === false;

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try { setList(await endpoints.tags(wsId, { archived, name: name || undefined })); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, archived, name]);
  useEffect(() => { load(); }, [load]);

  async function run(fn, msg) {
    try { await fn(); invalidateCache(wsId); if (msg) toast(msg, 'success'); load(); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  async function create() {
    const n = newName.trim(); if (!n) return;
    await run(() => api.post(`${ws(wsId)}/tags`, { name: n }), 'Etiqueta criada');
    setNewName('');
  }
  async function rename() {
    const n = renaming.name.trim(); if (!n) return;
    await run(() => api.put(`${ws(wsId)}/tags/${renaming.id}`, { name: n }), 'Etiqueta renomeada');
    setRenaming(null);
  }
  const setArchivedTag = (t, v) => run(() => api.put(`${ws(wsId)}/tags/${t.id}`, { archived: v }), v ? 'Etiqueta arquivada' : 'Etiqueta restaurada');
  const remove = (t) => setConfirm({ title: 'Excluir etiqueta', danger: true, confirmLabel: 'Excluir', message: `Excluir a etiqueta “${t.name}”? Ela será removida de todos os registros de tempo.`, onConfirm: () => run(() => api.delete(`${ws(wsId)}/tags/${t.id}`), 'Etiqueta excluída') });

  return (
    <div>
      <div className="page-header"><h1>Etiquetas</h1></div>
      <div className="card">
        <div className="filter-bar">
          {canCreate && <><input placeholder="Nova etiqueta…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} style={{ minWidth: 220 }} /><button className="btn" onClick={create} disabled={!newName.trim()}>Adicionar</button></>}
          <select className={canCreate ? 'right' : ''} value={archived} onChange={(e) => setArchived(e.target.value)}><option value="false">Ativas</option><option value="true">Arquivadas</option><option value="">Todas</option></select>
          <input type="search" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 180 }} />
        </div>
        <Alert type="error">{error}</Alert>
        {loading && list.length === 0 ? <Spinner block /> : list.length === 0 ? <Empty icon="🏷" title="Nenhuma etiqueta">Etiquetas ajudam a categorizar registros de tempo além de projetos e tarefas.</Empty> : (
          <table className="table">
            <thead><tr><th>Nome</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <td>
                    {renaming?.id === t.id ? (
                      <span className="row gap"><input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setRenaming(null); }} style={{ maxWidth: 280 }} /><button className="btn sm" onClick={rename}>Salvar</button><button className="btn ghost sm" onClick={() => setRenaming(null)}>Cancelar</button></span>
                    ) : <span className="chip" style={{ fontSize: 13 }}>{t.name}</span>}
                  </td>
                  <td>{t.archived ? <span className="badge warning">Arquivada</span> : <span className="badge success">Ativa</span>}</td>
                  <td className="actions">
                    {isAdmin && (
                      <Dropdown>
                        <button onClick={() => setRenaming({ id: t.id, name: t.name })}>Renomear</button>
                        <button onClick={() => setArchivedTag(t, !t.archived)}>{t.archived ? 'Restaurar' : 'Arquivar'}</button>
                        <hr />
                        <button className="danger" onClick={() => remove(t)}>Excluir</button>
                      </Dropdown>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
