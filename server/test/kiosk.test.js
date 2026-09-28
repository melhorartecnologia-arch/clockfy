import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

process.env.RATE_LIMIT_PER_SECOND = process.env.RATE_LIMIT_PER_SECOND || '1000'; // tests fire many requests per second

let t; let owner; let ws; let project; let kiosk;

before(async () => {
  t = await setupTestApp('kiosk');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
  const p = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Kiosk project' });
  project = p.data;
});
after(async () => { await t.close(); });

test('admin creates a kiosk and sets the member PIN', async () => {
  const create = await owner.call('POST', `/api/v1/workspaces/${ws}/kiosks`, { name: 'Front desk', defaultProjectId: project.id, sessionDurationSeconds: 3600 });
  assert.equal(create.status, 201, create.text);
  kiosk = create.data;
  assert.equal(kiosk.name, 'Front desk');
  assert.equal(kiosk.code.length, 8);
  assert.ok(kiosk.url.endsWith(`/kiosk/${kiosk.code}`));
  assert.equal(kiosk.pinRequired, true);
  assert.equal(kiosk.defaultProjectId, project.id);
  assert.equal(kiosk.active, true);

  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/kiosks`);
  assert.equal(list.data.length, 1);
  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/kiosks/${kiosk.id}`, { name: 'Reception' });
  assert.equal(upd.data.name, 'Reception');

  const badPin = await owner.call('PUT', `/api/v1/workspaces/${ws}/users/${owner.user.id}/kiosk-pin`, { pin: '12' });
  assert.equal(badPin.status, 400);
  const pin = await owner.call('PUT', `/api/v1/workspaces/${ws}/users/${owner.user.id}/kiosk-pin`, { pin: '1234' });
  assert.equal(pin.status, 200, pin.text);
  assert.equal(pin.data.kioskPinSet, true);
  const stored = await t.db.one('SELECT kiosk_pin FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [ws, owner.user.id]);
  assert.equal(stored.kiosk_pin.length, 64); // sha256 hex
  assert.notEqual(stored.kiosk_pin, '1234');
});

test('public flow: PIN login → clock-in → break → clock-out → logout', async () => {
  const anon = t.api();
  const info = await anon('GET', `/api/v1/kiosk/${kiosk.code}`);
  assert.equal(info.status, 200, info.text);
  assert.equal(info.data.id, kiosk.id);
  assert.equal(info.data.workspaceName, 'WS');
  assert.equal(info.data.pinRequired, true);
  const me = info.data.members.find((m) => m.id === owner.user.id);
  assert.ok(me && me.hasPin);

  const wrong = await anon('POST', `/api/v1/kiosk/${kiosk.code}/login`, { userId: owner.user.id, pin: '9999' });
  assert.equal(wrong.status, 401);
  const login = await anon('POST', `/api/v1/kiosk/${kiosk.code}/login`, { userId: owner.user.id, pin: '1234' });
  assert.equal(login.status, 200, login.text);
  assert.ok(login.data.token);
  assert.equal(login.data.user.id, owner.user.id);
  assert.equal(login.data.status.clockedIn, false);

  // the kiosk token is not a regular API token
  const notApi = await t.api(login.data.token)('GET', '/api/v1/user');
  assert.equal(notApi.status, 401);

  const k = t.api(login.data.token);
  const status0 = await k('GET', `/api/v1/kiosk/${kiosk.code}/status`);
  assert.equal(status0.status, 200, status0.text);
  assert.equal(status0.data.running, null);

  const clockIn = await k('POST', `/api/v1/kiosk/${kiosk.code}/clock-in`, {});
  assert.equal(clockIn.status, 201, clockIn.text);
  assert.equal(clockIn.data.clockedIn, true);
  assert.equal(clockIn.data.onBreak, false);
  assert.equal(clockIn.data.running.projectId, project.id);
  assert.equal(clockIn.data.running.kioskId, kiosk.id);
  assert.equal(clockIn.data.running.type, 'REGULAR');
  const again = await k('POST', `/api/v1/kiosk/${kiosk.code}/clock-in`, {});
  assert.equal(again.status, 400);

  const breakStart = await k('POST', `/api/v1/kiosk/${kiosk.code}/break-start`);
  assert.equal(breakStart.status, 201, breakStart.text);
  assert.equal(breakStart.data.onBreak, true);
  assert.equal(breakStart.data.running.type, 'BREAK');
  const breakAgain = await k('POST', `/api/v1/kiosk/${kiosk.code}/break-start`);
  assert.equal(breakAgain.status, 400);

  const breakEnd = await k('POST', `/api/v1/kiosk/${kiosk.code}/break-end`);
  assert.equal(breakEnd.status, 201, breakEnd.text);
  assert.equal(breakEnd.data.onBreak, false);
  assert.equal(breakEnd.data.clockedIn, true);
  assert.equal(breakEnd.data.running.type, 'REGULAR');
  assert.equal(breakEnd.data.running.projectId, project.id);

  const clockOut = await k('POST', `/api/v1/kiosk/${kiosk.code}/clock-out`);
  assert.equal(clockOut.status, 200, clockOut.text);
  assert.equal(clockOut.data.clockedIn, false);
  assert.equal(clockOut.data.running, null);
  assert.ok(clockOut.data.todayTotalSeconds >= 0);
  assert.match(clockOut.data.todayTotal, /^PT/);
  const clockOutAgain = await k('POST', `/api/v1/kiosk/${kiosk.code}/clock-out`);
  assert.equal(clockOutAgain.status, 404);

  const entries = await t.db.rows('SELECT type, origin, kiosk_id, end_time FROM time_entries WHERE workspace_id = $1 AND user_id = $2 ORDER BY start_time', [ws, owner.user.id]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.type), ['REGULAR', 'BREAK', 'REGULAR']);
  assert.ok(entries.every((e) => e.origin === 'KIOSK' && e.kiosk_id === kiosk.id && e.end_time));
  const audits = await t.db.rows("SELECT action FROM audit_log WHERE workspace_id = $1 AND action = 'CREATE_TIME_KIOSK'", [ws]);
  assert.equal(audits.length, 3);

  const logout = await k('POST', `/api/v1/kiosk/${kiosk.code}/logout`);
  assert.equal(logout.status, 200);
  const afterLogout = await k('GET', `/api/v1/kiosk/${kiosk.code}/status`);
  assert.equal(afterLogout.status, 401);
  const noToken = await anon('GET', `/api/v1/kiosk/${kiosk.code}/status`);
  assert.equal(noToken.status, 401);
});

