import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { one, rows, query, insert, update } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z } from '../../lib/validate.js';
import { badRequest, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { sha256 } from '../../lib/auth.js';
import { buildContext } from '../../middleware/workspace.js';
import { config } from '../../config.js';
import { toIso, startOfDay, addDays } from '../../lib/dates.js';
import { secondsToIso } from '../../lib/duration.js';
import { audit } from '../../lib/audit.js';
import { createEntry, stopRunning, entryDto } from '../timeEntries/service.js';

export const adminRouter = Router({ mergeParams: true });  // /workspaces/:workspaceId/kiosks
export const pinRouter = Router({ mergeParams: true });    // /workspaces/:workspaceId/users/:userId/kiosk-pin
export const publicRouter = Router();                       // /kiosk/:code (no user authentication)

// Kiosk session tokens are signed with a derived secret so they are never accepted as regular API tokens
const kioskSecret = sha256(`${config.jwtSecret}:kiosk-session`);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function kioskDto(k) {
  return {
    id: k.id, workspaceId: k.workspace_id, name: k.name, code: k.code, url: `${config.appUrl}/kiosk/${k.code}`,
    pinRequired: !!k.pin_required, sessionDurationSeconds: k.session_duration_seconds, defaultProjectId: k.default_project_id || null,
    userIds: Array.isArray(k.user_ids) ? k.user_ids : [], groupIds: Array.isArray(k.group_ids) ? k.group_ids : [], active: !!k.active, createdAt: toIso(k.created_at),
  };
}

function generateCode(length = 8) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return out;
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    if (!(await one('SELECT 1 FROM kiosks WHERE code = $1', [code]))) return code;
  }
  return generateCode(12);
}

