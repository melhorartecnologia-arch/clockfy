import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestApp } from './helpers.js';

process.env.RATE_LIMIT_PER_SECOND = process.env.RATE_LIMIT_PER_SECOND || '1000'; // tests fire many requests per second

let t; let owner; let ws; let receiver; let receiverUrl;
const received = [];

before(async () => {
  t = await setupTestApp('webhooks');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      received.push({ url: req.url, headers: req.headers, body: parsed });
      res.writeHead(req.url.startsWith('/fail') ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !req.url.startsWith('/fail') }));
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
});
after(async () => { await new Promise((resolve) => receiver.close(resolve)); await t.close(); });

async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('webhook CRUD and delivery of NEW_TIME_ENTRY with Clockify headers', async () => {
  const create = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks`, { name: 'hook', url: `${receiverUrl}/hook`, webhookEvent: 'NEW_TIME_ENTRY', triggerSource: [ws], triggerSourceType: 'WORKSPACE_ID' });
  assert.equal(create.status, 201, create.text);
  const hook = create.data;
  assert.ok(hook.id && hook.authToken.length >= 32);
  assert.equal(hook.webhookEvent, 'NEW_TIME_ENTRY');
  assert.equal(hook.triggerSourceType, 'WORKSPACE_ID');
  assert.deepEqual(hook.triggerSource, [ws]);
  assert.equal(hook.enabled, true);
  assert.equal(hook.deliveryEnabled, true);
  assert.equal(hook.planEnabled, true);
  assert.equal(hook.userId, owner.user.id);
  assert.equal(hook.workspaceId, ws);

  const listed = await owner.call('GET', `/api/v1/workspaces/${ws}/webhooks`);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.workspaceWebhookCount, 1);
  assert.equal(listed.data.webhooks[0].id, hook.id);
  const got = await owner.call('GET', `/api/v1/workspaces/${ws}/webhooks/${hook.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.authToken, hook.authToken);

  const project = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'P1' });
  assert.equal(project.status, 201);
  const entry = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-05T10:00:00Z', end: '2026-01-05T11:00:00Z', projectId: project.data.id, description: 'hooked' });
  assert.equal(entry.status, 201);

  const msg = await waitFor(() => received.find((r) => r.url === '/hook' && r.body && r.body.id === entry.data.id));
  assert.ok(msg, 'webhook was not delivered within 3s');
  assert.equal(msg.headers['clockify-signature'], hook.authToken);
  assert.equal(msg.headers['clockify-webhook-event-type'], 'NEW_TIME_ENTRY');
  assert.equal(msg.headers['content-type'], 'application/json');
  assert.equal(msg.headers['user-agent'], 'Clockfy-Webhooks');
  assert.equal(msg.body.workspaceId, ws);
  assert.equal(msg.body.description, 'hooked');
  assert.equal(msg.body.userId, owner.user.id);
  assert.equal(msg.body.project.name, 'P1');
  assert.equal(msg.body.user.id, owner.user.id);
  assert.equal(msg.body.timeInterval.duration, 'PT1H');
  assert.equal(msg.body.currentlyRunning, false);

  // delivery log (POST /logs with WebhookLogSearchRequestV1)
  const logs = await waitFor(async () => {
    const r = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks/${hook.id}/logs?page=1&size=10`, { status: 'ALL', sortByNewest: true });
    assert.equal(r.status, 200, r.text);
    return r.data.length ? r.data : null;
  });
  assert.ok(logs, 'no delivery log found');
  assert.equal(logs[0].webhookId, hook.id);
  assert.equal(logs[0].statusCode, 200);
  assert.ok(logs[0].webhookEventStatusId);
  assert.ok(logs[0].respondedAt);
  assert.equal(JSON.parse(logs[0].requestBody).id, entry.data.id);
  assert.equal(JSON.parse(logs[0].responseBody).ok, true);
  const succeeded = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks/${hook.id}/logs`, { status: 'SUCCEEDED' });
  assert.equal(succeeded.data.length, 1);
  const failed = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks/${hook.id}/logs`, { status: 'FAILED' });
  assert.equal(failed.data.length, 0);
  const outOfRange = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks/${hook.id}/logs`, { from: '2030-01-01T00:00:00Z' });
  assert.equal(outOfRange.data.length, 0);

  // token regeneration
  const tok = await owner.call('PATCH', `/api/v1/workspaces/${ws}/webhooks/${hook.id}/token`);
  assert.equal(tok.status, 200);
  assert.notEqual(tok.data.authToken, hook.authToken);

  // update
  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/webhooks/${hook.id}`, { name: 'renamed', url: `${receiverUrl}/hook2`, webhookEvent: 'TIMER_STOPPED', triggerSource: [ws], triggerSourceType: 'WORKSPACE_ID' });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.data.name, 'renamed');
  assert.equal(upd.data.webhookEvent, 'TIMER_STOPPED');
  assert.equal(upd.data.url, `${receiverUrl}/hook2`);

  // delete
  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/webhooks/${hook.id}`);
  assert.equal(del.status, 200);
  const gone = await owner.call('GET', `/api/v1/workspaces/${ws}/webhooks/${hook.id}`);
  assert.equal(gone.status, 404);
});

