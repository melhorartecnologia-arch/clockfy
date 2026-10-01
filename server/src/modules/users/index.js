import { Router } from 'express';
import multer from 'multer';
import { one, rows, query, transaction, insert } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, list, paging, sort, int } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { loadWorkspace, userGroupIds } from '../../middleware/workspace.js';
import { getUserDto, listWorkspaceUsers, touchUserSettings } from './service.js';
import { config } from '../../config.js';
import { isValidTimeZone } from '../../lib/dates.js';
import { events } from '../../lib/events.js';
import { userDto } from '../../lib/dto.js';

export const router = Router();
router.use(authenticate);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

// Current user --------------------------------------------------------------
router.get('/user', async (req, res) => {
  res.json({ ...(await getUserDto(req.user.id, { includeMemberships: bool(req.query['include-memberships'], true) })), systemAdmin: !!req.user.is_super_admin });
});

const userPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  profilePicture: z.string().nullable().optional(),
  email: z.string().email().optional(),
  settings: z.object({}).passthrough().optional(),
  activeWorkspace: z.string().optional(),
  defaultWorkspace: z.string().optional(),
});

async function patchUser(req, res) {
  const body = parse(userPatch, req.body);
  if (body.settings?.timeZone && !isValidTimeZone(body.settings.timeZone)) throw badRequest('Invalid timeZone', 400);
  const settings = body.settings ? await touchUserSettings(req.user.id, body.settings) : undefined;
  if (body.activeWorkspace) {
    const m = await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [body.activeWorkspace, req.user.id]);
    if (!m) throw forbidden('Not a member of that workspace', 403);
  }
  if (body.email && body.email.toLowerCase() !== req.user.email.toLowerCase()) {
    const taken = await one('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [body.email.toLowerCase(), req.user.id]);
    if (taken) throw badRequest('Email already in use', 400);
  }
  await query('UPDATE users SET name = COALESCE($2, name), profile_picture = CASE WHEN $3::text IS NULL THEN profile_picture ELSE NULLIF($3, \'\') END, email = COALESCE($4, email), active_workspace_id = COALESCE($5, active_workspace_id), default_workspace_id = COALESCE($6, default_workspace_id) WHERE id = $1',
    [req.user.id, body.name || null, body.profilePicture === null ? '' : body.profilePicture ?? null, body.email ? body.email.toLowerCase() : null, body.activeWorkspace || null, body.defaultWorkspace || null]);
  if (body.email && body.email.toLowerCase() !== req.user.email.toLowerCase()) events.emitAsync('user.email_changed', { userId: req.user.id, email: body.email });
  if (body.name || settings) events.emitAsync('user.updated', { userId: req.user.id });
  res.json(await getUserDto(req.user.id));
}
router.put('/user', patchUser);
router.patch('/user', patchUser);
router.put('/user/settings', async (req, res, next) => { req.body = { settings: req.body }; patchUser(req, res).catch(next); });
router.patch('/user/settings', async (req, res, next) => { req.body = { settings: req.body }; patchUser(req, res).catch(next); });
router.post('/user/active-workspace/:workspaceId', async (req, res, next) => { req.body = { activeWorkspace: req.params.workspaceId }; patchUser(req, res).catch(next); });
router.put('/users/:userId/activeWorkspace/:workspaceId', async (req, res, next) => { if (req.params.userId !== req.user.id) return next(forbidden()); req.body = { activeWorkspace: req.params.workspaceId }; patchUser(req, res).catch(next); });

router.delete('/user', async (req, res) => {
  const owned = await rows('SELECT id, name FROM workspaces WHERE owner_id = $1', [req.user.id]);
  const withOthers = [];
  for (const w of owned) {
    const others = await one('SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1 AND user_id <> $2', [w.id, req.user.id]);
    if (others.c > 0) withOthers.push(w.name);
  }
  if (withOthers.length) throw badRequest(`Transfer ownership of workspaces with other members first: ${withOthers.join(', ')}`, 400);
  await transaction(async () => {
    for (const w of owned) await query('DELETE FROM workspaces WHERE id = $1', [w.id]);
    await query("UPDATE users SET status = 'DELETED', password_hash = NULL, email = email || '.deleted.' || id WHERE id = $1", [req.user.id]);
    await query('DELETE FROM api_keys WHERE user_id = $1', [req.user.id]);
  });
  res.status(204).end();
});

