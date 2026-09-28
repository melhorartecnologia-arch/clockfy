import { Router } from 'express';
import { one, rows, query, insert, update } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, int } from '../../lib/validate.js';
import { badRequest } from '../../lib/errors.js';
import { parseDate, toIso } from '../../lib/dates.js';
import { audit } from '../../lib/audit.js';
import { WEBHOOK_EVENTS, TRIGGER_SOURCE_TYPES, MAX_ATTEMPTS, generateAuthToken, webhookDto, deliveryDto, getWebhook, deliver, searchDeliveries } from './service.js';

export const router = Router({ mergeParams: true });        // /workspaces/:workspaceId/webhooks
export const addonsRouter = Router({ mergeParams: true });  // /workspaces/:workspaceId/addons/:addonId/webhooks

router.use((req, res, next) => { req.ctx.requireAdmin(); next(); });
addonsRouter.use((req, res, next) => { req.ctx.requireAdmin(); next(); });

const webhookSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().min(1).max(2000),
  webhookEvent: z.enum(WEBHOOK_EVENTS),
  triggerSource: z.array(z.string()).optional(),
  triggerSourceType: z.enum(TRIGGER_SOURCE_TYPES).optional(),
  enabled: z.boolean().optional(),
});

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw badRequest('url must be a valid http(s) URL', 400); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw badRequest('url must use the http or https protocol', 400);
  return url.trim();
}

function normalizeSources(workspaceId, b) {
  const type = b.triggerSourceType || 'WORKSPACE_ID';
  const sources = [...new Set((b.triggerSource || []).filter(Boolean))];
  if (type === 'WORKSPACE_ID') return { type, sources: [workspaceId] };
  if (!sources.length) throw badRequest(`triggerSource must list at least one id for triggerSourceType ${type}`, 400);
  return { type, sources };
}

async function countWebhooks(workspaceId) {
  const r = await one('SELECT count(*)::int AS c FROM webhooks WHERE workspace_id = $1', [workspaceId]);
  return r.c;
}

// GET /webhooks?type=USER_CREATED|SYSTEM|ADDON
router.get('/', async (req, res) => {
  const type = String(req.query.type || 'USER_CREATED').toUpperCase();
  const count = await countWebhooks(req.workspace.id);
  if (type !== 'USER_CREATED' && type !== 'ALL') return res.json({ webhooks: [], workspaceWebhookCount: count });
  const list = await rows('SELECT * FROM webhooks WHERE workspace_id = $1 ORDER BY created_at, id', [req.workspace.id]);
  res.json({ webhooks: list.map(webhookDto), workspaceWebhookCount: count });
});

