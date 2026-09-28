import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints, ws } from '../api.js';
import { MultiPicker, useClients, invalidateCache } from '../components/pickers.jsx';
import { Spinner, Alert, Empty, Modal, Confirm, Dropdown, ColorPicker, Money } from '../components/ui.jsx';
import { useDebounce } from '../lib/hooks.js';
import { fmtDuration, isoToSeconds, errorMessage } from '../lib/format.js';

export function canCreateProjects(isAdmin, settings) {
  return isAdmin || settings.entityCreationPermissions?.whoCanCreateProjectsAndClients === 'EVERYONE' || settings.onlyAdminsCreateProject === false;
}

export default function Projects() {
  const { workspace, settings, isAdmin, toast } = useStore();
  const wsId = workspace?.id;
  const clients = useClients(wsId);
  const [params] = useSearchParams();
  const [filters, setFilters] = useState({ archived: 'false', clients: params.get('client') ? [params.get('client')] : [], name: '', access: '', templates: false, billable: '' });
  const name = useDebounce(filters.name, 300);
  const [sort, setSort] = useState({ column: 'NAME', order: 'ASCENDING' });
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const showRates = isAdmin || !settings.onlyAdminsSeeBillableRates;
  const canCreate = canCreateProjects(isAdmin, settings);

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true); setError(null);
    try {
      const r = await endpoints.projects(wsId, {
        archived: filters.archived, clients: filters.clients, name: name || undefined, access: filters.access || undefined,
        'is-template': filters.templates ? true : undefined, billable: filters.billable || undefined, hydrated: false,
        'sort-column': sort.column, 'sort-order': sort.order, 'page-size': 1000,
      });
      setList(r);
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [wsId, filters.archived, filters.clients, name, filters.access, filters.templates, filters.billable, sort]);
  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    const l = [...list];
    if (sort.column === 'PROGRESS') l.sort((a, b) => progressOf(b) - progressOf(a));
    return l.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
  }, [list, sort.column]);

  const toggleSort = (column) => setSort((s) => ({ column, order: s.column === column && s.order === 'ASCENDING' ? 'DESCENDING' : 'ASCENDING' }));
  const arrow = (c) => (sort.column === c ? (sort.order === 'ASCENDING' ? ' ▲' : ' ▼') : '');

  async function act(fn, msg) {
    try { await fn(); invalidateCache(wsId); if (msg) toast(msg, 'success'); load(); } catch (e) { toast(errorMessage(e), 'error'); }
  }
  const favorite = (p) => act(() => (p.favorite ? api.delete(`${ws(wsId)}/projects/${p.id}/favorite`) : api.post(`${ws(wsId)}/projects/${p.id}/favorite`)));
  const archive = (p, archived) => act(() => api.put(`${ws(wsId)}/projects/${p.id}`, { archived }), archived ? 'Projeto arquivado' : 'Projeto restaurado');
  const template = (p, isTemplate) => act(() => api.patch(`${ws(wsId)}/projects/${p.id}/template`, { isTemplate }), isTemplate ? 'Projeto marcado como modelo' : 'Projeto deixou de ser modelo');
  const duplicate = (p) => act(() => api.post(`${ws(wsId)}/projects/from-template`, { name: `${p.name} (cópia)`, templateProjectId: p.id, clientId: p.clientId || null, color: p.color, isPublic: p.public }), 'Projeto duplicado');
  const remove = (p) => setConfirm({ title: 'Excluir projeto', danger: true, message: `Excluir permanentemente o projeto “${p.name}” e todos os seus registros de tempo? Esta ação não pode ser desfeita.`, confirmLabel: 'Excluir', onConfirm: () => act(() => api.delete(`${ws(wsId)}/projects/${p.id}`), 'Projeto excluído') });

  return (
    <div>
      <div className="page-header">
        <h1>{settings.projectLabel === 'project' || !settings.projectLabel ? 'Projetos' : settings.projectLabel}</h1>
        {canCreate && <button className="btn right" onClick={() => setCreating(true)}>+ Criar projeto</button>}
      </div>
      <div className="card">
        <div className="filter-bar">
          <select value={filters.archived} onChange={(e) => setFilters((f) => ({ ...f, archived: e.target.value }))}><option value="false">Ativos</option><option value="true">Arquivados</option><option value="">Todos</option></select>
          <MultiPicker options={clients} value={filters.clients} onChange={(v) => setFilters((f) => ({ ...f, clients: v }))} label="Cliente" width={200} />
          <select value={filters.access} onChange={(e) => setFilters((f) => ({ ...f, access: e.target.value }))}><option value="">Acesso: todos</option><option value="PUBLIC">Público</option><option value="PRIVATE">Privado</option></select>
          <select value={filters.billable} onChange={(e) => setFilters((f) => ({ ...f, billable: e.target.value }))}><option value="">Faturável: todos</option><option value="true">Faturável</option><option value="false">Não faturável</option></select>
          <label className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" checked={filters.templates} onChange={(e) => setFilters((f) => ({ ...f, templates: e.target.checked }))} /> Somente modelos</label>
          <input type="search" placeholder="Buscar por nome…" value={filters.name} onChange={(e) => setFilters((f) => ({ ...f, name: e.target.value }))} className="right" style={{ minWidth: 200 }} />
        </div>
        <Alert type="error">{error}</Alert>
        {loading && list.length === 0 ? <Spinner block /> : sorted.length === 0 ? <Empty icon="▣" title="Nenhum projeto encontrado">{canCreate ? 'Crie o primeiro projeto para começar a rastrear tempo.' : 'Você ainda não tem acesso a nenhum projeto.'}</Empty> : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 30 }} />
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('NAME')}>Nome{arrow('NAME')}</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('CLIENT_NAME')}>Cliente{arrow('CLIENT_NAME')}</th>
                <th className="num" style={{ cursor: 'pointer' }} onClick={() => toggleSort('DURATION')}>Rastreado{arrow('DURATION')}</th>
                <th style={{ cursor: 'pointer', minWidth: 160 }} onClick={() => toggleSort('PROGRESS')}>Progresso{arrow('PROGRESS')}</th>
                <th>Acesso</th>
                <th>Faturável</th>
                {showRates && <th className="num">Taxa</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const secs = isoToSeconds(p.duration);
                return (
                  <tr key={p.id} style={p.archived ? { opacity: .7 } : undefined}>
                    <td><button className="btn ghost icon sm" title={p.favorite ? 'Remover dos favoritos' : 'Favoritar'} onClick={() => favorite(p)} style={{ color: p.favorite ? 'var(--warning)' : 'var(--text-light)', fontSize: 16 }}>{p.favorite ? '★' : '☆'}</button></td>
                    <td>
                      <span className="row gap"><span className="dot" style={{ background: p.color }} /><Link to={`/projects/${p.id}`} className="bold" style={{ color: p.color }}>{p.name}</Link>
                        {p.template && <span className="badge">Modelo</span>}{p.archived && <span className="badge warning">Arquivado</span>}</span>
                    </td>
                    <td className="muted">{p.clientName || '—'}</td>
                    <td className="num mono">{fmtDuration(secs, { seconds: false })}</td>
                    <td><Progress project={p} /></td>
                    <td>{p.public ? <span className="badge primary">Público</span> : <span className="badge">Privado</span>}</td>
                    <td>{p.billable ? <span title="Faturável" style={{ color: 'var(--primary)' }}>$</span> : <span className="light">—</span>}</td>
                    {showRates && <td className="num small muted">{p.hourlyRate ? <Money cents={p.hourlyRate.amount} currency={p.hourlyRate.currency} /> : '—'}</td>}
                    <td className="actions">
                      <Dropdown>
                        <Link to={`/projects/${p.id}`}>Abrir</Link>
                        {(isAdmin || canCreate) && <button onClick={() => duplicate(p)}>Duplicar</button>}
                        {isAdmin && <button onClick={() => template(p, !p.template)}>{p.template ? 'Remover modelo' : 'Salvar como modelo'}</button>}
                        {isAdmin && <hr />}
                        {isAdmin && <button onClick={() => archive(p, !p.archived)}>{p.archived ? 'Restaurar' : 'Arquivar'}</button>}
                        {isAdmin && p.archived && <button className="danger" onClick={() => remove(p)}>Excluir</button>}
                      </Dropdown>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {creating && <CreateProjectModal projects={list} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); invalidateCache(wsId); load(); }} />}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function progressOf(p) {
  const est = isoToSeconds(p.timeEstimate?.estimate || p.estimate?.estimate);
  return est ? isoToSeconds(p.duration) / est : 0;
}

