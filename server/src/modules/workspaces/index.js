import { Router } from 'express';
import { one, rows, query, transaction, insert } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, rateSchema } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { loadWorkspace } from '../../middleware/workspace.js';
import { createWorkspace, getWorkspaceDto, addUserToWorkspace } from './service.js';
import { recordRateHistory, reapplyRates } from '../../lib/rates.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { DEFAULT_WORKSPACE_SETTINGS } from '../../lib/settings.js';

export const router = Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const list = await rows(
    `SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = $1 AND m.status IN ('ACTIVE','PENDING') ORDER BY w.created_at`,
    [req.user.id],
  );
  const roles = String(req.query.roles || '').split(',').filter(Boolean);
  const out = [];
  for (const w of list) {
    if (roles.length) {
      const has = await one('SELECT 1 FROM roles WHERE workspace_id = $1 AND user_id = $2 AND role = ANY($3)', [w.id, req.user.id, roles]);
      if (!has) continue;
    }
    out.push(await getWorkspaceDto(w.id));
  }
  res.json(out);
});

router.post('/', async (req, res) => {
  const { name, currency } = parse(z.object({ name: z.string().min(1).max(250), currency: z.string().length(3).optional() }), req.body);
  const ws = await createWorkspace({ name, owner: req.user, currency: currency ? currency.toUpperCase() : 'USD' });
  if (!req.user.active_workspace_id) await query('UPDATE users SET active_workspace_id = $2, default_workspace_id = COALESCE(default_workspace_id, $2) WHERE id = $1', [req.user.id, ws.id]);
  res.status(201).json(await getWorkspaceDto(ws.id));
});

router.get('/:workspaceId', loadWorkspace, async (req, res) => {
  res.json(await getWorkspaceDto(req.workspace.id));
});

const settingsSchema = z.object({}).passthrough();

async function updateWorkspace(req, res) {
  req.ctx.requireAdmin();
  const body = parse(z.object({ name: z.string().min(1).max(250).optional(), imageUrl: z.string().optional(), workspaceSettings: settingsSchema.optional(), settings: settingsSchema.optional(), subdomain: z.any().optional() }), req.body);
  const patch = body.workspaceSettings || body.settings;
  const current = req.workspace.settings || {};
  const merged = patch ? { ...current, ...patch } : current;
  if (merged.round && typeof merged.round === 'object') merged.round = { round: String(merged.round.round || 'Round to nearest'), minutes: String(merged.round.minutes || '15') };
  await query('UPDATE workspaces SET name = COALESCE($2, name), image_url = COALESCE($3, image_url), settings = $4, subdomain = COALESCE($5, subdomain) WHERE id = $1',
    [req.workspace.id, body.name || null, body.imageUrl ?? null, JSON.stringify(merged), body.subdomain?.name ?? null]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_WORKSPACE', entityType: 'WORKSPACE', entityId: req.workspace.id, content: body });
  res.json(await getWorkspaceDto(req.workspace.id));
}
router.put('/:workspaceId', loadWorkspace, updateWorkspace);
router.patch('/:workspaceId', loadWorkspace, updateWorkspace);
router.put('/:workspaceId/settings', loadWorkspace, async (req, res, next) => { req.body = { workspaceSettings: req.body }; updateWorkspace(req, res).catch(next); });
router.patch('/:workspaceId/settings', loadWorkspace, async (req, res, next) => { req.body = { workspaceSettings: req.body }; updateWorkspace(req, res).catch(next); });
router.get('/:workspaceId/settings/defaults', (req, res) => res.json(DEFAULT_WORKSPACE_SETTINGS));

router.delete('/:workspaceId', loadWorkspace, async (req, res) => {
  if (!req.ctx.isOwner && !req.user.is_super_admin) throw forbidden('Only the owner can delete the workspace', 403);
  await transaction(async () => {
    await query('UPDATE users SET active_workspace_id = NULL WHERE active_workspace_id = $1', [req.workspace.id]);
    await query('UPDATE users SET default_workspace_id = NULL WHERE default_workspace_id = $1', [req.workspace.id]);
    await query('DELETE FROM workspaces WHERE id = $1', [req.workspace.id]);
  });
  res.status(204).end();
});

// Rates -----------------------------------------------------------------------
router.put('/:workspaceId/hourly-rate', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const { amount, currency, since } = parse(rateSchema, req.body);
  await query('UPDATE workspaces SET hourly_rate_amount = $2, hourly_rate_currency = COALESCE($3, hourly_rate_currency) WHERE id = $1', [req.workspace.id, amount, currency ? currency.toUpperCase() : null]);
  await recordRateHistory({ workspaceId: req.workspace.id, entityType: 'WORKSPACE', entityId: req.workspace.id, rateType: 'HOURLY', amount, currency, since, createdBy: req.user.id });
  if (since) await reapplyRates({ workspaceId: req.workspace.id, since });
  events.emitAsync('rate.updated', { workspaceId: req.workspace.id, actorId: req.user.id, rateType: 'BILLABLE', entity: 'WORKSPACE' });
  res.json(await getWorkspaceDto(req.workspace.id));
});

