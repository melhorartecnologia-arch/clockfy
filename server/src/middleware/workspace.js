import { one, rows } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';
import { DEFAULT_WORKSPACE_SETTINGS, mergeSettings } from '../lib/settings.js';

// Loads the workspace, the caller's membership and roles, and exposes permission helpers on req.ctx
export async function loadWorkspace(req, res, next) {
  try {
    const id = req.params.workspaceId;
    const ws = await one('SELECT * FROM workspaces WHERE id = $1', [id]);
    if (!ws) throw notFound('Workspace not found', 404);
    const member = await one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [id, req.user.id]);
    if (!member && !req.user.is_super_admin) throw forbidden("You don't have access to this workspace", 403);
    const roleRows = await rows('SELECT role, entity_id, source_type FROM roles WHERE workspace_id = $1 AND user_id = $2', [id, req.user.id]);
    req.ctx = buildContext({ workspace: ws, user: req.user, member, roleRows });
    req.workspace = ws;
    next();
  } catch (err) { next(err); }
}

export function buildContext({ workspace, user, member, roleRows }) {
  const settings = mergeSettings(DEFAULT_WORKSPACE_SETTINGS, workspace.settings);
  const isOwner = workspace.owner_id === user.id;
  const isAdmin = isOwner || user.is_super_admin || roleRows.some((r) => r.role === 'WORKSPACE_ADMIN' || r.role === 'OWNER');
  const managedProjects = new Set(roleRows.filter((r) => r.role === 'PROJECT_MANAGER').map((r) => r.entity_id));
  const managedTargets = new Set(roleRows.filter((r) => r.role === 'TEAM_MANAGER').map((r) => r.entity_id));
  const ctx = {
    workspace, settings, user, member, roles: roleRows,
    isOwner, isAdmin,
    isProjectManager: managedProjects.size > 0,
    isTeamManager: managedTargets.size > 0,
    managedProjects, managedTargets,
    managesProject: (projectId) => isAdmin || managedProjects.has(projectId),
    // Team managers manage users directly or via group ids; callers pass the user's group ids when known
    managesUser: (userId, groupIds = []) => isAdmin || userId === user.id || managedTargets.has(userId) || groupIds.some((g) => managedTargets.has(g)),
    requireAdmin() { if (!isAdmin) throw forbidden('Only workspace admins can do this', 403); },
    requireProjectManager(projectId) { if (!ctx.managesProject(projectId)) throw forbidden('Only admins or project managers can do this', 403); },
    requireManager() { if (!(isAdmin || managedProjects.size || managedTargets.size)) throw forbidden('Only admins or managers can do this', 403); },
    canCreate(kind) {
      if (isAdmin) return true;
      const perms = settings.entityCreationPermissions || {};
      const key = { project: 'whoCanCreateProjectsAndClients', client: 'whoCanCreateProjectsAndClients', tag: 'whoCanCreateTags', task: 'whoCanCreateTasks' }[kind];
      const rule = perms[key] || 'ADMINS';
      if (kind === 'project' && settings.onlyAdminsCreateProject === false) return true;
      if (kind === 'tag' && settings.onlyAdminsCreateTag === false && rule === 'ADMINS') return true;
      if (kind === 'task' && settings.onlyAdminsCreateTask === false && rule === 'ADMINS') return true;
      if (rule === 'EVERYONE') return true;
      if (rule === 'ADMINS_AND_PROJECT_MANAGERS') return managedProjects.size > 0;
      return false;
    },
  };
  return ctx;
}

// Returns the ids of users whose data the caller can see/manage in this workspace
export async function visibleUserIds(ctx) {
  const wsId = ctx.workspace.id;
  if (ctx.isAdmin) return null; // null = everyone
  const set = new Set([ctx.user.id]);
  if (ctx.managedTargets.size) {
    const ids = [...ctx.managedTargets];
    const direct = await rows('SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)', [wsId, ids]);
    direct.forEach((r) => set.add(r.user_id));
    const viaGroup = await rows('SELECT user_id FROM user_group_members WHERE group_id = ANY($1)', [ids]);
    viaGroup.forEach((r) => set.add(r.user_id));
  }
  if (ctx.managedProjects.size) {
    const pm = await rows(
      `SELECT DISTINCT user_id FROM time_entries WHERE workspace_id = $1 AND project_id = ANY($2) AND deleted_at IS NULL`,
      [wsId, [...ctx.managedProjects]],
    );
    pm.forEach((r) => set.add(r.user_id));
    const members = await rows(`SELECT target_id AS user_id FROM project_members WHERE project_id = ANY($1) AND target_type = 'USER'`, [[...ctx.managedProjects]]);
    members.forEach((r) => set.add(r.user_id));
  }
  return [...set];
}

export async function userGroupIds(workspaceId, userId) {
  const r = await rows('SELECT g.id FROM user_groups g JOIN user_group_members m ON m.group_id = g.id WHERE g.workspace_id = $1 AND m.user_id = $2', [workspaceId, userId]);
  return r.map((x) => x.id);
}
