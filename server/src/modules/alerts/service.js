import { one, rows, query } from '../../lib/db.js';
import { notify } from '../../lib/notify.js';
import { sendMail } from '../../lib/mailer.js';
import { toIso, zonedParts, localDateString, localTimeString, dayOfWeekLocal, startOfDay, startOfWeek, startOfMonth, addDays, addMonths, WEEKDAY_NAMES } from '../../lib/dates.js';
import { projectStatus } from '../projects/service.js';
import { config } from '../../config.js';

export const ALERT_TARGETS = ['PROJECT', 'TASK'];
export const ESTIMATE_TYPES = ['TIME', 'BUDGET'];
export const NOTIFY_KINDS = ['ADMINS', 'PROJECT_MANAGERS', 'MEMBERS'];
export const REMINDER_TYPES = ['TARGET', 'LIMIT', 'TIMESHEET'];
export const REMINDER_PERIODS = ['DAY', 'WEEK', 'MONTH'];

export function alertDto(a) {
  return {
    id: a.id, workspaceId: a.workspace_id, target: a.target, estimateType: a.estimate_type, percentage: a.percentage,
    notify: Array.isArray(a.notify) ? a.notify : [], projectIds: Array.isArray(a.project_ids) ? a.project_ids : [], enabled: !!a.enabled, createdAt: toIso(a.created_at),
  };
}

export function reminderDto(r) {
  return {
    id: r.id, workspaceId: r.workspace_id, name: r.name, type: r.type, period: r.period, hours: Number(r.hours), days: Array.isArray(r.days) ? r.days : [],
    sendTime: r.send_time, userIds: Array.isArray(r.user_ids) ? r.user_ids : [], groupIds: Array.isArray(r.group_ids) ? r.group_ids : [],
    everyone: !!r.everyone, enabled: !!r.enabled, lastRunKey: r.last_run_key || null, createdAt: toIso(r.created_at),
  };
}

// Recipients ------------------------------------------------------------------------------------
export async function workspaceAdminIds(workspaceId) {
  const list = await rows(
    `SELECT DISTINCT m.user_id FROM workspace_members m WHERE m.workspace_id = $1 AND m.status = 'ACTIVE'
       AND (m.user_id = (SELECT owner_id FROM workspaces WHERE id = $1) OR EXISTS (SELECT 1 FROM roles r WHERE r.workspace_id = $1 AND r.user_id = m.user_id AND r.role IN ('WORKSPACE_ADMIN','OWNER')))`,
    [workspaceId],
  );
  return list.map((r) => r.user_id);
}

export async function projectManagerIds(workspaceId, projectId) {
  const list = await rows(
    `SELECT DISTINCT x.user_id FROM (
       SELECT r.user_id FROM roles r WHERE r.workspace_id = $1 AND r.role = 'PROJECT_MANAGER' AND r.entity_id = $2
       UNION SELECT pm.target_id AS user_id FROM project_members pm WHERE pm.project_id = $2 AND pm.target_type = 'USER' AND pm.is_manager = true
     ) x JOIN workspace_members m ON m.workspace_id = $1 AND m.user_id = x.user_id AND m.status = 'ACTIVE'`,
    [workspaceId, projectId],
  );
  return list.map((r) => r.user_id);
}

export async function projectMemberIds(workspaceId, projectId) {
  const list = await rows(
    `SELECT DISTINCT x.user_id FROM (
       SELECT pm.target_id AS user_id FROM project_members pm WHERE pm.project_id = $2 AND pm.target_type = 'USER'
       UNION SELECT gm.user_id FROM project_members pm JOIN user_group_members gm ON gm.group_id = pm.target_id WHERE pm.project_id = $2 AND pm.target_type = 'USERGROUP'
     ) x JOIN workspace_members m ON m.workspace_id = $1 AND m.user_id = x.user_id AND m.status = 'ACTIVE'`,
    [workspaceId, projectId],
  );
  return list.map((r) => r.user_id);
}