router.put('/:workspaceId/cost-rate', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const { amount, since } = parse(rateSchema, req.body);
  await query('UPDATE workspaces SET cost_rate_amount = $2 WHERE id = $1', [req.workspace.id, amount]);
  await recordRateHistory({ workspaceId: req.workspace.id, entityType: 'WORKSPACE', entityId: req.workspace.id, rateType: 'COST', amount, since, createdBy: req.user.id });
  if (since) await reapplyRates({ workspaceId: req.workspace.id, since });
  events.emitAsync('rate.updated', { workspaceId: req.workspace.id, actorId: req.user.id, rateType: 'COST', entity: 'WORKSPACE' });
  res.json(await getWorkspaceDto(req.workspace.id));
});

// Members -----------------------------------------------------------------------
router.post('/:workspaceId/users', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const body = parse(z.object({ email: z.string().email().optional(), emails: z.array(z.string().email()).optional(), name: z.string().optional() }), req.body);
  const emails = body.emails || (body.email ? [body.email] : []);
  if (!emails.length) throw badRequest('email is required', 400);
  const sendEmail = bool(req.query['send-email'], true);
  const results = [];
  for (const email of emails) {
    const r = await addUserToWorkspace({ workspace: req.workspace, email, invitedBy: req.user, sendEmail, name: body.name });
    results.push({ userId: r.user.id, email: r.user.email, inviteLink: r.inviteLink });
    await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'INVITE_USER', entityType: 'USER', entityId: r.user.id, content: { email } });
  }
  const dto = await getWorkspaceDto(req.workspace.id);
  dto.invited = results;
  res.json(dto);
});

router.put('/:workspaceId/users/:userId', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) }), req.body);
  if (req.params.userId === req.workspace.owner_id && status === 'INACTIVE') throw badRequest('Cannot deactivate the workspace owner', 400);
  const m = await one('UPDATE workspace_members SET status = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING *', [req.workspace.id, req.params.userId, status]);
  if (!m) throw notFound('User is not a member of this workspace', 404);
  if (status === 'INACTIVE') await query('UPDATE time_entries SET end_time = now() WHERE workspace_id = $1 AND user_id = $2 AND end_time IS NULL AND deleted_at IS NULL', [req.workspace.id, req.params.userId]);
  events.emitAsync(status === 'ACTIVE' ? 'user.activated' : 'user.deactivated', { workspaceId: req.workspace.id, userId: req.params.userId, actorId: req.user.id });
  res.json(await getWorkspaceDto(req.workspace.id));
});

router.delete('/:workspaceId/users/:userId', loadWorkspace, async (req, res) => {
  const target = req.params.userId;
  if (target !== req.user.id) req.ctx.requireAdmin();
  if (target === req.workspace.owner_id) throw badRequest('The owner cannot be removed from the workspace', 400);
  await transaction(async () => {
    await query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [req.workspace.id, target]);
    await query('DELETE FROM roles WHERE workspace_id = $1 AND user_id = $2', [req.workspace.id, target]);
    await query("DELETE FROM project_members WHERE target_type = 'USER' AND target_id = $2 AND project_id IN (SELECT id FROM projects WHERE workspace_id = $1)", [req.workspace.id, target]);
    await query('DELETE FROM user_group_members WHERE user_id = $2 AND group_id IN (SELECT id FROM user_groups WHERE workspace_id = $1)', [req.workspace.id, target]);
    await query('UPDATE users SET active_workspace_id = (SELECT workspace_id FROM workspace_members WHERE user_id = $1 LIMIT 1) WHERE id = $1 AND active_workspace_id = $2', [target, req.workspace.id]);
  });
  events.emitAsync('user.removed', { workspaceId: req.workspace.id, userId: target, actorId: req.user.id });
  res.json(await getWorkspaceDto(req.workspace.id));
});