test('kiosk member restrictions and code regeneration', async () => {
  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'staff@test.dev' });
  const staff = await t.register({ email: 'staff@test.dev', name: 'Staff' });
  const restricted = await owner.call('PUT', `/api/v1/workspaces/${ws}/kiosks/${kiosk.id}`, { userIds: [staff.user.id], pinRequired: false });
  assert.equal(restricted.status, 200);
  const anon = t.api();
  const info = await anon('GET', `/api/v1/kiosk/${kiosk.code}`);
  assert.deepEqual(info.data.members.map((m) => m.id), [staff.user.id]);
  const denied = await anon('POST', `/api/v1/kiosk/${kiosk.code}/login`, { userId: owner.user.id, pin: '1234' });
  assert.equal(denied.status, 403);
  const ok = await anon('POST', `/api/v1/kiosk/${kiosk.code}/login`, { userId: staff.user.id });
  assert.equal(ok.status, 200, ok.text);

  // a member (non-admin) cannot manage kiosks but can set their own PIN
  const forbidden = await staff.call('GET', `/api/v1/workspaces/${ws}/kiosks`);
  assert.equal(forbidden.status, 403);
  const ownPin = await staff.call('PUT', `/api/v1/workspaces/${ws}/users/${staff.user.id}/kiosk-pin`, { pin: '5678' });
  assert.equal(ownPin.status, 200);
  const othersPin = await staff.call('PUT', `/api/v1/workspaces/${ws}/users/${owner.user.id}/kiosk-pin`, { pin: '5678' });
  assert.equal(othersPin.status, 403);

  const regen = await owner.call('POST', `/api/v1/workspaces/${ws}/kiosks/${kiosk.id}/regenerate-code`);
  assert.equal(regen.status, 200);
  assert.notEqual(regen.data.code, kiosk.code);
  const old = await anon('GET', `/api/v1/kiosk/${kiosk.code}`);
  assert.equal(old.status, 404);
  const fresh = await anon('GET', `/api/v1/kiosk/${regen.data.code}`);
  assert.equal(fresh.status, 200);
  const revoked = await t.api(ok.data.token)('GET', `/api/v1/kiosk/${regen.data.code}/status`);
  assert.equal(revoked.status, 401);

  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/kiosks/${kiosk.id}`);
  assert.equal(del.status, 204);
  const gone = await anon('GET', `/api/v1/kiosk/${regen.data.code}`);
  assert.equal(gone.status, 404);
});