export async function alertRecipients(workspaceId, projectId, notifyKinds = []) {
  const set = new Set();
  if (notifyKinds.includes('ADMINS')) (await workspaceAdminIds(workspaceId)).forEach((id) => set.add(id));
  if (notifyKinds.includes('PROJECT_MANAGERS')) (await projectManagerIds(workspaceId, projectId)).forEach((id) => set.add(id));
  if (notifyKinds.includes('MEMBERS')) (await projectMemberIds(workspaceId, projectId)).forEach((id) => set.add(id));
  return [...set];
}

// Sends an in-app notification plus e-mail (respecting the user's setting flag, e.g. settings.alerts)
export async function notifyUsers(userIds, { workspaceId, type, title, body, payload, settingFlag }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  await notify(ids, { workspaceId, type, title, body, payload });
  const users = await rows("SELECT id, email, name, settings FROM users WHERE id = ANY($1) AND status <> 'DELETED'", [ids]);
  for (const u of users) {
    if (settingFlag && u.settings?.[settingFlag] === false) continue;
    if (!u.email || u.email.includes('.deleted.')) continue;
    await sendMail({ to: u.email, subject: title, text: `${body || title}\n\n${config.appUrl}` });
  }
  return ids.length;
}

// Alerts ----------------------------------------------------------------------------------------
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// period_key of alert_triggers: estimate resetOption + current period ("MONTHLY:2026-09"); no reset → ''
export function alertPeriodKey(resetOption, now = new Date()) {
  const p = zonedParts(now, 'UTC');
  switch (String(resetOption || '').toUpperCase()) {
    case 'WEEKLY': return `WEEKLY:${isoWeekKey(now)}`;
    case 'MONTHLY': return `MONTHLY:${p.year}-${String(p.month).padStart(2, '0')}`;
    case 'YEARLY': return `YEARLY:${p.year}`;
    default: return '';
  }
}

async function fireAlert(alert, { entityId, periodKey, project, task, percent, estimateType }) {
  const already = await one('SELECT 1 FROM alert_triggers WHERE alert_id = $1 AND entity_id = $2 AND period_key = $3', [alert.id, entityId, periodKey]);
  if (already) return false;
  // resolve recipients before recording the trigger, so a failure here does not consume the alert
  const recipients = await alertRecipients(alert.workspace_id, project.id, Array.isArray(alert.notify) ? alert.notify : []);
  const inserted = await one('INSERT INTO alert_triggers (alert_id, entity_id, period_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING alert_id', [alert.id, entityId, periodKey]);
  if (!inserted) return false;
  const what = estimateType === 'BUDGET' ? 'budget' : 'time estimate';
  const name = task ? `${project.name} / ${task.name}` : project.name;
  const title = `${name} reached ${percent}% of its ${what}`;
  const body = `${task ? 'Task' : 'Project'} "${name}" has used ${percent}% of its ${what} (alert threshold: ${alert.percentage}%).`;
  await notifyUsers(recipients, {
    workspaceId: alert.workspace_id, type: 'ALERT', title, body, settingFlag: 'alerts',
    payload: { alertId: alert.id, projectId: project.id, taskId: task ? task.id : null, percent, threshold: alert.percentage, estimateType, target: alert.target, periodKey },
  });
  return true;
}

async function evaluateProjectAlert(alert, project, statusCache) {
  if (!statusCache.has(project.id)) statusCache.set(project.id, await projectStatus(alert.workspace_id, project.id));
  const status = statusCache.get(project.id);
  const budget = alert.estimate_type === 'BUDGET';
  const est = budget ? status.budgetEstimate : status.timeEstimate;
  if (!est || !est.active || est.percent == null) return 0;
  if (est.percent < alert.percentage) return 0;
  const reset = (budget ? project.budget_estimate : project.time_estimate)?.resetOption;
  const fired = await fireAlert(alert, { entityId: project.id, periodKey: alertPeriodKey(reset), project, percent: est.percent, estimateType: alert.estimate_type });
  return fired ? 1 : 0;
}

