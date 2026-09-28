import { Router } from 'express';
import { one, rows, query, insert, update } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, list } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { WEEKDAY_NAMES } from '../../lib/dates.js';
import {
  ALERT_TARGETS, ESTIMATE_TYPES, NOTIFY_KINDS, REMINDER_TYPES, REMINDER_PERIODS,
  alertDto, reminderDto, evaluateAlerts, estimatesStatus, runReminder,
} from './service.js';

export const alertsRouter = Router({ mergeParams: true });     // /workspaces/:workspaceId/alerts
export const remindersRouter = Router({ mergeParams: true });  // /workspaces/:workspaceId/reminders

// ---- Alerts (project/task estimate thresholds) ---------------------------------------------------
const alertSchema = z.object({
  target: z.enum(ALERT_TARGETS).optional(),
  estimateType: z.enum(ESTIMATE_TYPES).optional(),
  percentage: z.number().int().min(1).max(1000).optional(),
  notify: z.array(z.enum(NOTIFY_KINDS)).optional(),
  projectIds: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

async function getAlert(workspaceId, id) {
  const a = await one('SELECT * FROM alerts WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!a) throw notFound('Alert not found', 404);
  return a;
}

async function checkProjects(workspaceId, projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const found = await rows('SELECT id FROM projects WHERE workspace_id = $1 AND id = ANY($2)', [workspaceId, ids]);
  if (found.length !== ids.length) throw badRequest('One or more projects do not exist in this workspace', 400);
  return ids;
}

// Extra (UI): estimate progress of every project with an active estimate
alertsRouter.get('/status', async (req, res) => {
  let projectIds = list(req.query.projects || req.query.projectIds);
  if (!req.ctx.isAdmin) {
    if (!req.ctx.managedProjects.size) throw forbidden('Only admins or project managers can see estimate status', 403);
    const managed = [...req.ctx.managedProjects];
    projectIds = projectIds.length ? projectIds.filter((id) => managed.includes(id)) : managed;
  }
  res.json(await estimatesStatus(req.workspace.id, { projectIds: projectIds.length ? projectIds : undefined }));
});

alertsRouter.get('/', async (req, res) => {
  req.ctx.requireAdmin();
  const l = await rows('SELECT * FROM alerts WHERE workspace_id = $1 ORDER BY created_at, id', [req.workspace.id]);
  res.json(l.map(alertDto));
});

alertsRouter.get('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  res.json(alertDto(await getAlert(req.workspace.id, req.params.id)));
});

alertsRouter.post('/', async (req, res) => {
  req.ctx.requireAdmin();
  const b = parse(alertSchema, req.body);
  const a = await insert('alerts', {
    id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id,
    target: b.target || 'PROJECT', estimate_type: b.estimateType || 'TIME', percentage: b.percentage ?? 80,
    notify: b.notify && b.notify.length ? [...new Set(b.notify)] : ['ADMINS'], project_ids: await checkProjects(req.workspace.id, b.projectIds), enabled: b.enabled ?? true,
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_ALERT', entityType: 'ALERT', entityId: a.id, content: b });
  res.status(201).json(alertDto(a));
});

async function putAlert(req, res) {
  req.ctx.requireAdmin();
  const prev = await getAlert(req.workspace.id, req.params.id);
  const b = parse(alertSchema, req.body);
  const patch = {};
  if (b.target !== undefined) patch.target = b.target;
  if (b.estimateType !== undefined) patch.estimate_type = b.estimateType;
  if (b.percentage !== undefined) patch.percentage = b.percentage;
  if (b.notify !== undefined) patch.notify = [...new Set(b.notify)];
  if (b.projectIds !== undefined) patch.project_ids = await checkProjects(req.workspace.id, b.projectIds);
  if (b.enabled !== undefined) patch.enabled = b.enabled;
  const a = await update('alerts', prev.id, patch);
  // threshold/target changes start a fresh trigger history
  if (patch.percentage !== undefined && patch.percentage !== prev.percentage) await query('DELETE FROM alert_triggers WHERE alert_id = $1', [prev.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_ALERT', entityType: 'ALERT', entityId: prev.id, content: b, previous: alertDto(prev) });
  res.json(alertDto(a));
}
alertsRouter.put('/:id', putAlert);
alertsRouter.patch('/:id', putAlert);

alertsRouter.delete('/:id', async (req, res) => {
  req.ctx.requireAdmin();
  const a = await getAlert(req.workspace.id, req.params.id);
  await query('DELETE FROM alerts WHERE id = $1', [a.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_ALERT', entityType: 'ALERT', entityId: a.id, previous: alertDto(a) });
  res.status(204).end();
});

// Extra (UI/tests): evaluate alerts now
alertsRouter.post('/evaluate', async (req, res) => {
  req.ctx.requireAdmin();
  const fired = await evaluateAlerts(req.workspace.id, { projectId: req.body?.projectId || req.query.projectId || undefined });
  res.json({ fired });
});

// ---- Targets & reminders ------------------------------------------------------------------------------
const reminderSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(REMINDER_TYPES).optional(),
  period: z.enum(REMINDER_PERIODS).optional(),
  hours: z.number().min(0).max(744).optional(),
  days: z.array(z.string()).optional(),
  sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm').optional(),
  userIds: z.array(z.string()).optional(),
  groupIds: z.array(z.string()).optional(),
  everyone: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

function normalizeDays(days) {
  const out = [...new Set((days || []).map((d) => String(d).toUpperCase()))];
  for (const d of out) if (!WEEKDAY_NAMES.includes(d)) throw badRequest(`Invalid day: ${d}`, 400);
  return out;
}

async function getReminder(workspaceId, id) {
  const r = await one('SELECT * FROM reminders WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!r) throw notFound('Reminder not found', 404);
  return r;
}

remindersRouter.use((req, res, next) => { req.ctx.requireAdmin(); next(); });

remindersRouter.get('/', async (req, res) => {
  const l = await rows('SELECT * FROM reminders WHERE workspace_id = $1 ORDER BY created_at, id', [req.workspace.id]);
  res.json(l.map(reminderDto));
});

remindersRouter.get('/:id', async (req, res) => res.json(reminderDto(await getReminder(req.workspace.id, req.params.id))));

remindersRouter.post('/', async (req, res) => {
  const b = parse(reminderSchema, req.body);
  const everyone = b.everyone ?? !((b.userIds && b.userIds.length) || (b.groupIds && b.groupIds.length));
  const r = await insert('reminders', {
    id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name: b.name,
    type: b.type || 'TARGET', period: b.period || 'DAY', hours: b.hours ?? 8, days: b.days ? normalizeDays(b.days) : ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
    send_time: b.sendTime || '17:00', user_ids: [...new Set(b.userIds || [])], group_ids: [...new Set(b.groupIds || [])], everyone, enabled: b.enabled ?? true,
  });
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_REMINDER', entityType: 'REMINDER', entityId: r.id, content: b });
  res.status(201).json(reminderDto(r));
});

async function putReminder(req, res) {
  const prev = await getReminder(req.workspace.id, req.params.id);
  const b = parse(reminderSchema.partial(), req.body);
  const patch = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.type !== undefined) patch.type = b.type;
  if (b.period !== undefined) patch.period = b.period;
  if (b.hours !== undefined) patch.hours = b.hours;
  if (b.days !== undefined) patch.days = normalizeDays(b.days);
  if (b.sendTime !== undefined) patch.send_time = b.sendTime;
  if (b.userIds !== undefined) patch.user_ids = [...new Set(b.userIds)];
  if (b.groupIds !== undefined) patch.group_ids = [...new Set(b.groupIds)];
  if (b.everyone !== undefined) patch.everyone = b.everyone;
  if (b.enabled !== undefined) patch.enabled = b.enabled;
  const r = await update('reminders', prev.id, patch);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_REMINDER', entityType: 'REMINDER', entityId: prev.id, content: b, previous: reminderDto(prev) });
  res.json(reminderDto(r));
}
remindersRouter.put('/:id', putReminder);
remindersRouter.patch('/:id', putReminder);

remindersRouter.delete('/:id', async (req, res) => {
  const r = await getReminder(req.workspace.id, req.params.id);
  await query('DELETE FROM reminders WHERE id = $1', [r.id]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_REMINDER', entityType: 'REMINDER', entityId: r.id, previous: reminderDto(r) });
  res.status(204).end();
});

// Extra (UI/tests): run a reminder now (respects days/sendTime and the once-per-day rule)
remindersRouter.post('/:id/run', async (req, res) => {
  const r = await getReminder(req.workspace.id, req.params.id);
  res.json({ sent: await runReminder(r, new Date()) });
});

export default {
  name: 'alerts',
  workspace(ws) {
    ws.use('/alerts', alertsRouter);
    ws.use('/reminders', remindersRouter);
  },
};
