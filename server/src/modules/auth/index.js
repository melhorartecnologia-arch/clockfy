import { Router } from 'express';
import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId, randomToken } from '../../lib/ids.js';
import { hashPassword, verifyPassword, signToken, generateApiKey, sha256 } from '../../lib/auth.js';
import { badRequest, unauthorized, notFound, conflict } from '../../lib/errors.js';
import { parse, z } from '../../lib/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { sendMail } from '../../lib/mailer.js';
import { config } from '../../config.js';
import { createWorkspace } from '../workspaces/service.js';
import { getUserDto } from '../users/service.js';
import { DEFAULT_USER_SETTINGS } from '../../lib/settings.js';
import { isValidTimeZone } from '../../lib/dates.js';

export const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1).max(200).optional(),
  workspaceName: z.string().max(200).optional(),
  timeZone: z.string().optional(),
  lang: z.string().optional(),
});

async function issue(user) {
  const token = signToken({ sub: user.id, email: user.email });
  return { token, user: await getUserDto(user.id) };
}

router.post('/register', async (req, res) => {
  const body = parse(registerSchema, req.body);
  const email = body.email.toLowerCase();
  const existing = await one('SELECT * FROM users WHERE lower(email) = $1', [email]);
  if (existing && existing.password_hash) throw conflict('Email already registered', 409);
  const settings = { ...DEFAULT_USER_SETTINGS, timeZone: body.timeZone && isValidTimeZone(body.timeZone) ? body.timeZone : 'UTC', lang: body.lang || 'PT_BR' };
  const user = await transaction(async () => {
    let u;
    if (existing) {
      // invited placeholder account completes registration
      u = await one('UPDATE users SET password_hash = $2, name = $3, status = $4, settings = $5 WHERE id = $1 RETURNING *',
        [existing.id, await hashPassword(body.password), body.name || existing.name, 'ACTIVE', JSON.stringify(settings)]);
      await query("UPDATE workspace_members SET status = 'ACTIVE' WHERE user_id = $1 AND status = 'PENDING'", [u.id]);
    } else {
      u = await insert('users', { id: newId(), email, password_hash: await hashPassword(body.password), name: body.name || email.split('@')[0], status: 'ACTIVE', settings });
    }
    if (!u.active_workspace_id) {
      const ws = await createWorkspace({ name: body.workspaceName || `${u.name}'s workspace`, owner: u });
      u = await one('UPDATE users SET active_workspace_id = $2, default_workspace_id = $2 WHERE id = $1 RETURNING *', [u.id, ws.id]);
    }
    return u;
  });
  res.status(201).json(await issue(user));
});

router.post('/login', async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string() }), req.body);
  const user = await one('SELECT * FROM users WHERE lower(email) = $1', [email.toLowerCase()]);
  if (!user || !(await verifyPassword(password, user.password_hash))) throw unauthorized('Invalid email or password', 1001);
  if (user.status === 'DELETED') throw unauthorized('Account deleted', 1001);
  res.json(await issue(user));
});

router.post('/logout', (req, res) => res.status(204).end());

router.get('/me', authenticate, async (req, res) => {
  res.json(await getUserDto(req.user.id));
});

router.post('/refresh', authenticate, async (req, res) => {
  res.json(await issue(req.user));
});

