import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

let t; let owner;
before(async () => { t = await setupTestApp('core'); owner = await t.register({ name: 'Owner', workspaceName: 'WS' }); });
after(async () => { await t.close(); });

test('register creates a workspace and returns user', async () => {
  assert.ok(owner.workspaceId);
  const me = await owner.call('GET', '/api/v1/user');
  assert.equal(me.status, 200);
  assert.equal(me.data.activeWorkspace, owner.workspaceId);
});

test('API key authenticates like Clockify (X-Api-Key)', async () => {
  const k = await owner.call('POST', '/api/v1/auth/api-keys', { name: 'k' });
  assert.equal(k.status, 201);
  const me = await t.api(null, { 'X-Api-Key': k.data.apiKey })('GET', '/api/v1/user');
  assert.equal(me.status, 200);
  assert.equal(me.data.id, owner.user.id);
});

test('client/project/task/tag/time entry lifecycle', async () => {
  const ws = owner.workspaceId;
  const client = await owner.call('POST', `/api/v1/workspaces/${ws}/clients`, { name: 'ACME' });
  assert.equal(client.status, 201);
  assert.deepEqual(client.data.ccEmails, []);
  const project = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'P1', clientId: client.data.id, billable: true, hourlyRate: { amount: 5000, currency: 'USD' }, tasks: [{ name: 'T1' }] });
  assert.equal(project.status, 201);
  assert.equal(project.data.tasks.length, 1);
  const tag = await owner.call('POST', `/api/v1/workspaces/${ws}/tags`, { name: 'tag1' });
  assert.equal(tag.status, 201);
  const timer = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-05T10:00:00Z', projectId: project.data.id, taskId: project.data.tasks[0].id, tagIds: [tag.data.id], description: 'work' });
  assert.equal(timer.status, 201);
  assert.equal(timer.data.timeInterval.end, null);
  assert.equal(timer.data.hourlyRate.amount, 5000);
  const stopped = await owner.call('PATCH', `/api/v1/workspaces/${ws}/user/${owner.user.id}/time-entries`, { end: '2026-01-05T11:30:00Z' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.timeInterval.duration, 'PT1H30M');
  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/user/${owner.user.id}/time-entries?hydrated=true`);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].project.name, 'P1');
  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/time-entries/${timer.data.id}`, { start: '2026-01-05T10:00:00Z', end: '2026-01-05T12:00:00Z', description: 'edited', billable: false });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.description, 'edited');
  assert.equal(upd.data.timeInterval.duration, 'PT2H');
  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/time-entries/${timer.data.id}`);
  assert.equal(del.status, 204);
  const after = await owner.call('GET', `/api/v1/workspaces/${ws}/user/${owner.user.id}/time-entries`);
  assert.equal(after.data.length, 0);
});

test('required fields settings are enforced', async () => {
  const ws = owner.workspaceId;
  await owner.call('PUT', `/api/v1/workspaces/${ws}/settings`, { forceProjects: true });
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-06T10:00:00Z', end: '2026-01-06T11:00:00Z' });
  assert.equal(r.status, 400);
  await owner.call('PUT', `/api/v1/workspaces/${ws}/settings`, { forceProjects: false });
});

test('invited member has restricted permissions', async () => {
  const ws = owner.workspaceId;
  const inv = await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'member@test.dev' });
  assert.equal(inv.status, 200);
  const member = await t.register({ email: 'member@test.dev', name: 'Member' });
  const denied = await member.call('POST', `/api/v1/workspaces/${ws}/clients`, { name: 'X' });
  assert.equal(denied.status, 403);
  const users = await owner.call('GET', `/api/v1/workspaces/${ws}/users`);
  assert.equal(users.data.length, 2);
  const role = await owner.call('POST', `/api/v1/workspaces/${ws}/users/${member.user.id}/roles`, { role: 'WORKSPACE_ADMIN' });
  assert.equal(role.status, 201);
  const ok = await member.call('POST', `/api/v1/workspaces/${ws}/clients`, { name: 'X' });
  assert.equal(ok.status, 201);
});
