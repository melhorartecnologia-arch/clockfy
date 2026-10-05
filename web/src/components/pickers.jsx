import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, endpoints } from '../api.js';
import { useStore } from '../store.jsx';
import { errorMessage } from '../lib/format.js';

function usePanel() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return { open, setOpen, ref };
}

// Caches projects (with tasks) and tags per workspace so pickers open instantly
const cache = new Map();
export function invalidateCache(workspaceId) { for (const k of [...cache.keys()]) if (k.startsWith(workspaceId)) cache.delete(k); }
async function cached(key, loader) {
  if (!cache.has(key)) cache.set(key, loader().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}
export function useProjects(workspaceId, { archived = false } = {}) {
  const [list, setList] = useState([]);
  useEffect(() => {
    if (!workspaceId) return;
    cached(`${workspaceId}:projects:${archived}`, () => endpoints.projects(workspaceId, { archived, hydrated: false })).then(setList).catch(() => setList([]));
  }, [workspaceId, archived]);
  return list;
}
// Active tags of the workspace: [list, loading, setList]
function useTagList(workspaceId) {
  const [state, setState] = useState({ list: [], loading: false });
  useEffect(() => {
    if (!workspaceId) return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    cached(`${workspaceId}:tags`, () => endpoints.tags(workspaceId, { archived: false }))
      .then((list) => alive && setState({ list, loading: false }))
      .catch(() => alive && setState({ list: [], loading: false }));
    return () => { alive = false; };
  }, [workspaceId]);
  const setList = (list) => { cache.set(`${workspaceId}:tags`, Promise.resolve(list)); setState({ list, loading: false }); };
  return [state.list, state.loading, setList];
}
export function useTags(workspaceId) { return useTagList(workspaceId)[0]; }

// Search ignores case and accents ("manutencao" finds "Manutenção")
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
// Options rendered at once in a picker; typing narrows the list down to any item
const MAX_OPTIONS = 200;
export function useTasks(workspaceId, projectId) {
  const [list, setList] = useState([]);
  useEffect(() => {
    if (!workspaceId || !projectId) { setList([]); return; }
    cached(`${workspaceId}:tasks:${projectId}`, () => endpoints.tasks(workspaceId, projectId, { 'is-active': true })).then(setList).catch(() => setList([]));
  }, [workspaceId, projectId]);
  return list;
}
export function useUsers(workspaceId, params) {
  const [list, setList] = useState([]);
  const key = JSON.stringify(params || {});
  useEffect(() => { if (!workspaceId) return; cached(`${workspaceId}:users:${key}`, () => endpoints.users(workspaceId, params)).then(setList).catch(() => setList([])); }, [workspaceId, key]);
  return list;
}
export function useClients(workspaceId) {
  const [list, setList] = useState([]);
  useEffect(() => { if (!workspaceId) return; cached(`${workspaceId}:clients`, () => endpoints.clients(workspaceId, { archived: false })).then(setList).catch(() => setList([])); }, [workspaceId]);
  return list;
}

// Project + task picker ---------------------------------------------------------
export function ProjectPicker({ projectId, taskId, onChange, allowCreate = true, compact, placeholder = 'Projeto' }) {
  const { workspace, isAdmin, settings } = useStore();
  const projects = useProjects(workspace?.id);
  const tasks = useTasks(workspace?.id, projectId);
  const { open, setOpen, ref } = usePanel();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [taskLists, setTaskLists] = useState({});
  const project = projects.find((p) => p.id === projectId);
  const task = tasks.find((t) => t.id === taskId);

  const grouped = useMemo(() => {
    const f = q.trim().toLowerCase();
    const list = projects.filter((p) => !f || p.name.toLowerCase().includes(f) || (p.clientName || '').toLowerCase().includes(f));
    const groups = new Map();
    for (const p of list) { const k = p.clientName || 'Sem cliente'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects, q]);

  async function expand(pid) {
    if (expanded === pid) { setExpanded(null); return; }
    setExpanded(pid);
    if (!taskLists[pid]) {
      const t = await cached(`${workspace.id}:tasks:${pid}`, () => endpoints.tasks(workspace.id, pid, { 'is-active': true }));
      setTaskLists((m) => ({ ...m, [pid]: t }));
    }
  }

  async function createProject() {
    const name = q.trim(); if (!name) return;
    const p = await api.post(`/workspaces/${workspace.id}/projects`, { name });
    invalidateCache(workspace.id);
    cache.set(`${workspace.id}:projects:false`, Promise.resolve([...projects, p]));
    onChange(p.id, null); setOpen(false); setQ('');
  }

  const canCreate = allowCreate && (isAdmin || settings.onlyAdminsCreateProject === false || settings.entityCreationPermissions?.whoCanCreateProjectsAndClients === 'EVERYONE');
  return (
    <div className="picker" ref={ref}>
      <button type="button" className={`pick-btn ${project ? '' : 'placeholder'}`} onClick={() => setOpen((o) => !o)} title={project ? `${project.name}${task ? `: ${task.name}` : ''}` : placeholder}>
        {project ? <><span className="dot" style={{ background: project.color }} /><span className="truncate" style={{ color: project.color }}>{project.name}{task ? <span style={{ color: '#333' }}>: {task.name}</span> : ''}</span>{!compact && project.clientName && <span className="light truncate"> – {project.clientName}</span>}</> : <>+ {placeholder}</>}
      </button>
      {open && (
        <div className="panel">
          <input autoFocus placeholder="Buscar projeto ou cliente…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="list">
            {projectId && <div className="opt" onClick={() => { onChange(null, null); setOpen(false); }}><span className="light">✕ Sem projeto</span></div>}
            {grouped.map(([client, list]) => (
              <div key={client}>
                <div className="group">{client}</div>
                {list.map((p) => (
                  <div key={p.id}>
                    <div className={`opt ${p.id === projectId ? 'active' : ''}`} onClick={() => { onChange(p.id, null); setOpen(false); setQ(''); }}>
                      <span className="dot" style={{ background: p.color }} />
                      <span className="grow truncate">{p.name}</span>
                      <button type="button" className="btn ghost sm" onClick={(e) => { e.stopPropagation(); expand(p.id); }} title="Tarefas">{expanded === p.id ? '▾' : '▸'}</button>
                    </div>
                    {expanded === p.id && (taskLists[p.id] || []).map((t) => (
                      <div key={t.id} className={`opt sub ${t.id === taskId ? 'active' : ''}`} onClick={() => { onChange(p.id, t.id); setOpen(false); setQ(''); }}>{t.name}</div>
                    ))}
                    {expanded === p.id && taskLists[p.id] && taskLists[p.id].length === 0 && <div className="opt sub light">Sem tarefas</div>}
                  </div>
                ))}
              </div>
            ))}
            {grouped.length === 0 && <div className="opt light">Nenhum projeto encontrado</div>}
          </div>
          {canCreate && q.trim() && !projects.some((p) => p.name.toLowerCase() === q.trim().toLowerCase()) && <div className="foot"><button type="button" className="btn link" onClick={createProject}>+ Criar projeto “{q.trim()}”</button></div>}
        </div>
      )}
    </div>
  );
}

// Multi tag picker -----------------------------------------------------------------
// Like Clockify: the tags checked when the panel opens come first, then all the others in alphabetical order; the
// search covers every tag of the workspace.
export function TagPicker({ tagIds = [], onChange, allowCreate = true, label = 'Etiquetas' }) {
  const { workspace, isAdmin, settings, toast } = useStore();
  const wsId = workspace?.id;
  const [tags, loading, setTags] = useTagList(wsId);
  const { open, setOpen, ref } = usePanel();
  const [q, setQ] = useState('');
  const [pinned, setPinned] = useState([]); // checked when the panel opened (kept in place while it is open)
  const [extra, setExtra] = useState([]); // checked tags missing from the active list (archived)
  const sorted = useMemo(() => [...tags].sort((a, b) => collator.compare(a.name, b.name)), [tags]);
  const known = useMemo(() => new Map([...extra, ...tags].map((t) => [t.id, t])), [tags, extra]);
  const selected = tagIds.map((id) => known.get(id)).filter(Boolean);

  const missingKey = loading ? '' : tagIds.filter((id) => !known.has(id)).join(',');
  useEffect(() => {
    if (!missingKey || !wsId) return undefined;
    let alive = true;
    Promise.all(missingKey.split(',').map((id) => cached(`${wsId}:tag:${id}`, () => api.get(`/workspaces/${wsId}/tags/${id}`)).catch(() => null)))
      .then((found) => { if (alive) setExtra((prev) => [...prev, ...found.filter(Boolean)]); });
    return () => { alive = false; };
  }, [missingKey, wsId]);

  const term = norm(q.trim());
  const matches = (t) => !term || norm(t.name).includes(term);
  const first = pinned.map((id) => known.get(id)).filter((t) => t && matches(t)).sort((a, b) => collator.compare(a.name, b.name));
  const pinnedSet = new Set(pinned);
  const rest = sorted.filter((t) => !pinnedSet.has(t.id) && matches(t));
  const shown = rest.slice(0, MAX_OPTIONS);

  const toggle = (id) => onChange(tagIds.includes(id) ? tagIds.filter((x) => x !== id) : [...tagIds, id]);
  const canCreate = allowCreate && (isAdmin || settings.onlyAdminsCreateTag === false || settings.entityCreationPermissions?.whoCanCreateTags === 'EVERYONE');
  const exists = q.trim() && tags.some((t) => norm(t.name) === term);
  const creating = useRef(false);
  async function create() {
    if (creating.current) return;
    creating.current = true;
    try {
      const t = await api.post(`/workspaces/${wsId}/tags`, { name: q.trim() });
      setTags([...tags, t]);
      onChange([...tagIds, t.id]); setQ('');
    } catch (e) { toast(errorMessage(e), 'error'); } finally { creating.current = false; }
  }
  function toggleOpen() {
    if (!open) { setPinned(tagIds); setQ(''); }
    setOpen(!open);
  }
  const option = (t) => (
    <div key={t.id} className="opt" onClick={() => toggle(t.id)}>
      <span className={`check ${tagIds.includes(t.id) ? 'on' : ''}`}>{tagIds.includes(t.id) ? '✓' : ''}</span>
      <span className="truncate">{t.name}</span>{t.archived && <span className="light small">(arquivada)</span>}
    </div>
  );
  return (
    <div className="picker" ref={ref}>
      <button type="button" className={`pick-btn ${selected.length ? '' : 'placeholder'}`} onClick={toggleOpen} title={selected.map((t) => t.name).join(', ')}>
        {selected.length ? <span className="tag-list">{selected.slice(0, 3).map((t) => <span key={t.id} className="chip">{t.name}</span>)}{selected.length > 3 && <span className="chip">+{selected.length - 3}</span>}</span> : <>🏷 {label}</>}
      </button>
      {open && (
        <div className="panel">
          <input autoFocus placeholder="Buscar etiqueta…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && canCreate && q.trim() && !exists && !first.length && !rest.length) create(); }} />
          <div className="list">
            {loading && !tags.length && <div className="opt light">Carregando etiquetas…</div>}
            {first.length > 0 && <><div className="group">Selecionadas</div>{first.map(option)}</>}
            {first.length > 0 && shown.length > 0 && <div className="group">Todas as etiquetas</div>}
            {shown.map(option)}
            {!loading && !first.length && !rest.length && <div className="opt light">Nenhuma etiqueta{q.trim() ? ` com “${q.trim()}”` : ''}</div>}
            {rest.length > shown.length && <div className="opt light small">Mostrando {shown.length} de {rest.length}. Digite para encontrar as demais.</div>}
          </div>
          {canCreate && q.trim() && !exists && <div className="foot"><button type="button" className="btn link" onClick={create}>+ Criar etiqueta “{q.trim()}”</button></div>}
        </div>
      )}
    </div>
  );
}

// Generic multi-select picker (users, clients, ...) ---------------------------------
export function MultiPicker({ options, value = [], onChange, label, getLabel = (o) => o.name, getId = (o) => o.id, single = false, width }) {
  const { open, setOpen, ref } = usePanel();
  const [q, setQ] = useState('');
  const [pinned, setPinned] = useState([]); // selected when the panel opened: listed first
  const selected = options.filter((o) => value.includes(getId(o)));
  const term = norm(q.trim());
  const matching = options.filter((o) => !term || norm(getLabel(o)).includes(term));
  const filtered = [...matching.filter((o) => pinned.includes(getId(o))), ...matching.filter((o) => !pinned.includes(getId(o)))];
  const shown = filtered.slice(0, Math.max(MAX_OPTIONS, pinned.length));
  const toggle = (id) => {
    if (single) { onChange(value.includes(id) ? [] : [id]); setOpen(false); return; }
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };
  return (
    <div className="picker" ref={ref} style={width ? { width } : undefined}>
      <button type="button" className="pick-btn" style={{ border: '1px solid var(--border-strong)', background: '#fff', width: '100%' }} onClick={() => { if (!open) { setPinned(value); setQ(''); } setOpen(!open); }}>
        <span className="truncate grow" style={{ textAlign: 'left' }}>{selected.length ? selected.map(getLabel).join(', ') : <span className="muted">{label}</span>}</span><span className="light">▾</span>
      </button>
      {open && (
        <div className="panel">
          <input autoFocus placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="list">
            {!single && filtered.length > 1 && <div className="opt small" onClick={() => onChange(value.length === options.length ? [] : options.map(getId))}><span className={`check ${value.length === options.length ? 'on' : ''}`}>{value.length === options.length ? '✓' : ''}</span>Selecionar todos</div>}
            {shown.map((o) => { const id = getId(o); return <div key={id} className="opt" onClick={() => toggle(id)}><span className={`check ${value.includes(id) ? 'on' : ''}`}>{value.includes(id) ? '✓' : ''}</span><span className="truncate">{getLabel(o)}</span></div>; })}
            {!filtered.length && <div className="opt light">Nada encontrado</div>}
            {filtered.length > shown.length && <div className="opt light small">Mostrando {shown.length} de {filtered.length}. Digite para encontrar os demais.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
