import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

// this file runs with approvals on (the production default)
process.env.REGISTRATION_APPROVAL = 'true';

let t; let admin; let outbox;
const PENDING = 'PENDING_APPROVAL';
const signUp = (email, extra = {}) => t.api()('POST', '/api/v1/auth/register', { email, password: 'secret123', name: extra.name || email.split('@')[0], ...extra });
const login = (email, password = 'secret123') => t.api()('POST', '/api/v1/auth/login', { email, password });
const userRow = (email) => t.db.one('SELECT * FROM users WHERE lower(email) = $1', [email]);
const mailsTo = (email) => outbox.filter((m) => [].concat(m.to).join(',').includes(email));

before(async () => {
  t = await setupTestApp('accounts');
  ({ outbox } = await import('../src/lib/mailer.js'));
});
after(async () => { await t.close(); });

test('the first account of an installation is approved automatically and becomes system administrator', async () => {
  const info = await t.api()('GET', '/api/v1/auth/signup-info');
  assert.deepEqual(info.data, { approvalRequired: true });
  const r = await signUp('boss@test.dev', { name: 'Boss', workspaceName: 'Cervejaria' });
  assert.equal(r.status, 201, r.text);
  assert.ok(r.data.token);
  assert.equal(r.data.user.systemAdmin, true);
  admin = { token: r.data.token, user: r.data.user, workspaceId: r.data.user.activeWorkspace, call: t.api(r.data.token) };
  const me = await admin.call('GET', '/api/v1/user');
  assert.equal(me.data.systemAdmin, true);
});

test('a new sign-up waits for approval: no session, no workspace, administrators are told', async () => {
  const r = await signUp('ana@test.dev', { name: 'Ana', workspaceName: 'Workspace da Ana' });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.data.status, PENDING);
  assert.equal(r.data.token, undefined);
  assert.match(r.data.message, /aprovar/);
  const row = await userRow('ana@test.dev');
  assert.equal(row.status, PENDING);
  assert.equal(row.active_workspace_id, null);
  assert.equal(row.signup.workspaceName, 'Workspace da Ana');
  assert.equal(Number((await t.db.one('SELECT count(*) AS c FROM workspace_members WHERE user_id = $1', [row.id])).c), 0);

  // cannot sign in, not even after resetting the password
  const l = await login('ana@test.dev');
  assert.equal(l.status, 403);
  assert.equal(l.data.code, 1011);
  assert.match(l.data.message, /aguardando a aprovação/);
  const forgot = await t.api()('POST', '/api/v1/auth/forgot-password', { email: 'ana@test.dev' });
  const reset = await t.api()('POST', '/api/v1/auth/reset-password', { token: forgot.data.token, password: 'newpass123' });
  assert.equal(reset.status, 202, reset.text);
  assert.equal(reset.data.token, undefined);
  assert.equal((await userRow('ana@test.dev')).status, PENDING);
  assert.equal((await login('ana@test.dev', 'newpass123')).status, 403);

  // a token signed for a pending account is refused as well
  const { signToken } = await import('../src/lib/auth.js');
  const forged = await t.api(signToken({ sub: row.id, email: row.email }))('GET', '/api/v1/user');
  assert.equal(forged.status, 401);
  assert.equal(forged.data.code, 1011);

  // administrators: in-app notification + e-mail
  const notes = await admin.call('GET', '/api/v1/user/notifications');
  assert.ok(notes.data.notifications.some((n) => n.type === 'ACCOUNT_PENDING_APPROVAL' && /ana@test\.dev/.test(n.body)), notes.text);
  assert.ok(mailsTo('boss@test.dev').some((m) => /aguardando aprovação/.test(m.subject)));
});

test('only system administrators manage accounts', async () => {
  const list = await admin.call('GET', '/api/v1/admin/accounts');
  assert.equal(list.status, 200, list.text);
  assert.ok(list.data.accounts.some((a) => a.email === 'ana@test.dev' && a.status === PENDING && a.requestedWorkspaceName === 'Workspace da Ana'));
  const summary = await admin.call('GET', '/api/v1/admin/accounts/summary');
  assert.equal(summary.data.pending, 1);
  assert.equal(summary.data.registrationApproval, true);
  assert.equal((await t.api()('GET', '/api/v1/admin/accounts')).status, 401);
});