export function Progress({ project: p, showLabel = true }) {
  const est = isoToSeconds(p.timeEstimate?.estimate || p.estimate?.estimate);
  const secs = isoToSeconds(p.duration);
  if (!est) return <span className="light small">Sem estimativa</span>;
  const pct = Math.round((secs / est) * 100);
  return (
    <div title={`${fmtDuration(secs, { seconds: false })} de ${fmtDuration(est, { seconds: false })}`}>
      <div className="progress"><div className={pct > 100 ? 'over' : ''} style={{ width: `${Math.min(100, pct)}%` }} /></div>
      {showLabel && <div className="small muted mono" style={{ marginTop: 2 }}>{pct}% de {fmtDuration(est, { seconds: false })}</div>}
    </div>
  );
}

export function CreateProjectModal({ projects, onClose, onCreated }) {
  const { workspace, settings, toast } = useStore();
  const wsId = workspace?.id;
  const clients = useClients(wsId);
  const [templates, setTemplates] = useState(projects ? projects.filter((p) => p.template) : []);
  useEffect(() => { endpoints.projects(wsId, { 'is-template': true, hydrated: false }).then(setTemplates).catch(() => {}); }, [wsId]);
  const [f, setF] = useState({ name: '', clientId: '', color: '#03A9F4', isPublic: settings.isProjectPublicByDefault !== false, billable: settings.defaultBillableProjects !== false, templateId: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    if (!f.name.trim()) { setError('Informe o nome do projeto'); return; }
    setBusy(true); setError(null);
    try {
      const p = f.templateId
        ? await api.post(`${ws(wsId)}/projects/from-template`, { name: f.name.trim(), templateProjectId: f.templateId, clientId: f.clientId || null, color: f.color, isPublic: f.isPublic })
        : await api.post(`${ws(wsId)}/projects`, { name: f.name.trim(), clientId: f.clientId || null, color: f.color, isPublic: f.isPublic, billable: f.billable });
      toast('Projeto criado', 'success');
      onCreated(p);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Criar projeto" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy} onClick={save}>Criar</button></>}>
      <Alert type="error">{error}</Alert>
      <div className="field"><label>Nome</label><input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="Nome do projeto" /></div>
      <div className="grid cols-2">
        <div className="field"><label>Cliente</label><select value={f.clientId} onChange={(e) => set('clientId', e.target.value)}><option value="">Sem cliente</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        {templates.length > 0 && <div className="field"><label>Criar a partir de modelo</label><select value={f.templateId} onChange={(e) => set('templateId', e.target.value)}><option value="">Nenhum</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>}
      </div>
      <div className="field"><label>Cor</label><ColorPicker value={f.color} onChange={(c) => set('color', c)} /></div>
      <div className="row gap wrap">
        <label className="checkbox"><input type="checkbox" checked={f.isPublic} onChange={(e) => set('isPublic', e.target.checked)} /> Público (todos os membros podem ver)</label>
        {!f.templateId && <label className="checkbox"><input type="checkbox" checked={f.billable} onChange={(e) => set('billable', e.target.checked)} /> Faturável</label>}
      </div>
      {f.templateId && <p className="small muted mt">Tarefas, membros, taxas e estimativas serão copiados do modelo.</p>}
    </Modal>
  );
}