async function evaluateTaskAlert(alert, project, taskId) {
  const budget = alert.estimate_type === 'BUDGET';
  const conds = ['t.project_id = $1', budget ? 't.budget_estimate > 0' : 't.estimate_seconds > 0'];
  const params = [project.id];
  if (taskId) { params.push(taskId); conds.push(`t.id = $${params.length}`); }
  const tasks = await rows(
    `SELECT t.*, COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(e.end_time, now()) - e.start_time))) FROM time_entries e WHERE e.task_id = t.id AND e.deleted_at IS NULL AND e.type = 'REGULAR'),0)::bigint AS tracked_seconds,
            COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(e.end_time, now()) - e.start_time)) / 3600.0 * COALESCE(e.hourly_rate_amount,0)) FROM time_entries e WHERE e.task_id = t.id AND e.deleted_at IS NULL AND e.type = 'REGULAR'),0)::bigint AS earned
     FROM tasks t WHERE ${conds.join(' AND ')}`, params,
  );
  let fired = 0;
  for (const t of tasks) {
    const estimate = budget ? Number(t.budget_estimate) : Number(t.estimate_seconds);
    const used = budget ? Number(t.earned) : Number(t.tracked_seconds);
    if (!estimate) continue;
    const percent = Math.round((used / estimate) * 100);
    if (percent < alert.percentage) continue;
    if (await fireAlert(alert, { entityId: t.id, periodKey: '', project, task: t, percent, estimateType: alert.estimate_type })) fired++;
  }
  return fired;
}

// Evaluates the enabled alerts of a workspace (optionally only for one project/task). Returns the number of alerts fired.
export async function evaluateAlerts(workspaceId, { projectId, taskId } = {}) {
  const alerts = await rows('SELECT * FROM alerts WHERE workspace_id = $1 AND enabled = true', [workspaceId]);
  if (!alerts.length) return 0;
  const statusCache = new Map();
  let fired = 0;
  for (const alert of alerts) {
    const configured = Array.isArray(alert.project_ids) ? alert.project_ids : [];
    let projectIds;
    if (projectId) {
      if (configured.length && !configured.includes(projectId)) continue;
      projectIds = [projectId];
    } else if (configured.length) {
      projectIds = configured;
    } else {
      projectIds = (await rows('SELECT id FROM projects WHERE workspace_id = $1 AND archived = false', [workspaceId])).map((p) => p.id);
    }
    for (const pid of projectIds) {
      const project = await one('SELECT * FROM projects WHERE id = $1 AND workspace_id = $2', [pid, workspaceId]);
      if (!project || project.archived) continue;
      try {
        fired += alert.target === 'TASK' ? await evaluateTaskAlert(alert, project, taskId) : await evaluateProjectAlert(alert, project, statusCache);
      } catch (err) {
        console.error('[alerts] evaluation failed', alert.id, pid, err.message);
      }
    }
  }
  return fired;
}

// Scheduler job: evaluates alerts of every workspace that has enabled alerts
export async function runAlertsJob() {
  const wss = await rows('SELECT DISTINCT workspace_id FROM alerts WHERE enabled = true');
  let fired = 0;
  for (const w of wss) fired += await evaluateAlerts(w.workspace_id);
  return fired;
}

// Estimate status of all projects with an active estimate (for the UI)
export async function estimatesStatus(workspaceId, { projectIds } = {}) {
  const conds = ['p.workspace_id = $1', "((p.time_estimate->>'active')::boolean = true OR (p.budget_estimate->>'active')::boolean = true)"];
  const params = [workspaceId];
  if (projectIds) { params.push(projectIds); conds.push(`p.id = ANY($${params.length})`); }
  const projects = await rows(`SELECT p.*, c.name AS client_name FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE ${conds.join(' AND ')} ORDER BY lower(p.name)`, params);
  const out = [];
  for (const p of projects) {
    const s = await projectStatus(workspaceId, p.id);
    const percents = [s.timeEstimate.active ? s.timeEstimate.percent : null, s.budgetEstimate.active ? s.budgetEstimate.percent : null].filter((x) => x != null);
    out.push({
      projectId: p.id, name: p.name, clientName: p.client_name || '', color: p.color, archived: !!p.archived,
      trackedSeconds: s.trackedSeconds, billableSeconds: s.billableSeconds, earned: s.earned, cost: s.cost, expensesTotal: s.expensesTotal,
      timeEstimate: s.timeEstimate, budgetEstimate: s.budgetEstimate, percent: percents.length ? Math.max(...percents) : null,
    });
  }
  return out;
}

