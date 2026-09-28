import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { api, endpoints } from '../api.js';
import { Spinner, Alert, Empty } from '../components/ui.jsx';
import { useAsync } from '../lib/hooks.js';
import { errorMessage } from '../lib/format.js';

const ICONS = { APPROVAL: '✓', TIME_OFF: '🌴', SCHEDULE: '🗓', ALERT: '🔔', REMINDER: '⏰', INVOICE: '🧾', EXPENSE: '💳', PROJECT: '▣', SYSTEM: 'ℹ' };
const LINKS = { APPROVAL: '/approvals', TIME_OFF: '/time-off', SCHEDULE: '/schedule', INVOICE: '/invoices', EXPENSE: '/expenses', ALERT: '/alerts', PROJECT: '/projects' };

export default function Notifications() {
  const { toast } = useStore();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const { data, loading, error, reload, setData } = useAsync(() => endpoints.notifications({ 'page-size': 100, unread: onlyUnread || undefined }), [onlyUnread]);
  const list = data?.notifications || [];

  async function markRead(ids) {
    try {
      await api.post('/user/notifications/read', ids ? { ids } : {});
      setData((d) => d && { unreadCount: ids ? Math.max(0, d.unreadCount - ids.length) : 0, notifications: d.notifications.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)) });
      if (!ids) toast('Todas as notificações marcadas como lidas', 'success');
    } catch (e) { toast(errorMessage(e), 'error'); reload(); }
  }
  const typeKey = (t) => Object.keys(ICONS).find((k) => String(t || '').toUpperCase().includes(k)) || 'SYSTEM';
  const linkOf = (n) => n.payload?.url || n.payload?.link || (n.payload?.projectId ? `/projects/${n.payload.projectId}` : LINKS[typeKey(n.type)]) || null;

  return (
    <div>
      <div className="page-header">
        <h1>Notificações</h1>
        {data && data.unreadCount > 0 && <span className="badge primary">{data.unreadCount} não lida(s)</span>}
        <div className="right row gap">
          <label className="checkbox" style={{ marginBottom: 0 }}><input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} /> Somente não lidas</label>
          <button className="btn secondary" disabled={!data || data.unreadCount === 0} onClick={() => markRead(null)}>Marcar todas como lidas</button>
        </div>
      </div>
      {error && <Alert type="error">{errorMessage(error)}</Alert>}
      <div className="card">
        {loading && !data ? <Spinner block /> : list.length === 0 ? <Empty icon="🔔" title={onlyUnread ? 'Nenhuma notificação não lida' : 'Nenhuma notificação'}>Aprovações, folgas, alertas e lembretes aparecerão aqui.</Empty> : (
          <div>
            {list.map((n) => {
              const k = typeKey(n.type); const link = linkOf(n);
              return (
                <div key={n.id} className={`notif ${n.read ? '' : 'unread'}`} onClick={() => !n.read && markRead([n.id])}>
                  <span className="notif-ico">{ICONS[k]}</span>
                  <div className="grow">
                    <div className="row gap"><span className="bold">{n.title}</span>{!n.read && <span className="badge primary">Nova</span>}<span className="light small right nowrap">{new Date(n.createdAt).toLocaleString('pt-BR')}</span></div>
                    {n.body && <div className="muted small mt" style={{ whiteSpace: 'pre-line' }}>{n.body}</div>}
                    {link && <div className="mt"><Link to={link} className="small" onClick={(e) => e.stopPropagation()}>Abrir →</Link></div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
