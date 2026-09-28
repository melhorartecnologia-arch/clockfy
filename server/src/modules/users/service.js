import { one, rows, query } from '../../lib/db.js';
import { userDto } from '../../lib/dto.js';

export async function getUserDto(userId, { includeMemberships = true } = {}) {
  const u = await one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!u) return null;
  const memberships = includeMemberships ? await rows("SELECT * FROM workspace_members WHERE user_id = $1 AND status <> 'DECLINED'", [userId]) : [];
  const customFields = await rows(
    "SELECT v.custom_field_id, f.name, f.type, v.value, v.entity_id AS user_id FROM custom_field_values v JOIN custom_fields f ON f.id = v.custom_field_id WHERE v.entity_type = 'USER' AND v.entity_id = $1",
    [userId],
  );
  return userDto(u, {
    memberships,
    customFields: customFields.map((c) => ({ customFieldId: c.custom_field_id, customFieldName: c.name, customFieldType: c.type, userId: c.user_id, value: c.value })),
  });
}

export async function listWorkspaceUsers(workspaceId, {
  email, name, status = 'ACTIVE', accountStatuses, projectId, userGroups, roles, sortColumn = 'NAME', sortOrder = 'ASC', limit = 50, offset = 0, includeRoles = false, userIds,
} = {}) {
  const conds = ['m.workspace_id = $1'];
  const params = [workspaceId];
  if (status && status !== 'ALL') { params.push(status); conds.push(`m.status = $${params.length}`); }
  if (email) { params.push(`%${email.toLowerCase()}%`); conds.push(`lower(u.email) LIKE $${params.length}`); }
  if (name) { params.push(`%${name.toLowerCase()}%`); conds.push(`lower(u.name) LIKE $${params.length}`); }
  if (accountStatuses && accountStatuses.length) { params.push(accountStatuses); conds.push(`u.status = ANY($${params.length})`); }
  if (userIds) { params.push(userIds); conds.push(`u.id = ANY($${params.length})`); }
  if (projectId) {
    params.push(projectId);
    conds.push(`(EXISTS (SELECT 1 FROM projects p WHERE p.id = $${params.length} AND p.is_public) OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $${params.length} AND ((pm.target_type = 'USER' AND pm.target_id = u.id) OR (pm.target_type = 'USERGROUP' AND pm.target_id IN (SELECT group_id FROM user_group_members WHERE user_id = u.id)))))`);
  }
  if (userGroups && userGroups.length) { params.push(userGroups); conds.push(`EXISTS (SELECT 1 FROM user_group_members gm WHERE gm.user_id = u.id AND gm.group_id = ANY($${params.length}))`); }
  if (roles && roles.length) { params.push(roles); conds.push(`EXISTS (SELECT 1 FROM roles r WHERE r.user_id = u.id AND r.workspace_id = m.workspace_id AND r.role = ANY($${params.length}))`); }
  const orderMap = { ID: 'u.id', EMAIL: 'lower(u.email)', NAME: 'lower(u.name)', NAME_LOWERCASE: 'lower(u.name)', ACCESS: 'm.status', HOURLYRATE: 'm.hourly_rate_amount', COSTRATE: 'm.cost_rate_amount' };
  const order = `${orderMap[sortColumn] || 'lower(u.name)'} ${sortOrder === 'DESC' ? 'DESC' : 'ASC'}`;
  params.push(limit, offset);
  const list = await rows(
    `SELECT u.*, m.status AS member_status, m.hourly_rate_amount AS m_hourly, m.hourly_rate_currency AS m_currency, m.cost_rate_amount AS m_cost, m.week_start, m.working_days, m.work_capacity, m.joined_at, m.invited_at
     FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const ids = list.map((u) => u.id);
  const roleRows = includeRoles && ids.length ? await rows('SELECT user_id, role, entity_id, source_type FROM roles WHERE workspace_id = $1 AND user_id = ANY($2)', [workspaceId, ids]) : [];
  const cfRows = ids.length ? await rows("SELECT v.entity_id AS user_id, v.custom_field_id, f.name, f.type, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.custom_field_id WHERE v.entity_type = 'USER' AND v.entity_id = ANY($1)", [ids]) : [];
  return list.map((u) => {
    const membership = { user_id: u.id, workspace_id: workspaceId, status: u.member_status, hourly_rate_amount: u.m_hourly, hourly_rate_currency: u.m_currency, cost_rate_amount: u.m_cost };
    const dto = userDto({ ...u, roles: includeRoles ? roleRows.filter((r) => r.user_id === u.id).map((r) => ({ role: r.role, entityId: r.entity_id, sourceType: r.source_type })) : undefined }, {
      memberships: [membership],
      customFields: cfRows.filter((c) => c.user_id === u.id).map((c) => ({ customFieldId: c.custom_field_id, customFieldName: c.name, customFieldType: c.type, userId: u.id, value: c.value })),
      includeSettings: false,
    });
    dto.memberStatus = u.member_status;
    dto.hourlyRate = membership.hourly_rate_amount == null ? null : { amount: membership.hourly_rate_amount, currency: membership.hourly_rate_currency || 'USD' };
    dto.costRate = membership.cost_rate_amount == null ? null : { amount: membership.cost_rate_amount, currency: membership.hourly_rate_currency || 'USD' };
    dto.weekStart = u.week_start || dto.settings?.weekStart;
    dto.workingDays = u.working_days || null;
    dto.workCapacity = u.work_capacity || null;
    dto.joinedAt = u.joined_at;
    delete dto.settings;
    return dto;
  });
}

export async function countWorkspaceUsers(workspaceId, status = 'ACTIVE') {
  const r = await one(`SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1 ${status && status !== 'ALL' ? 'AND status = $2' : ''}`, status && status !== 'ALL' ? [workspaceId, status] : [workspaceId]);
  return r.c;
}

export async function userRolesInWorkspace(workspaceId, userId) {
  return rows('SELECT role, entity_id, source_type FROM roles WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
}

export async function isMember(workspaceId, userId) {
  return !!(await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]));
}

export async function touchUserSettings(userId, patch) {
  const u = await one('SELECT settings FROM users WHERE id = $1', [userId]);
  const settings = { ...(u?.settings || {}), ...patch };
  await query('UPDATE users SET settings = $2 WHERE id = $1', [userId, JSON.stringify(settings)]);
  return settings;
}