test('approving creates the requested workspace and lets the person in', async () => {
  const ana = await userRow('ana@test.dev');
  const r = await admin.call('POST', `/api/v1/admin/accounts/${ana.id}/approve`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.status, 'ACTIVE');
  assert.equal(r.data.workspace.name, 'Workspace da Ana');
  assert.equal(r.data.approvedBy.id, admin.user.id);
  const l = await login('ana@test.dev', 'newpass123');
  assert.equal(l.status, 200, l.text);
  assert.equal(l.data.user.activeWorkspace, r.data.workspace.id);
  assert.equal(l.data.user.systemAdmin, false);
  assert.ok(mailsTo('ana@test.dev').some((m) => /aprovada/.test(m.subject)));
  // an approved regular account cannot open the administration
  const denied = await t.api(l.data.token)('GET', '/api/v1/admin/accounts');
  assert.equal(denied.status, 403);
  // already active: cannot be approved or rejected again
  assert.equal((await admin.call('POST', `/api/v1/admin/accounts/${ana.id}/approve`, {})).status, 409);
  assert.equal((await admin.call('POST', `/api/v1/admin/accounts/${ana.id}/reject`, {})).status, 409);
});

test('approving into an existing workspace adds the person as a member', async () => {
  assert.equal((await signUp('bruno@test.dev', { name: 'Bruno' })).status, 202);
  const bruno = await userRow('bruno@test.dev');
  const ws = await admin.call('GET', '/api/v1/admin/workspaces');
  assert.ok(ws.data.some((w) => w.id === admin.workspaceId));
  const r = await admin.call('POST', `/api/v1/admin/accounts/${bruno.id}/approve`, { workspaceId: admin.workspaceId });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.workspace.id, admin.workspaceId);
  const l = await login('bruno@test.dev');
  assert.equal(l.status, 200);
  assert.equal(l.data.user.activeWorkspace, admin.workspaceId);
  assert.equal(Number((await t.db.one('SELECT count(*) AS c FROM workspaces WHERE owner_id = $1', [bruno.id])).c), 0, 'no workspace of his own');
  const member = await t.db.one('SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [admin.workspaceId, bruno.id]);
  assert.equal(member.status, 'ACTIVE');
});