router.post('/', async (req, res) => {
  const b = parse(webhookSchema, req.body);
  const url = validateUrl(b.url);
  const { type, sources } = normalizeSources(req.workspace.id, b);
  const w = await insert('webhooks', {
    id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, user_id: req.user.id,
    name: b.name || null, url, event: b.webhookEvent, trigger_source: sources, trigger_source_type: type, auth_token: generateAuthToken(),
    enabled: b.enabled ?? true, delivery_enabled: true,
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_WEBHOOK', entityType: 'WEBHOOK', entityId: w.id, content: { ...b, url } });
  res.status(201).json(webhookDto(w));
});

router.get('/:webhookId', async (req, res) => {
  res.json(webhookDto(await getWebhook(req.workspace.id, req.params.webhookId)));
});

async function putWebhook(req, res) {
  const prev = await getWebhook(req.workspace.id, req.params.webhookId);
  const b = parse(webhookSchema.partial(), req.body);
  const patch = {};
  if (b.name !== undefined) patch.name = b.name || null;
  if (b.url !== undefined) patch.url = validateUrl(b.url);
  if (b.webhookEvent !== undefined) patch.event = b.webhookEvent;
  if (b.triggerSourceType !== undefined || b.triggerSource !== undefined) {
    const { type, sources } = normalizeSources(req.workspace.id, { triggerSourceType: b.triggerSourceType || prev.trigger_source_type, triggerSource: b.triggerSource ?? prev.trigger_source });
    patch.trigger_source_type = type; patch.trigger_source = sources;
  }
  if (b.enabled !== undefined) {
    patch.enabled = b.enabled;
    if (b.enabled) { patch.delivery_enabled = true; patch.consecutive_failures = 0; } // re-enabling resets the failure state
  }
  const w = await update('webhooks', prev.id, patch);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_WEBHOOK', entityType: 'WEBHOOK', entityId: prev.id, content: b, previous: webhookDto(prev) });
  res.json(webhookDto(w));
}
router.put('/:webhookId', putWebhook);
router.patch('/:webhookId', putWebhook);

router.delete('/:webhookId', async (req, res) => {
  const w = await getWebhook(req.workspace.id, req.params.webhookId);
  await query('DELETE FROM webhooks WHERE id = $1', [w.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_WEBHOOK', entityType: 'WEBHOOK', entityId: w.id, previous: webhookDto(w) });
  res.status(200).json(webhookDto(w));
});

// Generates a new auth token and invalidates the previous one
router.patch('/:webhookId/token', async (req, res) => {
  const w = await getWebhook(req.workspace.id, req.params.webhookId);
  const updated = await update('webhooks', w.id, { auth_token: generateAuthToken() });
  res.json(webhookDto(updated));
});

function logQuery(q, body = {}) {
  const page = Math.max(0, int(q.page, 0));
  const size = Math.min(500, Math.max(1, int(q.size ?? q['page-size'] ?? q.pageSize, 50)));
  const from = body.from || q.from ? parseDate(body.from || q.from, 'from') : null;
  const to = body.to || q.to ? parseDate(body.to || q.to, 'to') : null;
  const status = String(body.status || q.status || 'ALL').toUpperCase();
  if (!['ALL', 'SUCCEEDED', 'FAILED'].includes(status)) throw badRequest('status must be ALL, SUCCEEDED or FAILED', 400);
  const sortByNewest = body.sortByNewest !== undefined ? !!body.sortByNewest : bool(q.sortByNewest, true);
  // Clockify documents page as 0-based (default 0) but its examples use 1: both 0 and 1 mean the first page
  return { from, to, status, sortByNewest, limit: size, offset: Math.max(0, page - 1) * size };
}

// POST /webhooks/:webhookId/logs?page&size  body: WebhookLogSearchRequestV1
router.post('/:webhookId/logs', async (req, res) => {
  const w = await getWebhook(req.workspace.id, req.params.webhookId);
  const b = parse(z.object({ from: z.string().optional(), to: z.string().optional(), status: z.string().optional(), sortByNewest: z.boolean().optional() }), req.body || {});
  res.json(await searchDeliveries(w.id, logQuery(req.query, b)));
});

// Extra (UI): same search with query params
router.get('/:webhookId/logs', async (req, res) => {
  const w = await getWebhook(req.workspace.id, req.params.webhookId);
  res.json(await searchDeliveries(w.id, logQuery(req.query)));
});

// Extra (UI): sends a test payload to the webhook URL and returns the delivery log entry
router.post('/:webhookId/test', async (req, res) => {
  const w = await getWebhook(req.workspace.id, req.params.webhookId);
  const body = JSON.stringify({ test: true, webhookId: w.id, webhookEvent: w.event, workspaceId: req.workspace.id, triggeredBy: req.user.id, timestamp: toIso(new Date()), message: 'Clockfy webhook test' });
  const d = await deliver(w, w.event, body, { attempt: MAX_ATTEMPTS }); // test deliveries are never retried
  res.json(deliveryDto(d));
});

// GET /addons/:addonId/webhooks – add-ons are not supported: always an empty list
addonsRouter.get('/:addonId/webhooks', async (req, res) => {
  res.json({ webhooks: [], workspaceWebhookCount: await countWebhooks(req.workspace.id) });
});

export default {
  name: 'webhooks',
  workspace(ws) {
    ws.use('/webhooks', router);
    ws.use('/addons', addonsRouter);
  },
};
