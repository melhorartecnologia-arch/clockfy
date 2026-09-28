import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

process.env.RATE_LIMIT_PER_SECOND = process.env.RATE_LIMIT_PER_SECOND || '1000'; // tests fire many requests per second

let t; let owner; let ws; let dev;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

before(async () => {
  t = await setupTestApp('alerts');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
});
after(async () => { await t.close(); });

async function notificationsOf(user, type) {
  const r = await user.call('GET', '/api/v1/user/notifications');
  assert.equal(r.status, 200, r.text);
  return r.data.notifications.filter((n) => n.type === type);
}

async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

test('project estimate alert fires once when the threshold is reached', async () => {
  const project = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Estimated', timeEstimate: { estimate: 'PT10H', type: 'MANUAL', active: true } });
  assert.equal(project.status, 201, project.text);
  const alert = await owner.call('POST', `/api/v1/workspaces/${ws}/alerts`, { target: 'PROJECT', estimateType: 'TIME', percentage: 50, notify: ['ADMINS'], projectIds: [project.data.id] });
  assert.equal(alert.status, 201, alert.text);
  assert.equal(alert.data.percentage, 50);
  assert.deepEqual(alert.data.notify, ['ADMINS']);
  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/alerts`);
  assert.equal(list.data.length, 1);

  // 3h of 10h = 30% → below the threshold
  assert.equal((await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-05T08:00:00Z', end: '2026-01-05T11:00:00Z', projectId: project.data.id })).status, 201);
  await sleep(300);
  assert.equal((await notificationsOf(owner, 'ALERT')).length, 0);

  // +3h = 60% → alert (in-app + e-mail)
  assert.equal((await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-05T12:00:00Z', end: '2026-01-05T15:00:00Z', projectId: project.data.id })).status, 201);
  const alerts = await waitFor(async () => { const l = await notificationsOf(owner, 'ALERT'); return l.length ? l : null; });
  assert.ok(alerts, 'alert notification was not created');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /Estimated reached 60% of its time estimate/);
  assert.equal(alerts[0].payload.projectId, project.data.id);
  assert.equal(alerts[0].payload.percent, 60);
  const { outbox } = await import('../src/lib/mailer.js');
  assert.ok(outbox.find((m) => m.to === owner.user.email && /Estimated reached 60%/.test(m.subject)));

  // more time → no second notification for the same alert/project/period
  assert.equal((await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-05T16:00:00Z', end: '2026-01-05T17:00:00Z', projectId: project.data.id })).status, 201);
  await sleep(300);
  assert.equal((await notificationsOf(owner, 'ALERT')).length, 1);
  const evaluate = await owner.call('POST', `/api/v1/workspaces/${ws}/alerts/evaluate`);
  assert.equal(evaluate.status, 200);
  assert.equal(evaluate.data.fired, 0);

  const status = await owner.call('GET', `/api/v1/workspaces/${ws}/alerts/status`);
  assert.equal(status.status, 200, status.text);
  const s = status.data.find((p) => p.projectId === project.data.id);
  assert.ok(s);
  assert.equal(s.timeEstimate.percent, 70);
  assert.equal(s.percent, 70);

  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/alerts/${alert.data.id}`, { percentage: 90, enabled: false });
  assert.equal(upd.data.percentage, 90);
  assert.equal(upd.data.enabled, false);
  assert.equal((await owner.call('DELETE', `/api/v1/workspaces/${ws}/alerts/${alert.data.id}`)).status, 204);
});

test('task estimate alert notifies project members', async () => {
  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'dev@test.dev' });
  dev = await t.register({ email: 'dev@test.dev', name: 'Dev' });
  const project = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Tasked', memberships: [{ userId: dev.user.id }], tasks: [{ name: 'Build', estimate: 'PT2H' }] });
  assert.equal(project.status, 201, project.text);
  const task = project.data.tasks[0];
  const alert = await owner.call('POST', `/api/v1/workspaces/${ws}/alerts`, { target: 'TASK', estimateType: 'TIME', percentage: 100, notify: ['MEMBERS'] });
  assert.equal(alert.status, 201, alert.text);
  assert.deepEqual(alert.data.projectIds, []);
  const entry = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-06T08:00:00Z', end: '2026-01-06T10:00:00Z', projectId: project.data.id, taskId: task.id });
  assert.equal(entry.status, 201, entry.text);
  const got = await waitFor(async () => { const l = await notificationsOf(dev, 'ALERT'); return l.length ? l : null; });
  assert.ok(got, 'task alert was not delivered to the project member');
  assert.match(got[0].title, /Tasked \/ Build reached 100% of its time estimate/);
  assert.equal(got[0].payload.taskId, task.id);
  // admins were not in the notify list
  assert.ok(!(await notificationsOf(owner, 'ALERT')).find((n) => n.payload.taskId === task.id));
  await owner.call('DELETE', `/api/v1/workspaces/${ws}/alerts/${alert.data.id}`);
});