// ---- Admin: kiosks ------------------------------------------------------------------------------------
const kioskSchema = z.object({
  name: z.string().min(1).max(100),
  pinRequired: z.boolean().optional(),
  sessionDurationSeconds: z.number().int().min(60).max(30 * 86400).optional(),
  defaultProjectId: z.string().nullable().optional(),
  userIds: z.array(z.string()).optional(),
  groupIds: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

adminRouter.use((req, res, next) => { req.ctx.requireAdmin(); next(); });

async function getKiosk(workspaceId, id) {
  const k = await one('SELECT * FROM kiosks WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!k) throw notFound('Kiosk not found', 404);
  return k;
}

async function checkProject(workspaceId, projectId) {
  if (!projectId) return null;
  const p = await one('SELECT id FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId]);
  if (!p) throw badRequest('Default project not found in this workspace', 400);
  return p.id;
}

adminRouter.get('/', async (req, res) => {
  const l = await rows('SELECT * FROM kiosks WHERE workspace_id = $1 ORDER BY created_at, id', [req.workspace.id]);
  res.json(l.map(kioskDto));
});

adminRouter.get('/:id', async (req, res) => res.json(kioskDto(await getKiosk(req.workspace.id, req.params.id))));

adminRouter.post('/', async (req, res) => {
  const b = parse(kioskSchema, req.body);
  const k = await insert('kiosks', {
    id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name: b.name, code: await uniqueCode(),
    pin_required: b.pinRequired ?? req.ctx.settings.kioskPinRequired !== false, session_duration_seconds: b.sessionDurationSeconds ?? 86400,
    default_project_id: await checkProject(req.workspace.id, b.defaultProjectId), user_ids: [...new Set(b.userIds || [])], group_ids: [...new Set(b.groupIds || [])], active: b.active ?? true,
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_KIOSK', entityType: 'KIOSK', entityId: k.id, content: b });
  res.status(201).json(kioskDto(k));
});

async function putKiosk(req, res) {
  const prev = await getKiosk(req.workspace.id, req.params.id);
  const b = parse(kioskSchema.partial(), req.body);
  const patch = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.pinRequired !== undefined) patch.pin_required = b.pinRequired;
  if (b.sessionDurationSeconds !== undefined) patch.session_duration_seconds = b.sessionDurationSeconds;
  if (b.defaultProjectId !== undefined) patch.default_project_id = await checkProject(req.workspace.id, b.defaultProjectId);
  if (b.userIds !== undefined) patch.user_ids = [...new Set(b.userIds)];
  if (b.groupIds !== undefined) patch.group_ids = [...new Set(b.groupIds)];
  if (b.active !== undefined) patch.active = b.active;
  const k = await update('kiosks', prev.id, patch);
  if (b.active === false) await query('UPDATE kiosk_sessions SET revoked_at = now() WHERE kiosk_id = $1 AND revoked_at IS NULL', [prev.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_KIOSK', entityType: 'KIOSK', entityId: prev.id, content: b, previous: kioskDto(prev) });
  res.json(kioskDto(k));
}
adminRouter.put('/:id', putKiosk);
adminRouter.patch('/:id', putKiosk);

adminRouter.delete('/:id', async (req, res) => {
  const k = await getKiosk(req.workspace.id, req.params.id);
  await query('DELETE FROM kiosks WHERE id = $1', [k.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_KIOSK', entityType: 'KIOSK', entityId: k.id, previous: kioskDto(k) });
  res.status(204).end();
});

// New public code; existing sessions are revoked
adminRouter.post('/:id/regenerate-code', async (req, res) => {
  const k = await getKiosk(req.workspace.id, req.params.id);
  const updated = await update('kiosks', k.id, { code: await uniqueCode() });
  await query('UPDATE kiosk_sessions SET revoked_at = now() WHERE kiosk_id = $1 AND revoked_at IS NULL', [k.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_KIOSK', entityType: 'KIOSK', entityId: k.id, content: { regenerateCode: true } });
  res.json(kioskDto(updated));
});

// ---- Admin / self: kiosk PIN ---------------------------------------------------------------------------------
pinRouter.get('/', async (req, res) => {
  const uid = req.params.userId;
  if (uid !== req.user.id) req.ctx.requireAdmin();
  const m = await one('SELECT kiosk_pin FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [req.workspace.id, uid]);
  if (!m) throw notFound('User is not a member of this workspace', 404);
  res.json({ userId: uid, kioskPinSet: !!m.kiosk_pin });
});

pinRouter.put('/', async (req, res) => {
  const uid = req.params.userId;
  if (uid !== req.user.id) req.ctx.requireAdmin();
  const { pin } = parse(z.object({ pin: z.union([z.string(), z.number()]).transform(String) }), req.body);
  if (!/^\d{4,6}$/.test(pin)) throw badRequest('pin must have 4 to 6 digits', 400);
  const m = await one('UPDATE workspace_members SET kiosk_pin = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id', [req.workspace.id, uid, sha256(pin)]);
  if (!m) throw notFound('User is not a member of this workspace', 404);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_KIOSK_PIN', entityType: 'KIOSK_PIN_CODE', entityId: uid });
  res.json({ userId: uid, kioskPinSet: true });
});

pinRouter.delete('/', async (req, res) => {
  const uid = req.params.userId;
  if (uid !== req.user.id) req.ctx.requireAdmin();
  await query('UPDATE workspace_members SET kiosk_pin = NULL WHERE workspace_id = $1 AND user_id = $2', [req.workspace.id, uid]);
  res.status(204).end();
});

// ---- Public kiosk (PIN login) -------------------------------------------------------------------------------------
async function loadKiosk(code) {
  const k = await one('SELECT k.*, w.name AS workspace_name FROM kiosks k JOIN workspaces w ON w.id = k.workspace_id WHERE k.code = $1', [String(code || '').toUpperCase()]);
  if (!k || !k.active) throw notFound('Kiosk not found', 404);
  return k;
}

// Members allowed on the kiosk: userIds + members of groupIds, or every active member when both are empty
async function eligibleMembers(k) {
  const userIds = Array.isArray(k.user_ids) ? k.user_ids : [];
  const groupIds = Array.isArray(k.group_ids) ? k.group_ids : [];
  const base = `SELECT u.id, u.name, u.profile_picture, m.kiosk_pin FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.status = 'ACTIVE' AND u.status <> 'DELETED'`;
  if (!userIds.length && !groupIds.length) return rows(`${base} ORDER BY lower(u.name)`, [k.workspace_id]);
  return rows(`${base} AND (u.id = ANY($2) OR EXISTS (SELECT 1 FROM user_group_members gm WHERE gm.user_id = u.id AND gm.group_id = ANY($3))) ORDER BY lower(u.name)`, [k.workspace_id, userIds, groupIds]);
}

const memberDto = (m) => ({ id: m.id, name: m.name, profilePicture: m.profile_picture || null, hasPin: !!m.kiosk_pin });

async function kioskContext(k, userId) {
  const workspace = await one('SELECT * FROM workspaces WHERE id = $1', [k.workspace_id]);
  const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
  const member = await one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [k.workspace_id, userId]);
  if (!workspace || !user || !member) throw forbidden('User is not a member of this workspace', 403);
  const roleRows = await rows('SELECT role, entity_id, source_type FROM roles WHERE workspace_id = $1 AND user_id = $2', [k.workspace_id, userId]);
  return buildContext({ workspace, user, member, roleRows });
}

async function runningEntry(k, userId) {
  return one('SELECT * FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND end_time IS NULL AND deleted_at IS NULL', [k.workspace_id, userId]);
}

async function kioskStatus(ctx, k, userId) {
  const running = await runningEntry(k, userId);
  const tz = ctx.user.settings?.timeZone || 'UTC';
  const dayStart = startOfDay(new Date(), tz);
  const agg = await one(
    `SELECT COALESCE(SUM(CASE WHEN type = 'REGULAR' THEN EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time)) ELSE 0 END),0) AS work,
            COALESCE(SUM(CASE WHEN type = 'BREAK' THEN EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time)) ELSE 0 END),0) AS brk
     FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL AND start_time >= $3 AND start_time < $4`,
    [k.workspace_id, userId, dayStart, addDays(dayStart, 1)],
  );
  const work = Math.round(Number(agg.work)); const brk = Math.round(Number(agg.brk));
  return {
    kioskId: k.id, userId, clockedIn: !!running, onBreak: !!running && running.type === 'BREAK',
    running: running ? await entryDto(running, { hydrated: true, showRates: false }) : null,
    todayTotal: secondsToIso(work), todayTotalSeconds: work, todayBreak: secondsToIso(brk), todayBreakSeconds: brk, serverTime: toIso(new Date()),
  };
}

// Authenticates a kiosk session token (Authorization: Bearer <token from /login>)
async function kioskAuth(req, res, next) {
  try {
    const k = await loadKiosk(req.params.code);
    const auth = req.get('authorization');
    if (!auth || !/^Bearer /i.test(auth)) throw unauthorized('Kiosk session token required', 1000);
    let payload;
    try { payload = jwt.verify(auth.slice(7).trim(), kioskSecret); } catch { throw unauthorized('Invalid or expired kiosk session', 1000); }
    if (payload.type !== 'kiosk' || payload.kiosk !== k.id) throw unauthorized('Session does not belong to this kiosk', 1000);
    const session = await one('SELECT * FROM kiosk_sessions WHERE id = $1 AND kiosk_id = $2 AND user_id = $3', [payload.sid, k.id, payload.sub]);
    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) throw unauthorized('Kiosk session expired', 1000);
    const ctx = await kioskContext(k, payload.sub);
    if (ctx.member.status !== 'ACTIVE') throw forbidden('User is not active in this workspace', 403);
    req.kiosk = k; req.kioskSession = session; req.kioskCtx = ctx; req.user = ctx.user;
    next();
  } catch (err) { next(err); }
}

publicRouter.get('/kiosk/:code', async (req, res) => {
  const k = await loadKiosk(req.params.code);
  const members = await eligibleMembers(k);
  res.json({
    id: k.id, name: k.name, workspaceId: k.workspace_id, workspaceName: k.workspace_name, pinRequired: !!k.pin_required,
    sessionDurationSeconds: k.session_duration_seconds, defaultProjectId: k.default_project_id || null, members: members.map(memberDto),
  });
});

publicRouter.post('/kiosk/:code/login', async (req, res) => {
  const k = await loadKiosk(req.params.code);
  const { userId, pin } = parse(z.object({ userId: z.string().min(1), pin: z.union([z.string(), z.number()]).transform(String).optional() }), req.body || {});
  const member = (await eligibleMembers(k)).find((m) => m.id === userId);
  if (!member) throw forbidden('User is not allowed to use this kiosk', 403);
  if (k.pin_required) {
    if (!member.kiosk_pin) throw badRequest('Kiosk PIN is not set for this user', 400);
    if (!pin || sha256(String(pin)) !== member.kiosk_pin) throw unauthorized('Invalid PIN', 1000);
  }
  const expiresAt = new Date(Date.now() + k.session_duration_seconds * 1000);
  const session = await insert('kiosk_sessions', { id: newId(), kiosk_id: k.id, workspace_id: k.workspace_id, user_id: userId, expires_at: expiresAt });
  const token = jwt.sign({ sub: userId, kiosk: k.id, ws: k.workspace_id, sid: session.id, type: 'kiosk' }, kioskSecret, { expiresIn: k.session_duration_seconds });
  const ctx = await kioskContext(k, userId);
  await audit({ workspaceId: k.workspace_id, userId, action: 'KIOSK_LOGIN', entityType: 'KIOSK_SESSION', entityId: session.id, content: { kioskId: k.id } });
  res.json({ token, expiresAt: toIso(expiresAt), user: memberDto(member), status: await kioskStatus(ctx, k, userId) });
});

publicRouter.get('/kiosk/:code/status', kioskAuth, async (req, res) => {
  res.json(await kioskStatus(req.kioskCtx, req.kiosk, req.user.id));
});

publicRouter.post('/kiosk/:code/clock-in', kioskAuth, async (req, res) => {
  const { projectId } = parse(z.object({ projectId: z.string().nullable().optional(), description: z.string().optional() }), req.body || {});
  const ctx = req.kioskCtx; const k = req.kiosk;
  if (await runningEntry(k, req.user.id)) throw badRequest('Already clocked in', 400);
  const pid = projectId || k.default_project_id || null;
  if (pid) await checkProject(k.workspace_id, pid).catch(() => { throw badRequest('Project not found', 400); });
  await createEntry(ctx, req.user.id, { start: new Date().toISOString(), end: null, projectId: pid, description: req.body?.description || '', type: 'REGULAR', kioskId: k.id }, { origin: 'KIOSK' });
  res.status(201).json(await kioskStatus(ctx, k, req.user.id));
});

publicRouter.post('/kiosk/:code/clock-out', kioskAuth, async (req, res) => {
  const ctx = req.kioskCtx; const k = req.kiosk;
  const stopped = await stopRunning(ctx, req.user.id);
  if (!stopped) throw notFound('Not clocked in', 404);
  res.json(await kioskStatus(ctx, k, req.user.id));
});

publicRouter.post('/kiosk/:code/break-start', kioskAuth, async (req, res) => {
  const ctx = req.kioskCtx; const k = req.kiosk;
  if (ctx.settings.breaks === false) throw badRequest('Breaks are disabled in this workspace', 400);
  const running = await runningEntry(k, req.user.id);
  if (!running) throw badRequest('Clock in before starting a break', 400);
  if (running.type === 'BREAK') throw badRequest('Already on a break', 400);
  // createEntry stops the running work entry before starting the break
  await createEntry(ctx, req.user.id, { start: new Date().toISOString(), end: null, projectId: null, description: 'Break', type: 'BREAK', kioskId: k.id }, { origin: 'KIOSK' });
  res.status(201).json(await kioskStatus(ctx, k, req.user.id));
});

publicRouter.post('/kiosk/:code/break-end', kioskAuth, async (req, res) => {
  const ctx = req.kioskCtx; const k = req.kiosk;
  const running = await runningEntry(k, req.user.id);
  if (!running || running.type !== 'BREAK') throw badRequest('Not on a break', 400);
  await stopRunning(ctx, req.user.id);
  // resume work on the last project worked on today (or the kiosk default)
  const last = await one(
    "SELECT project_id, task_id, description FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND type = 'REGULAR' AND deleted_at IS NULL AND end_time IS NOT NULL ORDER BY end_time DESC LIMIT 1",
    [k.workspace_id, req.user.id],
  );
  let projectId = last?.project_id || k.default_project_id || null;
  if (projectId && !(await one('SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2 AND archived = false', [projectId, k.workspace_id]))) projectId = k.default_project_id || null;
  await createEntry(ctx, req.user.id, { start: new Date().toISOString(), end: null, projectId, taskId: projectId && last?.project_id === projectId ? last.task_id || null : null, description: last?.description || '', type: 'REGULAR', kioskId: k.id }, { origin: 'KIOSK' });
  res.status(201).json(await kioskStatus(ctx, k, req.user.id));
});

publicRouter.post('/kiosk/:code/logout', kioskAuth, async (req, res) => {
  await query('UPDATE kiosk_sessions SET revoked_at = now() WHERE id = $1', [req.kioskSession.id]);
  res.json({ ok: true });
});

export default {
  name: 'kiosk',
  workspace(ws) {
    ws.use('/kiosks', adminRouter);
    ws.use('/users/:userId/kiosk-pin', pinRouter);
  },
  api(api) {
    api.use(publicRouter); // public kiosk routes (mounted before the authenticated routers in routes.js)
  },
};