// Reminders (targets & reminders) ---------------------------------------------------------------
export async function reminderTargets(workspaceId, r) {
  const base = `SELECT u.id, u.name, u.email, u.settings, m.week_start FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.status = 'ACTIVE' AND u.status <> 'DELETED'`;
  if (r.everyone) return rows(base, [workspaceId]);
  const userIds = Array.isArray(r.user_ids) ? r.user_ids : [];
  const groupIds = Array.isArray(r.group_ids) ? r.group_ids : [];
  if (!userIds.length && !groupIds.length) return [];
  return rows(`${base} AND (u.id = ANY($2) OR EXISTS (SELECT 1 FROM user_group_members gm WHERE gm.user_id = u.id AND gm.group_id = ANY($3)))`, [workspaceId, userIds, groupIds]);
}

export function reminderPeriodRange(period, now, timeZone, weekStart = 'MONDAY') {
  switch (period) {
    case 'WEEK': { const s = startOfWeek(now, timeZone, weekStart); return [s, addDays(s, 7)]; }
    case 'MONTH': { const s = startOfMonth(now, timeZone); return [s, addMonths(s, 1, timeZone)]; }
    default: { const s = startOfDay(now, timeZone); return [s, addDays(s, 1)]; }
  }
}

const PERIOD_WORD = { DAY: 'daily', WEEK: 'weekly', MONTH: 'monthly' };
const fmtHours = (h) => (Math.round(h * 100) / 100).toString();