test('PROJECT_ID trigger source only delivers events of the selected projects', async () => {
  const p1 = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Filtered A' });
  const p2 = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Filtered B' });
  const create = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks`, { name: 'by-project', url: `${receiverUrl}/project-filter`, webhookEvent: 'NEW_TIME_ENTRY', triggerSource: [p1.data.id], triggerSourceType: 'PROJECT_ID' });
  assert.equal(create.status, 201, create.text);
  assert.deepEqual(create.data.triggerSource, [p1.data.id]);

  const e2 = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-06T10:00:00Z', end: '2026-01-06T11:00:00Z', projectId: p2.data.id, description: 'other project' });
  const e1 = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-06T12:00:00Z', end: '2026-01-06T13:00:00Z', projectId: p1.data.id, description: 'selected project' });
  assert.equal(e1.status, 201); assert.equal(e2.status, 201);

  const got = await waitFor(() => received.find((r) => r.url === '/project-filter' && r.body && r.body.id === e1.data.id));
  assert.ok(got, 'entry of the selected project was not delivered');
  assert.equal(got.headers['clockify-webhook-event-type'], 'NEW_TIME_ENTRY');
  assert.equal(got.body.projectId, p1.data.id);
  await sleep(300);
  assert.ok(!received.find((r) => r.url === '/project-filter' && r.body && r.body.id === e2.data.id), 'entry of another project must not be delivered');

  // a webhook for another event type is not triggered by time entry creation
  const other = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks`, { name: 'projects', url: `${receiverUrl}/new-project`, webhookEvent: 'NEW_PROJECT', triggerSource: [ws], triggerSourceType: 'WORKSPACE_ID' });
  assert.equal(other.status, 201);
  const p3 = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Announced' });
  const gotProject = await waitFor(() => received.find((r) => r.url === '/new-project' && r.body && r.body.id === p3.data.id));
  assert.ok(gotProject, 'NEW_PROJECT was not delivered');
  assert.equal(gotProject.headers['clockify-webhook-event-type'], 'NEW_PROJECT');
  assert.equal(gotProject.body.name, 'Announced');
  await owner.call('DELETE', `/api/v1/workspaces/${ws}/webhooks/${other.data.id}`);
});