test('reminders run once per user per day', async () => {
  const today = WEEKDAYS[new Date().getUTCDay()]; // test users default to the UTC time zone
  const create = await owner.call('POST', `/api/v1/workspaces/${ws}/reminders`, { name: 'Daily target', type: 'TARGET', period: 'DAY', hours: 8, days: [today], sendTime: '00:00', everyone: true });
  assert.equal(create.status, 201, create.text);
  assert.equal(create.data.everyone, true);
  assert.deepEqual(create.data.days, [today]);
  const run = await owner.call('POST', `/api/v1/workspaces/${ws}/reminders/${create.data.id}/run`);
  assert.equal(run.status, 200, run.text);
  assert.ok(run.data.sent >= 1, 'reminder should notify members below the target');
  const mine = await notificationsOf(owner, 'REMINDER');
  assert.equal(mine.length, 1);
  assert.match(mine[0].title, /daily target/);
  assert.equal(mine[0].payload.reminderId, create.data.id);
  const again = await owner.call('POST', `/api/v1/workspaces/${ws}/reminders/${create.data.id}/run`);
  assert.equal(again.data.sent, 0);

  const invalid = await owner.call('POST', `/api/v1/workspaces/${ws}/reminders`, { name: 'x', sendTime: '25:00' });
  assert.equal(invalid.status, 400);
  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/reminders/${create.data.id}`, { type: 'LIMIT', hours: 1.5, enabled: false });
  assert.equal(upd.data.type, 'LIMIT');
  assert.equal(upd.data.hours, 1.5);
  const listed = await owner.call('GET', `/api/v1/workspaces/${ws}/reminders`);
  assert.equal(listed.data.length, 1);
  assert.equal((await owner.call('DELETE', `/api/v1/workspaces/${ws}/reminders/${create.data.id}`)).status, 204);
});

test('welcome notification on join and long-running timer notification', async () => {
  assert.equal((await owner.call('POST', `/api/v1/workspaces/${ws}/users/${dev.user.id}/roles`, { role: 'WORKSPACE_ADMIN' })).status, 201);
  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'newbie@test.dev' });
  const newbie = await t.register({ email: 'newbie@test.dev', name: 'Newbie' });
  const welcome = await waitFor(async () => { const l = await notificationsOf(newbie, 'WELCOME'); return l.length ? l : null; });
  assert.ok(welcome, 'welcome notification missing');
  assert.match(welcome[0].title, /Welcome to WS/);
  // other admins are told; the admin who sent the invite is not
  const joined = await waitFor(async () => { const l = await notificationsOf(dev, 'MEMBER_JOINED'); return l.find((n) => n.payload.userId === newbie.user.id) || null; });
  assert.ok(joined, 'MEMBER_JOINED notification missing for the other admin');
  assert.match(joined.title, /newbie joined WS/i); // name known at invite time
  assert.ok(!(await notificationsOf(owner, 'MEMBER_JOINED')).find((n) => n.payload.userId === newbie.user.id));

  const { notifyLongRunningTimers } = await import('../src/modules/alerts/service.js');
  const start = new Date(Date.now() - 9 * 3600000).toISOString();
  const timer = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start, description: 'forgot to stop' });
  assert.equal(timer.status, 201, timer.text);
  assert.equal(await notifyLongRunningTimers({ hours: 8 }), 0); // user setting longRunning is off by default
  assert.equal((await owner.call('PATCH', '/api/v1/user/settings', { longRunning: true })).status, 200);
  assert.equal(await notifyLongRunningTimers({ hours: 8 }), 1);
  assert.equal(await notifyLongRunningTimers({ hours: 8 }), 0); // once per entry
  const long = await notificationsOf(owner, 'LONG_RUNNING_TIMER');
  assert.equal(long.length, 1);
  assert.equal(long[0].payload.entryId, timer.data.id);
  await owner.call('PATCH', `/api/v1/workspaces/${ws}/user/${owner.user.id}/time-entries`, {});
});