// Returns {title, body} when the user should be reminded, or null
export async function checkReminderForUser(r, user, now, timeZone) {
  const weekStart = user.week_start || user.settings?.weekStart || 'MONDAY';
  const [start, end] = reminderPeriodRange(r.period, now, timeZone, weekStart);
  const word = PERIOD_WORD[r.period] || 'daily';
  if (r.type === 'TIMESHEET') {
    const submitted = await one(
      `SELECT 1 FROM approval_requests WHERE workspace_id = $1 AND owner_user_id = $2 AND state IN ('PENDING','APPROVED') AND date_start < $4 AND date_end > $3 LIMIT 1`,
      [r.workspace_id, user.id, start, end],
    );
    if (submitted) return null;
    return { title: `Reminder: submit your ${word} timesheet`, body: `Your timesheet for the period starting ${localDateString(start, timeZone)} has not been submitted for approval yet.`, trackedHours: null, start, end };
  }
  const agg = await one(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time))),0) AS secs FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL AND type = 'REGULAR' AND start_time >= $3 AND start_time < $4`,
    [r.workspace_id, user.id, start, end],
  );
  const hours = Number(agg.secs) / 3600;
  const target = Number(r.hours);
  if (r.type === 'TARGET' && hours < target) {
    return { title: `Reminder: ${fmtHours(hours)}h of your ${fmtHours(target)}h ${word} target tracked`, body: `You have tracked ${fmtHours(hours)} hours so far; your ${word} target is ${fmtHours(target)} hours.`, trackedHours: hours, start, end };
  }
  if (r.type === 'LIMIT' && hours > target) {
    return { title: `Reminder: ${word} limit of ${fmtHours(target)}h exceeded`, body: `You have tracked ${fmtHours(hours)} hours, above your ${word} limit of ${fmtHours(target)} hours.`, trackedHours: hours, start, end };
  }
  return null;
}

// Runs one reminder for all its target users; fires at most once per (reminder, user, local day)
export async function runReminder(r, now = new Date()) {
  const users = await reminderTargets(r.workspace_id, r);
  let sent = 0;
  for (const u of users) {
    const tz = u.settings?.timeZone || 'UTC';
    const dateStr = localDateString(now, tz);
    const weekday = WEEKDAY_NAMES[dayOfWeekLocal(dateStr)];
    if (!(Array.isArray(r.days) ? r.days : []).includes(weekday)) continue;
    if (localTimeString(now, tz, false) < String(r.send_time || '17:00')) continue;
    const key = `${r.id}:${u.id}:${dateStr}`;
    const ins = await one('INSERT INTO reminder_runs (run_key, reminder_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING run_key', [key, r.id, u.id]);
    if (!ins) continue;
    await query('UPDATE reminders SET last_run_key = $2 WHERE id = $1', [r.id, key]);
    const result = await checkReminderForUser(r, u, now, tz);
    if (!result) continue;
    await notifyUsers([u.id], {
      workspaceId: r.workspace_id, type: 'REMINDER', title: result.title, body: result.body, settingFlag: 'reminders',
      payload: { reminderId: r.id, reminderName: r.name, type: r.type, period: r.period, hours: Number(r.hours), trackedHours: result.trackedHours, periodStart: toIso(result.start), periodEnd: toIso(result.end), runKey: key },
    });
    sent++;
  }
  return sent;
}

export async function runReminders(now = new Date()) {
  const reminders = await rows('SELECT * FROM reminders WHERE enabled = true');
  let sent = 0;
  for (const r of reminders) {
    try { sent += await runReminder(r, now); } catch (err) { console.error('[reminders]', r.id, err.message); }
  }
  return sent;
}

// Long-running timers -----------------------------------------------------------------------------
export async function notifyLongRunningTimers({ hours = 8 } = {}) {
  const list = await rows(
    `SELECT e.id, e.user_id, e.workspace_id, e.start_time, e.description, u.settings FROM time_entries e JOIN users u ON u.id = e.user_id
     WHERE e.end_time IS NULL AND e.deleted_at IS NULL AND e.start_time < now() - ($1 || ' hours')::interval
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type = 'LONG_RUNNING_TIMER' AND n.user_id = e.user_id AND n.payload->>'entryId' = e.id)`,
    [String(hours)],
  );
  let sent = 0;
  for (const e of list) {
    if (e.settings?.longRunning !== true) continue;
    const runningHours = Math.floor((Date.now() - new Date(e.start_time).getTime()) / 3600000);
    await notifyUsers([e.user_id], {
      workspaceId: e.workspace_id, type: 'LONG_RUNNING_TIMER', title: `Your timer has been running for ${runningHours} hours`,
      body: `The timer${e.description ? ` "${e.description}"` : ''} started at ${toIso(e.start_time)} is still running. Stop it if you forgot.`,
      payload: { entryId: e.id, startedAt: toIso(e.start_time), runningHours },
    });
    sent++;
  }
  return sent;
}

// Welcome / member joined notifications ---------------------------------------------------------------
export async function notifyUserJoined({ workspaceId, userId, actorId }) {
  const ws = await one('SELECT id, name FROM workspaces WHERE id = $1', [workspaceId]);
  const user = await one('SELECT id, name, email FROM users WHERE id = $1', [userId]);
  if (!ws || !user) return;
  const already = await one("SELECT 1 FROM notifications WHERE user_id = $1 AND workspace_id = $2 AND type = 'WELCOME' LIMIT 1", [userId, workspaceId]);
  if (already) return; // invite re-sent
  await notify([userId], { workspaceId, type: 'WELCOME', title: `Welcome to ${ws.name}`, body: `You are now a member of the workspace "${ws.name}". Start tracking time from the Time Tracker.`, payload: { workspaceId } });
  const admins = (await workspaceAdminIds(workspaceId)).filter((id) => id !== userId && id !== actorId);
  if (admins.length) {
    await notify(admins, { workspaceId, type: 'MEMBER_JOINED', title: `${user.name} joined ${ws.name}`, body: `${user.name} (${user.email}) was added to the workspace.`, payload: { workspaceId, userId } });
  }
}