// Notifications (in-app) ----------------------------------------------------
router.get('/user/notifications', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 200 });
  const unreadOnly = bool(req.query.unread, false);
  const list = await rows(`SELECT * FROM notifications WHERE user_id = $1 ${unreadOnly ? 'AND read = false' : ''} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [req.user.id, limit, offset]);
  const unread = await one('SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND read = false', [req.user.id]);
  res.json({ unreadCount: unread.c, notifications: list.map((n) => ({ id: n.id, workspaceId: n.workspace_id, type: n.type, title: n.title, body: n.body, payload: n.payload, read: n.read, createdAt: n.created_at })) });
});
router.post('/user/notifications/read', async (req, res) => {
  const ids = list(req.body?.ids);
  if (ids.length) await query('UPDATE notifications SET read = true WHERE user_id = $1 AND id = ANY($2)', [req.user.id, ids]);
  else await query('UPDATE notifications SET read = true WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
});

// Profile picture upload -----------------------------------------------------
router.post('/file/image', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('file is required', 400);
  if (!/^image\//.test(req.file.mimetype)) throw badRequest('Only images are allowed', 400);
  const f = await insert('files', { id: newId(), user_id: req.user.id, name: req.file.originalname, mime_type: req.file.mimetype, size: req.file.size, data: req.file.buffer });
  const url = `${config.appUrl}/api/v1/files/${f.id}`;
  res.json({ name: f.name, url });
});

router.get('/files/:id', async (req, res) => {
  const f = await one('SELECT * FROM files WHERE id = $1', [req.params.id]);
  if (!f) throw notFound('File not found', 404);
  if (f.workspace_id) {
    const m = await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [f.workspace_id, req.user.id]);
    if (!m && !req.user.is_super_admin) throw forbidden();
  }
  res.set('Content-Type', f.mime_type);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
  res.send(f.data);
});

// Workspace users --------------------------------------------------------------
router.get('/workspaces/:workspaceId/users', loadWorkspace, async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const s = sort(req.query, ['NAME', 'EMAIL', 'ID', 'ACCESS', 'HOURLYRATE', 'COSTRATE', 'NAME_LOWERCASE'], 'NAME');
  const users = await listWorkspaceUsers(req.workspace.id, {
    email: req.query.email, name: req.query.name, status: String(req.query.status || 'ACTIVE').toUpperCase(),
    accountStatuses: list(req.query['account-statuses']), projectId: req.query['project-id'],
    sortColumn: s.column, sortOrder: s.order, limit, offset, includeRoles: bool(req.query['include-roles'], false),
  });
  res.json(users.map((u) => maskRates(u, req.ctx)));
});

router.post('/workspaces/:workspaceId/users/info', loadWorkspace, async (req, res) => {
  const b = req.body || {};
  const page = Math.max(1, int(b.page, 1)); const pageSize = Math.min(5000, Math.max(1, int(b.pageSize, 50)));
  const users = await listWorkspaceUsers(req.workspace.id, {
    email: b.email, name: b.name, status: String(b.status || 'ACTIVE').toUpperCase(), accountStatuses: b.accountStatuses, projectId: b.projectId,
    userGroups: b.userGroups, roles: b.roles, sortColumn: String(b.sortColumn || 'NAME').toUpperCase(), sortOrder: String(b.sortOrder || 'ASCENDING').toUpperCase() === 'DESCENDING' ? 'DESC' : 'ASC',
    limit: pageSize, offset: (page - 1) * pageSize, includeRoles: !!b.includeRoles,
  });
  res.json(users.map((u) => maskRates(u, req.ctx)));
});

function maskRates(u, ctx) {
  if (ctx.isAdmin || u.id === ctx.user.id || !ctx.settings.onlyAdminsSeeBillableRates) return u;
  u.hourlyRate = null; u.costRate = null;
  u.memberships = (u.memberships || []).map((m) => ({ ...m, hourlyRate: null, costRate: null }));
  return u;
}

router.get('/workspaces/:workspaceId/users/:userId', loadWorkspace, async (req, res) => {
  const [u] = await listWorkspaceUsers(req.workspace.id, { userIds: [req.params.userId], status: 'ALL', includeRoles: true, limit: 1 });
  if (!u) throw notFound('User not found in workspace', 404);
  res.json(maskRates(u, req.ctx));
});

// Member profile ------------------------------------------------------------
router.get('/workspaces/:workspaceId/member-profile/:userId', loadWorkspace, async (req, res) => {
  const uid = req.params.userId;
  const u = await one('SELECT u.*, m.week_start, m.working_days, m.work_capacity FROM users u JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1 WHERE u.id = $2', [req.workspace.id, uid]);
  if (!u) throw notFound('Member not found', 404);
  const cf = await rows("SELECT v.custom_field_id, f.name, f.type, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.custom_field_id WHERE v.entity_type = 'USER' AND v.entity_id = $1 AND f.workspace_id = $2", [uid, req.workspace.id]);
  const pending = await one("SELECT 1 FROM approval_requests WHERE workspace_id = $1 AND owner_user_id = $2 AND state = 'PENDING' LIMIT 1", [req.workspace.id, uid]);
  const wsCount = await one('SELECT count(*)::int AS c FROM workspace_members WHERE user_id = $1', [uid]);
  res.json({
    email: u.email, name: u.name, imageUrl: u.profile_picture || '', hasPassword: !!u.password_hash, hasPendingApprovalRequest: !!pending,
    weekStart: u.week_start || u.settings?.weekStart || 'MONDAY', workingDays: u.working_days || req.ctx.settings.workingDays, workCapacity: u.work_capacity || req.ctx.settings.workCapacity || 'PT8H',
    workspaceNumber: wsCount.c, userCustomFieldValues: cf.map((c) => ({ customFieldId: c.custom_field_id, customFieldName: c.name, customFieldType: c.type, value: c.value, userId: uid })),
  });
});

router.patch('/workspaces/:workspaceId/member-profile/:userId', loadWorkspace, async (req, res) => {
  const uid = req.params.userId;
  if (uid !== req.user.id) req.ctx.requireAdmin();
  const body = parse(z.object({
    name: z.string().min(1).max(200).optional(), imageUrl: z.string().optional(), removeProfileImage: z.boolean().optional(),
    weekStart: z.string().optional(), workingDays: z.union([z.array(z.string()), z.string()]).optional(), workCapacity: z.string().optional(),
    userCustomFields: z.array(z.object({ customFieldId: z.string(), value: z.any() })).optional(),
  }), req.body);
  if (body.name || body.imageUrl || body.removeProfileImage) {
    await query("UPDATE users SET name = COALESCE($2, name), profile_picture = CASE WHEN $4 THEN NULL ELSE COALESCE($3, profile_picture) END WHERE id = $1", [uid, body.name || null, body.imageUrl || null, !!body.removeProfileImage]);
  }
  const workingDays = body.workingDays == null ? undefined : (Array.isArray(body.workingDays) ? body.workingDays : [body.workingDays]);
  await query('UPDATE workspace_members SET week_start = COALESCE($3, week_start), working_days = COALESCE($4, working_days), work_capacity = COALESCE($5, work_capacity) WHERE workspace_id = $1 AND user_id = $2',
    [req.workspace.id, uid, body.weekStart || null, workingDays ? JSON.stringify(workingDays) : null, body.workCapacity || null]);
  for (const f of body.userCustomFields || []) {
    await query(`INSERT INTO custom_field_values (entity_type, entity_id, custom_field_id, workspace_id, value, source_type) VALUES ('USER',$1,$2,$3,$4,'USER') ON CONFLICT (entity_type, entity_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value`, [uid, f.customFieldId, req.workspace.id, JSON.stringify(f.value ?? null)]);
  }
  events.emitAsync('user.updated', { userId: uid, workspaceId: req.workspace.id, actorId: req.user.id });
  req.url = req.url; // keep
  const u = await one('SELECT u.*, m.week_start, m.working_days, m.work_capacity FROM users u JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1 WHERE u.id = $2', [req.workspace.id, uid]);
  const cf = await rows("SELECT v.custom_field_id, f.name, f.type, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.custom_field_id WHERE v.entity_type = 'USER' AND v.entity_id = $1 AND f.workspace_id = $2", [uid, req.workspace.id]);
  res.json({ email: u.email, name: u.name, imageUrl: u.profile_picture || '', hasPassword: !!u.password_hash, weekStart: u.week_start || 'MONDAY', workingDays: u.working_days || req.ctx.settings.workingDays, workCapacity: u.work_capacity || 'PT8H', userCustomFieldValues: cf.map((c) => ({ customFieldId: c.custom_field_id, customFieldName: c.name, customFieldType: c.type, value: c.value, userId: uid })) });
});

router.put('/workspaces/:workspaceId/users/:userId/custom-field/:customFieldId/value', loadWorkspace, async (req, res) => {
  const uid = req.params.userId;
  const cf = await one("SELECT * FROM custom_fields WHERE id = $1 AND workspace_id = $2 AND entity_type = 'USER'", [req.params.customFieldId, req.workspace.id]);
  if (!cf) throw notFound('Custom field not found', 404);
  if (uid !== req.user.id || cf.only_admin_can_edit) req.ctx.requireAdmin();
  const { value } = parse(z.object({ value: z.any() }), req.body);
  await query(`INSERT INTO custom_field_values (entity_type, entity_id, custom_field_id, workspace_id, value, source_type) VALUES ('USER',$1,$2,$3,$4,'USER') ON CONFLICT (entity_type, entity_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value`, [uid, cf.id, req.workspace.id, JSON.stringify(value ?? null)]);
  res.status(201).json({ customFieldId: cf.id, customFieldName: cf.name, customFieldType: cf.type, userId: uid, value });
});

// Roles -------------------------------------------------------------------------
const roleSchema = z.object({ role: z.enum(['WORKSPACE_ADMIN', 'TEAM_MANAGER', 'PROJECT_MANAGER']), entityId: z.string().optional(), sourceType: z.string().optional() });

router.post('/workspaces/:workspaceId/users/:userId/roles', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const { role, entityId, sourceType } = parse(roleSchema, req.body);
  const uid = req.params.userId;
  const member = await one('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [req.workspace.id, uid]);
  if (!member) throw notFound('User is not a member of this workspace', 404);
  const eid = role === 'WORKSPACE_ADMIN' ? req.workspace.id : entityId;
  if (!eid) throw badRequest('entityId is required for this role', 400);
  await query('INSERT INTO roles (id, workspace_id, user_id, role, entity_id, source_type) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [newId(), req.workspace.id, uid, role, eid, sourceType || null]);
  if (role === 'PROJECT_MANAGER') await query("UPDATE project_members SET is_manager = true WHERE project_id = $1 AND target_type = 'USER' AND target_id = $2", [eid, uid]);
  events.emitAsync('user.updated', { userId: uid, workspaceId: req.workspace.id, actorId: req.user.id });
  const all = await rows('SELECT * FROM roles WHERE workspace_id = $1 AND user_id = $2', [req.workspace.id, uid]);
  res.status(201).json(all.map((r) => ({ role: { id: r.id, name: r.role, source: r.source_type ? { type: r.source_type } : null, entityId: r.entity_id }, userId: uid, workspaceId: req.workspace.id })));
});

router.delete('/workspaces/:workspaceId/users/:userId/roles', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const { role, entityId } = parse(roleSchema, req.body || {});
  const uid = req.params.userId;
  if (role === 'WORKSPACE_ADMIN' && uid === req.workspace.owner_id) throw badRequest('The owner is always an admin', 400);
  const eid = role === 'WORKSPACE_ADMIN' ? req.workspace.id : entityId;
  await query('DELETE FROM roles WHERE workspace_id = $1 AND user_id = $2 AND role = $3 AND ($4::char(24) IS NULL OR entity_id = $4)', [req.workspace.id, uid, role, eid || null]);
  if (role === 'PROJECT_MANAGER' && eid) await query("UPDATE project_members SET is_manager = false WHERE project_id = $1 AND target_type = 'USER' AND target_id = $2", [eid, uid]);
  res.status(204).end();
});

router.get('/workspaces/:workspaceId/users/:userId/roles', loadWorkspace, async (req, res) => {
  const all = await rows('SELECT * FROM roles WHERE workspace_id = $1 AND user_id = $2', [req.workspace.id, req.params.userId]);
  res.json(all.map((r) => ({ role: { id: r.id, name: r.role, entityId: r.entity_id, source: r.source_type ? { type: r.source_type } : null }, userId: req.params.userId, workspaceId: req.workspace.id })));
});

router.get('/workspaces/:workspaceId/users/:userId/managers', loadWorkspace, async (req, res) => {
  const uid = req.params.userId;
  const groups = await userGroupIds(req.workspace.id, uid);
  const managers = await rows(
    `SELECT DISTINCT u.* FROM roles r JOIN users u ON u.id = r.user_id WHERE r.workspace_id = $1 AND r.role = 'TEAM_MANAGER' AND (r.entity_id = $2 OR r.entity_id = ANY($3)) ORDER BY u.name`,
    [req.workspace.id, uid, groups],
  );
  res.json(managers.map((m) => userDto(m, { includeSettings: false })));
});

export default router;