test('rejecting blocks the account; deleting frees the e-mail', async () => {
  assert.equal((await signUp('spam@test.dev')).status, 202);
  const spam = await userRow('spam@test.dev');
  const r = await admin.call('POST', `/api/v1/admin/accounts/${spam.id}/reject`, { reason: 'Não é da empresa', notify: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.status, 'REJECTED');
  assert.equal(r.data.rejectionReason, 'Não é da empresa');
  const l = await login('spam@test.dev');
  assert.equal(l.status, 403);
  assert.equal(l.data.code, 1012);
  assert.ok(mailsTo('spam@test.dev').some((m) => /não foi aprovado/.test(m.subject) && /Não é da empresa/.test(m.text)));
  assert.equal((await signUp('spam@test.dev')).status, 409, 'cannot sign up again while the rejected account exists');
  const rejected = await admin.call('GET', '/api/v1/admin/accounts?status=REJECTED');
  assert.ok(rejected.data.accounts.some((a) => a.id === spam.id && a.rejectedBy.id === admin.user.id));
  assert.equal((await admin.call('DELETE', `/api/v1/admin/accounts/${spam.id}`)).status, 204);
  assert.equal(await userRow('spam@test.dev'), null);
  assert.equal((await signUp('spam@test.dev')).status, 202);
  // approved accounts are never deleted through this route
  const ana = await userRow('ana@test.dev');
  assert.equal((await admin.call('DELETE', `/api/v1/admin/accounts/${ana.id}`)).status, 409);
});

test('accounts created by an administrator are not taken over by a sign-up', async () => {
  const inv = await admin.call('POST', `/api/v1/workspaces/${admin.workspaceId}/users?send-email=false`, { email: 'carla@test.dev' });
  assert.equal(inv.status, 200, inv.text);
  const r = await signUp('carla@test.dev', { name: 'Intruso' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 1010);
  assert.match(r.data.message, /Esqueci minha senha/);
  const carla = await userRow('carla@test.dev');
  assert.equal(carla.password_hash, null, 'password not set by the sign-up');
  assert.equal(carla.status, 'PENDING_EMAIL_VERIFICATION');
  // the owner of the e-mail gets in through the reset link: no approval needed (an administrator invited her)
  const joined = await t.joinInvited({ email: 'carla@test.dev', name: 'Carla' });
  assert.equal((await userRow('carla@test.dev')).status, 'ACTIVE');
  assert.equal(joined.workspaceId, admin.workspaceId);
  const member = await t.db.one('SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [admin.workspaceId, carla.id]);
  assert.equal(member.status, 'ACTIVE');
});

test('an invitation to a pending sign-up does not approve it', async () => {
  assert.equal((await signUp('davi@test.dev', { name: 'Davi', workspaceName: 'Davi WS' })).status, 202);
  const inv = await admin.call('POST', `/api/v1/workspaces/${admin.workspaceId}/users?send-email=false`, { email: 'davi@test.dev' });
  assert.equal(inv.status, 200, inv.text);
  assert.equal((await login('davi@test.dev')).status, 403);
  const davi = await userRow('davi@test.dev');
  assert.equal(davi.status, PENDING);
  // approval without a workspace keeps him in the workspace that invited him instead of creating another one
  const r = await admin.call('POST', `/api/v1/admin/accounts/${davi.id}/approve`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.workspace, null);
  const l = await login('davi@test.dev');
  assert.equal(l.status, 200);
  assert.equal(l.data.user.activeWorkspace, admin.workspaceId);
});

test('system administrators can be added and removed, but never the last one', async () => {
  const ana = await userRow('ana@test.dev');
  const up = await admin.call('PUT', `/api/v1/admin/accounts/${ana.id}/system-admin`, { systemAdmin: true });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.data.systemAdmin, true);
  const anaSession = await login('ana@test.dev', 'newpass123');
  assert.equal((await t.api(anaSession.data.token)('GET', '/api/v1/admin/accounts')).status, 200);
  assert.equal((await admin.call('PUT', `/api/v1/admin/accounts/${ana.id}/system-admin`, { systemAdmin: false })).status, 200);
  assert.equal((await admin.call('PUT', `/api/v1/admin/accounts/${admin.user.id}/system-admin`, { systemAdmin: false })).status, 409, 'last administrator');
  const pending = await userRow('spam@test.dev');
  assert.equal((await admin.call('PUT', `/api/v1/admin/accounts/${pending.id}/system-admin`, { systemAdmin: true })).status, 409, 'only active accounts');
});

test('an installation without a system administrator promotes its oldest active account at startup', async () => {
  const { ensureSystemAdmin } = await import('../src/modules/accounts/service.js');
  assert.equal(await ensureSystemAdmin(), null, 'nothing to do while there is an administrator');
  await t.db.query('UPDATE users SET is_super_admin = false');
  const promoted = await ensureSystemAdmin();
  assert.equal(promoted.email, 'boss@test.dev');
  assert.equal((await userRow('boss@test.dev')).is_super_admin, true);
});

test('sign-up attempts are limited per client address', async () => {
  const { allowSignup } = await import('../src/modules/auth/index.js');
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) assert.equal(allowSignup('203.0.113.9', { max: 3, now: t0 + i }), true);
  assert.equal(allowSignup('203.0.113.9', { max: 3, now: t0 + 10 }), false, 'fourth attempt within the hour');
  assert.equal(allowSignup('198.51.100.7', { max: 3, now: t0 + 10 }), true, 'other addresses are not affected');
  assert.equal(allowSignup('203.0.113.9', { max: 3, now: t0 + 3600e3 + 5 }), true, 'allowed again after an hour');
  // behind the local reverse proxy the address it appended counts, not one forged by the client before it
  const r = await t.api()('POST', '/api/v1/auth/register', { email: 'xff@test.dev', password: 'secret123' }, { headers: { 'X-Forwarded-For': '1.1.1.1, 203.0.113.50' } });
  assert.equal(r.status, 202, r.text);
  assert.equal((await userRow('xff@test.dev')).signup.ip, '203.0.113.50');
});
