import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, endpoints, getToken, setToken } from './api.js';

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  const [user, setUser] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(!!getToken());
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((message, type = 'info', ms = 3500) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const loadSession = useCallback(async () => {
    if (!getToken()) { setUser(null); setWorkspace(null); setWorkspaces([]); setLoading(false); return; }
    try {
      const me = await endpoints.me();
      const list = await endpoints.workspaces();
      setUser(me); setWorkspaces(list);
      const active = list.find((w) => w.id === me.activeWorkspace) || list[0] || null;
      setWorkspace(active ? await endpoints.workspace(active.id) : null);
    } catch (err) {
      if (err.status === 401) setToken(null);
      setUser(null); setWorkspace(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadSession(); }, [loadSession]);
  useEffect(() => {
    const h = () => { setUser(null); setWorkspace(null); };
    window.addEventListener('clockfy:unauthorized', h);
    return () => window.removeEventListener('clockfy:unauthorized', h);
  }, []);

  const login = useCallback(async (email, password) => {
    const r = await endpoints.login(email, password);
    setToken(r.token); setLoading(true);
    await loadSession();
    return r;
  }, [loadSession]);

  const register = useCallback(async (data) => {
    const r = await endpoints.register(data);
    setToken(r.token); setLoading(true);
    await loadSession();
    return r;
  }, [loadSession]);

  const acceptSession = useCallback(async (token) => { setToken(token); setLoading(true); await loadSession(); }, [loadSession]);

  const logout = useCallback(() => { setToken(null); setUser(null); setWorkspace(null); setWorkspaces([]); }, []);

  const switchWorkspace = useCallback(async (id) => {
    await api.post(`/user/active-workspace/${id}`);
    setWorkspace(await endpoints.workspace(id));
    setUser((u) => ({ ...u, activeWorkspace: id }));
  }, []);

  const refreshWorkspace = useCallback(async () => {
    if (!workspace) return;
    const w = await endpoints.workspace(workspace.id);
    setWorkspace(w);
    setWorkspaces((list) => list.map((x) => (x.id === w.id ? w : x)));
  }, [workspace]);

  const refreshUser = useCallback(async () => { setUser(await endpoints.me()); }, []);

  const value = useMemo(() => {
    const settings = workspace?.workspaceSettings || {};
    const userSettings = user?.settings || {};
    const membership = workspace?.memberships?.find((m) => m.userId === user?.id);
    const roles = user?.roles || [];
    const isOwner = workspace && user && workspace.ownerId === user.id;
    return {
      user, workspaces, workspace, settings, userSettings, membership, loading, toasts, toast,
      isOwner, isAdmin: !!(isOwner || user?.isAdmin || roles.some((r) => r.role === 'WORKSPACE_ADMIN')),
      login, register, logout, switchWorkspace, refreshWorkspace, refreshUser, acceptSession, setWorkspaces,
      timeZone: userSettings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekStart: userSettings.weekStart || 'MONDAY',
      timeFormat: userSettings.timeFormat || 'HOUR24',
      dateFormat: userSettings.dateFormat || 'DD/MM/YYYY',
      currency: workspace?.hourlyRate?.currency || 'USD',
    };
  }, [user, workspaces, workspace, loading, toasts, toast, login, register, logout, switchWorkspace, refreshWorkspace, refreshUser, acceptSession]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() { return useContext(StoreContext); }

// Loads workspace admin flag from roles (users list includes roles for the caller)
export function useIsAdmin() {
  const { workspace, user } = useStore();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!workspace || !user) return;
    if (workspace.ownerId === user.id) { setIsAdmin(true); return; }
    api.get(`/workspaces/${workspace.id}/users/${user.id}/roles`).then((roles) => setIsAdmin(roles.some((r) => ['WORKSPACE_ADMIN', 'OWNER'].includes(r.role.name)))).catch(() => setIsAdmin(false));
  }, [workspace, user]);
  return isAdmin;
}
