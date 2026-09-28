import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useStore } from '../store.jsx';
import { Dropdown, Avatar, Toasts } from './ui.jsx';
import { api, endpoints } from '../api.js';

const NAV = [
  { section: 'Registrar', items: [
    { to: '/tracker', label: 'Controle de tempo', ico: '⏱' },
    { to: '/timesheet', label: 'Planilha de horas', ico: '▦' },
    { to: '/calendar', label: 'Calendário', ico: '📅' },
  ] },
  { section: 'Analisar', items: [
    { to: '/dashboard', label: 'Painel', ico: '◔' },
    { to: '/reports', label: 'Relatórios', ico: '▤' },
  ] },
  { section: 'Gerenciar', items: [
    { to: '/schedule', label: 'Agenda', ico: '🗓', feature: 'schedulingEnabled' },
    { to: '/approvals', label: 'Aprovações', ico: '✓', feature: 'approvalsEnabled' },
    { to: '/time-off', label: 'Folgas', ico: '🌴', feature: 'timeOffEnabled' },
    { to: '/expenses', label: 'Despesas', ico: '💳', feature: 'expensesEnabled' },
    { to: '/invoices', label: 'Faturas', ico: '🧾', feature: 'invoicingEnabled', admin: true },
    { to: '/projects', label: 'Projetos', ico: '▣' },
    { to: '/team', label: 'Equipe', ico: '👥' },
    { to: '/clients', label: 'Clientes', ico: '🏢' },
    { to: '/tags', label: 'Etiquetas', ico: '🏷' },
  ] },
  { section: 'Administração', admin: true, items: [
    { to: '/settings', label: 'Configurações', ico: '⚙' },
    { to: '/kiosks', label: 'Quiosque', ico: '🖥' },
    { to: '/webhooks', label: 'Webhooks', ico: '🔗' },
    { to: '/alerts', label: 'Alertas e lembretes', ico: '🔔' },
    { to: '/audit-log', label: 'Log de auditoria', ico: '📜' },
    { to: '/import', label: 'Importar do Clockify', ico: '⇩' },
  ] },
];

export default function Layout() {
  const { user, workspace, workspaces, settings, isAdmin, logout, switchWorkspace, toast } = useStore();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    const load = () => endpoints.notifications({ 'page-size': 1 }).then((r) => alive && setUnread(r.unreadCount)).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [workspace?.id]);

  const adminPages = new Set(settings.adminOnlyPages || []);
  const visible = (item) => {
    if (item.admin && !isAdmin) return false;
    if (item.feature && settings[item.feature] === false) return false;
    if (!isAdmin) {
      if (item.to === '/projects' && adminPages.has('PROJECT')) return false;
      if (item.to === '/team' && adminPages.has('TEAM')) return false;
      if (item.to === '/reports' && adminPages.has('REPORTS')) return false;
      if (item.to === '/timesheet' && settings.canSeeTimeSheet === false) return false;
      if (item.to === '/tracker' && settings.canSeeTracker === false) return false;
      if (item.to === '/dashboard' && settings.onlyAdminsSeeDashboard) return false;
    }
    return true;
  };

  async function createWorkspace() {
    const name = window.prompt('Nome do novo workspace');
    if (!name) return;
    const w = await api.post('/workspaces', { name });
    await switchWorkspace(w.id);
    toast('Workspace criado');
    navigate('/tracker');
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn ghost icon" onClick={() => setOpen((o) => !o)} aria-label="Menu">☰</button>
        <NavLink to="/tracker" className="logo"><img src="/favicon.svg" alt="" />Clockfy</NavLink>
        <select className="ws" value={workspace?.id || ''} onChange={(e) => (e.target.value === '__new' ? createWorkspace() : switchWorkspace(e.target.value))}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          <option value="__new">+ Novo workspace</option>
        </select>
        <div className="right row gap">
          <NavLink to="/notifications" className="btn ghost icon" title="Notificações">🔔{unread > 0 && <span className="badge primary">{unread}</span>}</NavLink>
          <Dropdown label={<Avatar user={user} />} className="ghost icon">
            <div style={{ padding: '8px 14px' }} className="small"><div className="bold">{user?.name}</div><div className="muted">{user?.email}</div></div>
            <hr />
            <NavLink to="/profile">Perfil e preferências</NavLink>
            <NavLink to="/profile#api">Chaves de API</NavLink>
            <hr />
            <button onClick={() => { logout(); navigate('/login'); }}>Sair</button>
          </Dropdown>
        </div>
      </header>
      <nav className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        {NAV.filter((s) => !s.admin || isAdmin).map((s) => (
          <div key={s.section}>
            <div className="section">{s.section}</div>
            {s.items.filter(visible).map((i) => <NavLink key={i.to} to={i.to} className={({ isActive }) => `item ${isActive ? 'active' : ''}`}><span className="ico">{i.ico}</span>{i.label}</NavLink>)}
          </div>
        ))}
      </nav>
      <main className="main"><Outlet /></main>
      <Toasts />
    </div>
  );
}
