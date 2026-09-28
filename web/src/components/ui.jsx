import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.jsx';

export function Spinner({ block }) {
  return block ? <div className="loading-block"><span className="spinner" /></div> : <span className="spinner" />;
}

export function Empty({ icon = '◷', title, children }) {
  return <div className="empty"><div className="big">{icon}</div><div className="bold">{title}</div><div className="small mt">{children}</div></div>;
}

export function Alert({ type = 'info', children }) { return children ? <div className={`alert ${type}`}>{children}</div> : null; }

export function Modal({ title, children, onClose, footer, size = '' }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true">
        {title && <div className="modal-head"><h2>{title}</h2><button className="btn ghost icon right" onClick={onClose} aria-label="Fechar">✕</button></div>}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({ title = 'Confirmar', message, confirmLabel = 'Confirmar', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} size="sm" footer={<>
      <button className="btn ghost" onClick={onClose}>Cancelar</button>
      <button className={`btn ${danger ? 'danger' : ''}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{confirmLabel}</button>
    </>}>
      <p>{message}</p>
    </Modal>
  );
}

export function Dropdown({ label = '⋮', children, align = '', className = 'ghost icon' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className={`btn ${className}`} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && <div className={`menu ${align}`} onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

export function Toasts() {
  const { toasts } = useStore();
  return <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>)}</div>;
}

export function Switch({ value, onChange, disabled }) {
  return <div className={`switch ${value ? 'on' : ''}`} role="switch" aria-checked={!!value} onClick={() => !disabled && onChange(!value)} style={disabled ? { opacity: .5 } : undefined} />;
}

export function SettingRow({ title, desc, children }) {
  return <div className="setting-row"><div className="info"><div className="title">{title}</div>{desc && <div className="desc">{desc}</div>}</div><div>{children}</div></div>;
}

export function Avatar({ user, size = 30 }) {
  const name = user?.name || user?.userName || user?.email || '?';
  const initials = name.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const img = user?.profilePicture || user?.imageUrl;
  return <span className="avatar" style={{ width: size, height: size }} title={name}>{img ? <img src={img} alt={name} /> : initials}</span>;
}

export function ProjectLabel({ project, task, size }) {
  if (!project) return <span className="light">Sem projeto</span>;
  return (
    <span className="proj-label" style={size ? { fontSize: size } : undefined}>
      <span className="dot" style={{ background: project.color || '#999' }} />
      <span className="truncate"><span className="name" style={{ color: project.color }}>{project.name}</span>{task && <span>: {task.name}</span>}{project.clientName && <span className="client"> – {project.clientName}</span>}</span>
    </span>
  );
}

export function Pagination({ page, pageSize, count, onChange }) {
  const hasNext = count == null ? true : page * pageSize < count;
  return (
    <div className="pagination">
      <span className="muted small">Página {page}{count != null ? ` de ${Math.max(1, Math.ceil(count / pageSize))}` : ''}</span>
      <button className="btn ghost sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>‹ Anterior</button>
      <button className="btn ghost sm" disabled={!hasNext} onClick={() => onChange(page + 1)}>Próxima ›</button>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return <div className="tabs">{tabs.map((t) => <button key={t.value} type="button" className={t.value === value ? 'active' : ''} onClick={() => onChange(t.value)}>{t.label}</button>)}</div>;
}

export function ColorPicker({ value, onChange }) {
  const COLORS = ['#03A9F4', '#8BC34A', '#F44336', '#FF9800', '#9C27B0', '#3F51B5', '#009688', '#795548', '#E91E63', '#607D8B', '#FFC107', '#4CAF50', '#00BCD4', '#673AB7', '#CDDC39', '#FF5722'];
  return <div className="row wrap gap">{COLORS.map((c) => <span key={c} className={`color-swatch ${value?.toUpperCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} />)}</div>;
}

export function DateRangePicker({ start, end, onChange }) {
  return (
    <span className="row gap">
      <input type="date" value={start} onChange={(e) => onChange(e.target.value, end)} style={{ width: 150 }} />
      <span className="muted">–</span>
      <input type="date" value={end} onChange={(e) => onChange(start, e.target.value)} style={{ width: 150 }} />
    </span>
  );
}

export function Money({ cents, currency }) {
  const { currency: def } = useStore();
  const v = (Number(cents) || 0) / 100;
  let s;
  try { s = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency || def || 'USD' }).format(v); } catch { s = v.toFixed(2); }
  return <span className="mono">{s}</span>;
}
