import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, endpoints } from '../api.js';
import { useStore } from '../store.jsx';

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
export function useTags(workspaceId) {
  const [list, setList] = useState([]);
  useEffect(() => { if (!workspaceId) return; cached(`${workspaceId}:tags`, () => endpoints.tags(workspaceId, { archived: false })).then(setList).catch(() => setList([])); }, [workspaceId]);
  return list;
}
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
export function TagPicker({ tagIds = [], onChange, allowCreate = true, label = 'Etiquetas' }) {
  const { workspace, isAdmin, settings } = useStore();
  const tags = useTags(workspace?.id);
  const { open, setOpen, ref } = usePanel();
  const [q, setQ] = useState('');
  const selected = tags.filter((t) => tagIds.includes(t.id));
  const filtered = tags.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => onChange(tagIds.includes(id) ? tagIds.filter((x) => x !== id) : [...tagIds, id]);
  const canCreate = allowCreate && (isAdmin || settings.onlyAdminsCreateTag === false || settings.entityCreationPermissions?.whoCanCreateTags === 'EVERYONE');
  async function create() {
    const t = await api.post(`/workspaces/${workspace.id}/tags`, { name: q.trim() });
    cache.set(`${workspace.id}:tags`, Promise.resolve([...tags, t]));
    onChange([...tagIds, t.id]); setQ('');
  }
  return (
    <div className="picker" ref={ref}>
      <button type="button" className={`pick-btn ${selected.length ? '' : 'placeholder'}`} onClick={() => setOpen((o) => !o)} title={selected.map((t) => t.name).join(', ')}>
        {selected.length ? <span className="tag-list">{selected.slice(0, 3).map((t) => <span key={t.id} className="chip">{t.name}</span>)}{selected.length > 3 && <span className="chip">+{selected.length - 3}</span>}</span> : <>🏷 {label}</>}
      </button>
      {open && (
        <div className="panel">
          <input autoFocus placeholder="Buscar etiqueta…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && canCreate && q.trim() && !filtered.length) create(); }} />
          <div className="list">
            {filtered.map((t) => <div key={t.id} className="opt" onClick={() => toggle(t.id)}><span className={`check ${tagIds.includes(t.id) ? 'on' : ''}`}>{tagIds.includes(t.id) ? '✓' : ''}</span>{t.name}</div>)}
            {!filtered.length && <div className="opt light">Nenhuma etiqueta</div>}
          </div>
          {canCreate && q.trim() && !tags.some((t) => t.name.toLowerCase() === q.trim().toLowerCase()) && <div className="foot"><button type="button" className="btn link" onClick={create}>+ Criar etiqueta “{q.trim()}”</button></div>}
        </div>
      )}
    </div>
  );
}

// Generic multi-select picker (users, clients, ...) ---------------------------------
export function MultiPicker({ options, value = [], onChange, label, getLabel = (o) => o.name, getId = (o) => o.id, single = false, width }) {
  const { open, setOpen, ref } = usePanel();
  const [q, setQ] = useState('');
  const selected = options.filter((o) => value.includes(getId(o)));
  const filtered = options.filter((o) => !q || getLabel(o).toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => {
    if (single) { onChange(value.includes(id) ? [] : [id]); setOpen(false); return; }
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };
  return (
    <div className="picker" ref={ref} style={width ? { width } : undefined}>
      <button type="button" className="pick-btn" style={{ border: '1px solid var(--border-strong)', background: '#fff', width: '100%' }} onClick={() => setOpen((o) => !o)}>
        <span className="truncate grow" style={{ textAlign: 'left' }}>{selected.length ? selected.map(getLabel).join(', ') : <span className="muted">{label}</span>}</span><span className="light">▾</span>
      </button>
      {open && (
        <div className="panel">
          <input autoFocus placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="list">
            {!single && filtered.length > 1 && <div className="opt small" onClick={() => onChange(value.length === options.length ? [] : options.map(getId))}><span className={`check ${value.length === options.length ? 'on' : ''}`}>{value.length === options.length ? '✓' : ''}</span>Selecionar todos</div>}
            {filtered.map((o) => { const id = getId(o); return <div key={id} className="opt" onClick={() => toggle(id)}><span className={`check ${value.includes(id) ? 'on' : ''}`}>{value.includes(id) ? '✓' : ''}</span><span className="truncate">{getLabel(o)}</span></div>; })}
            {!filtered.length && <div className="opt light">Nada encontrado</div>}
          </div>
        </div>
      )}
    </div>
  );
}
