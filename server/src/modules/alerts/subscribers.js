// Alert/notification subscribers: estimate alerts on time entry changes, welcome notifications,
// and periodic jobs (alerts, targets & reminders, long-running timers).
import { events } from '../../lib/events.js';
import { registerJob } from '../../scheduler.js';
import { one } from '../../lib/db.js';
import { evaluateAlerts, runAlertsJob, runReminders, notifyLongRunningTimers, notifyUserJoined } from './service.js';

async function onEntryChange(p) {
  if (!p?.workspaceId || !p.entryId) return;
  const e = await one('SELECT project_id, task_id FROM time_entries WHERE id = $1 AND workspace_id = $2', [p.entryId, p.workspaceId]);
  if (!e?.project_id) return;
  await evaluateAlerts(p.workspaceId, { projectId: e.project_id, taskId: e.task_id || undefined });
}

for (const name of ['time_entry.created', 'time_entry.updated', 'timer.stopped']) {
  events.on(name, (p) => { onEntryChange(p).catch((err) => console.error('[alerts]', name, err.message)); });
}

events.on('user.joined_workspace', (p) => {
  if (!p?.workspaceId || !p.userId) return;
  notifyUserJoined(p).catch((err) => console.error('[alerts] user.joined_workspace', err.message));
});

registerJob('alerts-evaluate', 15 * 60_000, () => runAlertsJob());
registerJob('reminders', 5 * 60_000, () => runReminders());
registerJob('long-running-timers', 30 * 60_000, () => notifyLongRunningTimers({ hours: 8 }));