test('failed deliveries are logged with the status code and scheduled for retry', async () => {
  const create = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks`, { name: 'failing', url: `${receiverUrl}/fail`, webhookEvent: 'NEW_TIME_ENTRY', triggerSource: [ws], triggerSourceType: 'WORKSPACE_ID' });
  assert.equal(create.status, 201);
  const entry = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start: '2026-01-07T10:00:00Z', end: '2026-01-07T11:00:00Z', description: 'will fail' });
  assert.equal(entry.status, 201);
  const logs = await waitFor(async () => {
    const r = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks/${create.data.id}/logs`, { status: 'FAILED' });
    return r.data.length ? r.data : null;
  });
  assert.ok(logs, 'failed delivery was not logged');
  assert.equal(logs[0].statusCode, 500);
  assert.equal(logs[0].succeeded, false);
  assert.equal(logs[0].attempt, 1);
  assert.ok(logs[0].nextAttemptAt, 'a retry must be scheduled');
  const hook = await owner.call('GET', `/api/v1/workspaces/${ws}/webhooks/${create.data.id}`);
  assert.equal(hook.data.deliveryEnabled, true);
  assert.equal(hook.data.consecutiveFailures, 1);

  // the retry job re-sends pending deliveries (force the retry time to now)
  await t.db.query('UPDATE webhook_deliveries SET next_attempt_at = now() WHERE webhook_id = $1', [create.data.id]);
  const { processPendingDeliveries } = await import('../src/modules/webhooks/service.js');
  const retried = await processPendingDeliveries();
  assert.equal(retried, 1);
  const after2 = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks/${create.data.id}/logs`, { status: 'FAILED', sortByNewest: true });
  assert.equal(after2.data.length, 2);
  assert.equal(after2.data[0].attempt, 2);
  assert.equal(after2.data[0].webhookEventStatusId, logs[0].webhookEventStatusId);

  // test endpoint: never retried
  const testRes = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks/${create.data.id}/test`);
  assert.equal(testRes.status, 200);
  assert.equal(testRes.data.statusCode, 500);
  assert.equal(testRes.data.nextAttemptAt, null);
  await owner.call('DELETE', `/api/v1/workspaces/${ws}/webhooks/${create.data.id}`);
});

test('dispatchWebhookEvent can be used directly and disables delivery after 5 consecutive failures', async () => {
  const create = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks`, { name: 'direct', url: `${receiverUrl}/fail-direct`, webhookEvent: 'NEW_CLIENT', triggerSource: [ws], triggerSourceType: 'WORKSPACE_ID' });
  const { dispatchWebhookEvent } = await import('../src/modules/webhooks/service.js');
  for (let i = 0; i < 5; i++) {
    const results = await dispatchWebhookEvent(ws, 'NEW_CLIENT', { id: `c${i}`, name: 'x' }, {});
    assert.equal(results.length, 1);
    assert.equal(results[0].succeeded, false);
  }
  const hook = await owner.call('GET', `/api/v1/workspaces/${ws}/webhooks/${create.data.id}`);
  assert.equal(hook.data.deliveryEnabled, false);
  const skipped = await dispatchWebhookEvent(ws, 'NEW_CLIENT', { id: 'c9' }, {});
  assert.equal(skipped.length, 0);
  // re-enabling via PUT resets the failure state
  const re = await owner.call('PUT', `/api/v1/workspaces/${ws}/webhooks/${create.data.id}`, { enabled: true });
  assert.equal(re.data.deliveryEnabled, true);
  await owner.call('DELETE', `/api/v1/workspaces/${ws}/webhooks/${create.data.id}`);
});

test('validation and permissions', async () => {
  const badUrl = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks`, { url: 'ftp://example.com/x', webhookEvent: 'NEW_TIME_ENTRY', triggerSource: [ws], triggerSourceType: 'WORKSPACE_ID' });
  assert.equal(badUrl.status, 400);
  const badEvent = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks`, { url: 'https://example.com/x', webhookEvent: 'NOPE', triggerSource: [ws], triggerSourceType: 'WORKSPACE_ID' });
  assert.equal(badEvent.status, 400);
  const noSource = await owner.call('POST', `/api/v1/workspaces/${ws}/webhooks`, { url: 'https://example.com/x', webhookEvent: 'NEW_TIME_ENTRY', triggerSource: [], triggerSourceType: 'PROJECT_ID' });
  assert.equal(noSource.status, 400);

  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'member@test.dev' });
  const member = await t.register({ email: 'member@test.dev', name: 'Member' });
  const denied = await member.call('GET', `/api/v1/workspaces/${ws}/webhooks`);
  assert.equal(denied.status, 403);

  const addon = await owner.call('GET', `/api/v1/workspaces/${ws}/addons/64c777ddd3fcab07cfbb210c/webhooks`);
  assert.equal(addon.status, 200);
  assert.deepEqual(addon.data.webhooks, []);
});
