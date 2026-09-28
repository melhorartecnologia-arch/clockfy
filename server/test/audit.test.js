import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

process.env.RATE_LIMIT_PER_SECOND = process.env.RATE_LIMIT_PER_SECOND || '1000'; // tests fire many requests per second

let t; let owner; let ws;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  t = await setupTestApp('audit');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
});
after(async () => { await t.close(); });

test('audit log lists the project creation (POST /audit-log, Clockify format)', async () => {
  const project = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Audited project', billable: true });
  assert.equal(project.status, 201);

  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/audit-log`, {
    actions: ['CREATE_PROJECT'], authors: { authorIds: [owner.user.id], contains: 'CONTAINS' },
    start: '2020-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z', page: 1, 'page-size': 20,
  });
  assert.equal(r.status, 200, r.text);
  assert.ok(Array.isArray(r.data.response));
  const entry = r.data.response.find((e) => e.entityId === project.data.id);
  assert.ok(entry, 'CREATE_PROJECT audit entry not found');
  assert.equal(entry.action, 'CREATE_PROJECT');
  assert.equal(entry.entityType, 'PROJECT');
  assert.equal(entry.userId, owner.user.id);
  assert.equal(entry.userName, 'Owner');
  assert.equal(entry.userEmail, owner.user.email);
  assert.equal(entry.workspaceId, ws);
  assert.equal(typeof entry.content, 'string');
  assert.ok(entry.content.includes('Audited project'));
  assert.equal(entry.previousContent, null);
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(r.data.response.every((e) => e.action === 'CREATE_PROJECT'));

  const excluded = await owner.call('POST', `/api/v1/workspaces/${ws}/audit-log`, { actions: ['CREATE_PROJECT'], authors: { authorIds: [owner.user.id], contains: 'DOES_NOT_CONTAIN' }, start: '2020-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' });
  assert.equal(excluded.data.response.length, 0);
  const authorsAsArray = await owner.call('POST', `/api/v1/workspaces/${ws}/audit-log`, { actions: ['CREATE_PROJECT'], authors: [owner.user.id], start: '2020-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' });
  assert.equal(authorsAsArray.data.response.length, 1);
  const outOfRange = await owner.call('POST', `/api/v1/workspaces/${ws}/audit-log`, { actions: ['CREATE_PROJECT'], authors: [owner.user.id], start: '2000-01-01T00:00:00Z', end: '2000-12-31T00:00:00Z' });
  assert.equal(outOfRange.data.response.length, 0);

  // GET variant with query params (UI)
  const g = await owner.call('GET', `/api/v1/workspaces/${ws}/audit-log?actions=CREATE_PROJECT&authors=${owner.user.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.data.response.length, 1);
  assert.equal(g.data.total, 1);

  // also reachable through the reports prefix used by Clockify's audit log host
  const viaReports = await owner.call('POST', `/reports/v1/workspaces/${ws}/audit-log`, { actions: ['CREATE_PROJECT'], authors: [owner.user.id], start: '2020-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' });
  assert.equal(viaReports.status, 200);
  assert.equal(viaReports.data.response.length, 1);

  // time entry actions are audited too
  const te = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-05T10:00:00Z', end: '2026-01-05T11:00:00Z', projectId: project.data.id, description: 'audited' });
  assert.equal(te.status, 201);
  const teLog = await owner.call('POST', `/api/v1/workspaces/${ws}/audit-log`, { actions: ['CREATE_TIME_PERSONAL_MANUAL'], authors: [owner.user.id], start: '2020-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' });
  assert.equal(teLog.data.response.length, 1);
  assert.equal(teLog.data.response[0].entityId, te.data.id);
});

test('audit log is admin only', async () => {
  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'member@test.dev' });
  const member = await t.register({ email: 'member@test.dev', name: 'Member' });
  const denied = await member.call('POST', `/api/v1/workspaces/${ws}/audit-log`, { actions: ['CREATE_PROJECT'], authors: [owner.user.id], start: '2020-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' });
  assert.equal(denied.status, 403);
});

test('entity changes: created / updated / deleted', async () => {
  const project = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Changing project' });
  const client = await owner.call('POST', `/api/v1/workspaces/${ws}/clients`, { name: 'Changing client' });
  assert.equal(project.status, 201); assert.equal(client.status, 201);

  const created = await owner.call('GET', `/api/v1/workspaces/${ws}/entities/created?type=PROJECT&type=CLIENT&start=2020-01-01T00:00:00Z&end=2100-01-01T00:00:00Z`);
  assert.equal(created.status, 200, created.text);
  assert.ok(created.data.items.find((i) => i.id === project.data.id && i.entityType === 'PROJECT'));
  assert.ok(created.data.items.find((i) => i.id === client.data.id && i.entityType === 'CLIENT'));
  assert.equal(created.data.page, 0);
  const noType = await owner.call('GET', `/api/v1/workspaces/${ws}/entities/created`);
  assert.equal(noType.status, 400);

  await sleep(60);
  const rangeStart = new Date().toISOString();
  await sleep(60);
  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/projects/${project.data.id}`, { name: 'Changed project' });
  assert.equal(upd.status, 200);
  const updated = await owner.call('GET', `/api/v1/workspaces/${ws}/entities/updated?type=PROJECT&start=${rangeStart}`);
  assert.equal(updated.status, 200, updated.text);
  const u = updated.data.items.find((i) => i.id === project.data.id);
  assert.ok(u, 'updated project not listed');
  assert.equal(u.name, 'Changed project');
  // entities created inside the range are not listed as updated
  const fresh = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Fresh project' });
  await owner.call('PUT', `/api/v1/workspaces/${ws}/projects/${fresh.data.id}`, { name: 'Fresh project 2' });
  const updated2 = await owner.call('GET', `/api/v1/workspaces/${ws}/entities/updated?type=PROJECT&start=${rangeStart}`);
  assert.ok(!updated2.data.items.find((i) => i.id === fresh.data.id));

  const te = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-06T10:00:00Z', end: '2026-01-06T11:00:00Z', projectId: project.data.id, description: 'to delete' });
  await sleep(60);
  const delStart = new Date().toISOString();
  await sleep(60);
  assert.equal((await owner.call('DELETE', `/api/v1/workspaces/${ws}/time-entries/${te.data.id}`)).status, 204);
  assert.equal((await owner.call('PUT', `/api/v1/workspaces/${ws}/projects/${project.data.id}`, { archived: true })).status, 200); // Clockify: archive before delete
  const delProject = await owner.call('DELETE', `/api/v1/workspaces/${ws}/projects/${project.data.id}`);
  assert.equal(delProject.status, 200, delProject.text);
  const deleted = await owner.call('GET', `/api/v1/workspaces/${ws}/entities/deleted?type=TIMEENTRY&type=PROJECT&start=${delStart}`);
  assert.equal(deleted.status, 200, deleted.text);
  const dte = deleted.data.items.find((i) => i.id === te.data.id);
  assert.ok(dte, 'deleted time entry not listed');
  assert.equal(dte.documentCode, 'TIMEENTRY');
  assert.ok(dte.deletedAt);
  assert.equal(dte.document.description, 'to delete');
  const dp = deleted.data.items.find((i) => i.id === project.data.id);
  assert.ok(dp, 'deleted project not listed');
  assert.equal(dp.documentCode, 'PROJECT');
  assert.equal(dp.document.name, 'Changed project');
});