router.put('/:workspaceId/users/:userId/hourly-rate', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const { amount, since, currency } = parse(rateSchema, req.body);
  const m = await one('UPDATE workspace_members SET hourly_rate_amount = $3, hourly_rate_currency = COALESCE($4, hourly_rate_currency) WHERE workspace_id = $1 AND user_id = $2 RETURNING *', [req.workspace.id, req.params.userId, amount, currency || null]);
  if (!m) throw notFound('User is not a member of this workspace', 404);
  await recordRateHistory({ workspaceId: req.workspace.id, entityType: 'USER', entityId: req.params.userId, userId: req.params.userId, rateType: 'HOURLY', amount, currency, since, createdBy: req.user.id });
  if (since) await reapplyRates({ workspaceId: req.workspace.id, userId: req.params.userId, since });
  events.emitAsync('rate.updated', { workspaceId: req.workspace.id, actorId: req.user.id, rateType: 'BILLABLE', entity: 'USER', userId: req.params.userId });
  res.json(await getWorkspaceDto(req.workspace.id));
});

router.put('/:workspaceId/users/:userId/cost-rate', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const { amount, since } = parse(rateSchema, req.body);
  const m = await one('UPDATE workspace_members SET cost_rate_amount = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING *', [req.workspace.id, req.params.userId, amount]);
  if (!m) throw notFound('User is not a member of this workspace', 404);
  await recordRateHistory({ workspaceId: req.workspace.id, entityType: 'USER', entityId: req.params.userId, userId: req.params.userId, rateType: 'COST', amount, since, createdBy: req.user.id });
  if (since) await reapplyRates({ workspaceId: req.workspace.id, userId: req.params.userId, since });
  events.emitAsync('rate.updated', { workspaceId: req.workspace.id, actorId: req.user.id, rateType: 'COST', entity: 'USER', userId: req.params.userId });
  res.json(await getWorkspaceDto(req.workspace.id));
});

router.post('/:workspaceId/users/:userId/resend-invite', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const u = await one('SELECT * FROM users WHERE id = $1', [req.params.userId]);
  if (!u) throw notFound('User not found', 404);
  const r = await addUserToWorkspace({ workspace: req.workspace, email: u.email, invitedBy: req.user, sendEmail: true });
  res.json({ ok: true, inviteLink: r.inviteLink });
});

router.put('/:workspaceId/transfer-ownership', loadWorkspace, async (req, res) => {
  if (!req.ctx.isOwner) throw forbidden('Only the owner can transfer ownership', 403);
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  const m = await one("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE'", [req.workspace.id, userId]);
  if (!m) throw badRequest('Target user must be an active member', 400);
  await transaction(async () => {
    await query('UPDATE workspaces SET owner_id = $2 WHERE id = $1', [req.workspace.id, userId]);
    await query("DELETE FROM roles WHERE workspace_id = $1 AND role = 'OWNER'", [req.workspace.id]);
    await query("INSERT INTO roles (id, workspace_id, user_id, role, entity_id) VALUES ($1,$2,$3,'OWNER',$2)", [newId(), req.workspace.id, userId]);
    await query("INSERT INTO roles (id, workspace_id, user_id, role, entity_id) VALUES ($1,$2,$3,'WORKSPACE_ADMIN',$2) ON CONFLICT DO NOTHING", [newId(), req.workspace.id, userId]);
  });
  res.json(await getWorkspaceDto(req.workspace.id));
});

// Currencies -------------------------------------------------------------------
router.get('/:workspaceId/currencies', loadWorkspace, async (req, res) => {
  const list = await rows('SELECT * FROM workspace_currencies WHERE workspace_id = $1 ORDER BY is_default DESC, code', [req.workspace.id]);
  res.json(list.map((c) => ({ id: c.id, code: c.code, isDefault: c.is_default })));
});
router.post('/:workspaceId/currencies', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const { code, isDefault } = parse(z.object({ code: z.string().min(3).max(3), isDefault: z.boolean().optional() }), req.body);
  const c = await insert('workspace_currencies', { id: newId(), workspace_id: req.workspace.id, code: code.toUpperCase(), is_default: !!isDefault });
  if (isDefault) {
    await query('UPDATE workspace_currencies SET is_default = (id = $2) WHERE workspace_id = $1', [req.workspace.id, c.id]);
    await query('UPDATE workspaces SET hourly_rate_currency = $2 WHERE id = $1', [req.workspace.id, c.code]);
  }
  res.status(201).json({ id: c.id, code: c.code, isDefault: !!isDefault });
});
router.delete('/:workspaceId/currencies/:id', loadWorkspace, async (req, res) => {
  req.ctx.requireAdmin();
  const c = await one('SELECT * FROM workspace_currencies WHERE id = $1 AND workspace_id = $2', [req.params.id, req.workspace.id]);
  if (!c) throw notFound('Currency not found', 404);
  if (c.is_default) throw badRequest('Cannot delete the default currency', 400);
  await query('DELETE FROM workspace_currencies WHERE id = $1', [c.id]);
  res.status(204).end();
});

export default router;
