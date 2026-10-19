import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { invalidateCache } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Confirm, Dropdown } from '../components/ui.jsx';
import { useDebounce } from '../lib/hooks.js';
import { errorMessage } from '../lib/format.js';

const fmtDay = (v) => (v ? new Date(v).toLocaleDateString('pt-BR') : '—');
const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

// Etiquetas: cadastro e status (ativa / inativa). An inactive tag stays on the records that already use it – reports,
// approvals and exports keep showing it – but can no longer be added to any record.
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
  const [picked, setPicked] = useState(() => new Set());
  const canCreate = isAdmin || settings.entityCreationPermissions?.whoCanCreateTags === 'EVERYONE' || settings.onlyAdminsCreateTag === false;

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try { setList(await endpoints.tags(wsId, { archived, name: name || undefined, 'include-usage': true })); } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, archived, name]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPicked(new Set()); }, [wsId, archived, name]);

  const selected = useMemo(() => list.filter((t) => picked.has(t.id)), [list, picked]);
  const allPicked = list.length > 0 && selected.length === list.length;
  const togglePick = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

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

  // inactivate / reactivate one or many tags, after a confirmation that says what happens to the records
  function setStatus(tags, inactive) {
    const target = tags.filter((t) => !!t.archived !== inactive);
    if (!target.length) { toast(inactive ? 'As etiquetas selecionadas já estão inativas' : 'As etiquetas selecionadas já estão ativas'); return; }
    const entries = target.reduce((s, t) => s + (t.usage?.entries || 0), 0);
    const one = target.length === 1;
    const records = !entries ? ''
      : ` ${entries === 1 ? 'O registro que já' : `Os ${plural(entries, 'registro', 'registros')} que já`} ${one ? 'a' : 'as'} ${entries === 1 ? 'usa continua' : 'usam continuam'} com ${one ? 'ela' : 'elas'} em relatórios, aprovações e exportações, e ${entries === 1 ? 'pode ser editado' : 'podem ser editados'} normalmente.`;
    const message = inactive
      ? (one ? `Inativar a etiqueta “${target[0].name}”? Ela deixa de aparecer para seleção e não poderá ser usada em novos registros, nem por administradores.`
        : `Inativar ${plural(target.length, 'etiqueta', 'etiquetas')}? Elas deixam de aparecer para seleção e não poderão ser usadas em novos registros, nem por administradores.`) + records
      : (one ? `Reativar a etiqueta “${target[0].name}”? Ela volta a aparecer para seleção em novos registros.`
        : `Reativar ${plural(target.length, 'etiqueta', 'etiquetas')}? Elas voltam a aparecer para seleção em novos registros.`);
    setConfirm({
      title: inactive ? 'Inativar etiquetas' : 'Reativar etiquetas',
      confirmLabel: inactive ? 'Inativar' : 'Reativar',
      message,
      onConfirm: () => run(async () => {
        const r = await api.post(`${ws(wsId)}/tags/bulk-status`, { tagIds: target.map((t) => t.id), archived: inactive });
        setPicked(new Set());
        return r;
      }, inactive ? `${plural(target.length, 'etiqueta inativada', 'etiquetas inativadas')}` : `${plural(target.length, 'etiqueta reativada', 'etiquetas reativadas')}`),
    });
  }
  const remove = (t) => setConfirm({
    title: 'Excluir etiqueta', danger: true, confirmLabel: 'Excluir',
    message: `Excluir a etiqueta “${t.name}”? Ela será removida de ${t.usage?.entries ? plural(t.usage.entries, 'registro', 'registros') : 'todos os registros de tempo'} e some dos relatórios. Para tirar a etiqueta de uso sem perder o histórico, prefira Inativar.`,
    onConfirm: () => run(() => api.delete(`${ws(wsId)}/tags/${t.id}`), 'Etiqueta excluída'),
  });

  return (
    <div>
      <div className="page-header"><h1>Etiquetas</h1></div>
      {isAdmin && (
        <Alert type="info">
          <b>Etiquetas inativas</b> não aparecem para seleção e não podem ser usadas em novos registros. Os registros que já as usam continuam com elas em relatórios,
          aprovações e exportações, e podem ser editados normalmente. Use os filtros de relatório para encontrar esses registros.
        </Alert>
      )}
      <div className="card">
        <div className="filter-bar">
          {canCreate && <><input placeholder="Nova etiqueta…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} style={{ minWidth: 220 }} /><button className="btn" onClick={create} disabled={!newName.trim()}>Adicionar</button></>}
          <select className={canCreate ? 'right' : ''} value={archived} onChange={(e) => setArchived(e.target.value)} aria-label="Status"><option value="false">Ativas</option><option value="true">Inativas</option><option value="">Todas</option></select>
          <input type="search" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 180 }} />
        </div>
        {isAdmin && selected.length > 0 && (
          <div className="bulk-bar">
            <b>{plural(selected.length, 'etiqueta selecionada', 'etiquetas selecionadas')}</b>
            <button className="btn sm secondary" onClick={() => setStatus(selected, true)} disabled={!selected.some((t) => !t.archived)}>Inativar</button>
            <button className="btn sm secondary" onClick={() => setStatus(selected, false)} disabled={!selected.some((t) => t.archived)}>Reativar</button>
            <button className="btn sm ghost" onClick={() => setPicked(new Set())}>Limpar seleção</button>
          </div>
        )}
        <Alert type="error">{error}</Alert>
        {loading && list.length === 0 ? <Spinner block /> : list.length === 0 ? (
          <Empty icon="🏷" title={archived === 'true' ? 'Nenhuma etiqueta inativa' : 'Nenhuma etiqueta'}>Etiquetas ajudam a categorizar registros de tempo além de projetos e tarefas.</Empty>
        ) : (
          <>
            <table className="table tags-table">
              <thead><tr>
                {isAdmin && <th className="pick"><input type="checkbox" aria-label="Selecionar todas" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(list.map((t) => t.id)))} /></th>}
                <th>Nome</th><th>Status</th><th className="num">Registros</th><th>Último uso</th><th />
              </tr></thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id} className={t.archived ? 'inactive-row' : ''}>
                    {isAdmin && <td className="pick"><input type="checkbox" aria-label={`Selecionar ${t.name}`} checked={picked.has(t.id)} onChange={() => togglePick(t.id)} /></td>}
                    <td>
                      {renaming?.id === t.id ? (
                        <span className="row gap"><input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setRenaming(null); }} style={{ maxWidth: 280 }} /><button className="btn sm" onClick={rename}>Salvar</button><button className="btn ghost sm" onClick={() => setRenaming(null)}>Cancelar</button></span>
                      ) : <span className={`chip ${t.archived ? 'inactive' : ''}`} style={{ fontSize: 13 }}>{t.name}</span>}
                    </td>
                    <td>{t.archived ? <span className="badge">Inativa</span> : <span className="badge success">Ativa</span>}</td>
                    <td className="num">{(t.usage?.entries || 0).toLocaleString('pt-BR')}</td>
                    <td className="small muted">{fmtDay(t.usage?.lastUsed)}</td>
                    <td className="actions">
                      {isAdmin && (
                        <Dropdown>
                          <button onClick={() => setRenaming({ id: t.id, name: t.name })}>Renomear</button>
                          <button onClick={() => setStatus([t], !t.archived)}>{t.archived ? 'Reativar' : 'Inativar'}</button>
                          <hr />
                          <button className="danger" onClick={() => remove(t)}>Excluir</button>
                        </Dropdown>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="small muted" style={{ padding: '8px 12px' }}>{plural(list.length, 'etiqueta', 'etiquetas')}</div>
          </>
        )}
      </div>
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