router.post('/forgot-password', async (req, res) => {
  const { email } = parse(z.object({ email: z.string().email() }), req.body);
  const user = await one('SELECT * FROM users WHERE lower(email) = $1', [email.toLowerCase()]);
  if (user) {
    const raw = randomToken();
    await insert('user_tokens', { id: newId(), user_id: user.id, type: 'PASSWORD_RESET', token_hash: sha256(raw), expires_at: new Date(Date.now() + 3600e3) });
    const link = `${config.appUrl}/reset-password?token=${raw}`;
    await sendMail({ to: user.email, subject: 'Redefinir senha - Clockfy', text: `Para redefinir sua senha acesse: ${link}` });
    res.json({ ok: true, ...(config.env !== 'production' ? { token: raw } : {}) });
    return;
  }
  res.json({ ok: true });
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = parse(z.object({ token: z.string(), password: z.string().min(6) }), req.body);
  const t = await one("SELECT * FROM user_tokens WHERE token_hash = $1 AND type = 'PASSWORD_RESET' AND used_at IS NULL AND expires_at > now()", [sha256(token)]);
  if (!t) throw badRequest('Invalid or expired token', 400);
  await query('UPDATE users SET password_hash = $2, status = $3 WHERE id = $1', [t.user_id, await hashPassword(password), 'ACTIVE']);
  await query('UPDATE user_tokens SET used_at = now() WHERE id = $1', [t.id]);
  const user = await one('SELECT * FROM users WHERE id = $1', [t.user_id]);
  res.json(await issue(user));
});

router.get('/invite/:token', async (req, res) => {
  const t = await one("SELECT t.*, u.email, u.name, w.name AS workspace_name FROM user_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN workspaces w ON w.id = (t.meta->>'workspaceId')::char(24) WHERE t.token_hash = $1 AND t.type = 'INVITE' AND t.used_at IS NULL AND t.expires_at > now()", [sha256(req.params.token)]);
  if (!t) throw notFound('Invalid or expired invitation', 404);
  res.json({ email: t.email, name: t.name, workspaceName: t.workspace_name, workspaceId: t.meta.workspaceId });
});

router.post('/accept-invite', async (req, res) => {
  const { token, password, name } = parse(z.object({ token: z.string(), password: z.string().min(6), name: z.string().min(1).optional() }), req.body);
  const t = await one("SELECT * FROM user_tokens WHERE token_hash = $1 AND type = 'INVITE' AND used_at IS NULL AND expires_at > now()", [sha256(token)]);
  if (!t) throw badRequest('Invalid or expired invitation', 400);
  const user = await transaction(async () => {
    const u = await one('UPDATE users SET password_hash = $2, name = COALESCE($3, name), status = $4, active_workspace_id = COALESCE(active_workspace_id, $5), default_workspace_id = COALESCE(default_workspace_id, $5) WHERE id = $1 RETURNING *',
      [t.user_id, await hashPassword(password), name || null, 'ACTIVE', t.meta.workspaceId || null]);
    await query("UPDATE workspace_members SET status = 'ACTIVE', joined_at = now() WHERE user_id = $1 AND workspace_id = $2", [u.id, t.meta.workspaceId]);
    await query('UPDATE user_tokens SET used_at = now() WHERE id = $1', [t.id]);
    return u;
  });
  res.json(await issue(user));
});

router.put('/password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().optional(), newPassword: z.string().min(6) }), req.body);
  if (req.user.password_hash && !(await verifyPassword(currentPassword || '', req.user.password_hash))) throw badRequest('Current password is incorrect', 400);
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(newPassword)]);
  res.json({ ok: true });
});

// API keys (Clockify: Preferences > Advanced > Manage API keys) ------------
router.get('/api-keys', authenticate, async (req, res) => {
  const keys = await rows('SELECT id, name, key_prefix, last_used_at, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(keys.map((k) => ({ id: k.id, name: k.name, prefix: k.key_prefix, lastUsedAt: k.last_used_at, createdAt: k.created_at })));
});

router.post('/api-keys', authenticate, async (req, res) => {
  const { name } = parse(z.object({ name: z.string().max(100).optional() }), req.body || {});
  const { raw, hash, prefix } = generateApiKey();
  const k = await insert('api_keys', { id: newId(), user_id: req.user.id, name: name || 'API key', key_hash: hash, key_prefix: prefix });
  res.status(201).json({ id: k.id, name: k.name, prefix, apiKey: raw, createdAt: k.created_at });
});

router.delete('/api-keys/:id', authenticate, async (req, res) => {
  await query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.status(204).end();
});

export default router;
