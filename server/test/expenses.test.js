import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

process.env.RATE_LIMIT_PER_SECOND = process.env.RATE_LIMIT_PER_SECOND || '10000'; // the suite fires many requests per second

let t; let owner; let ws; let project; let task; let meals; let mileage;

before(async () => {
  t = await setupTestApp('expenses');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
  const client = await owner.call('POST', `/api/v1/workspaces/${ws}/clients`, { name: 'ACME' });
  const p = await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'P1', clientId: client.data.id, billable: true, hourlyRate: { amount: 5000, currency: 'USD' }, tasks: [{ name: 'T1' }] });
  project = p.data; task = p.data.tasks[0];
});
after(async () => { await t.close(); });

test('expense categories CRUD (admin only)', async () => {
  const c1 = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses/categories`, { name: 'Meals' });
  assert.equal(c1.status, 201);
  assert.equal(c1.data.hasUnitPrice, false);
  assert.equal(c1.data.workspaceId, ws);
  meals = c1.data;
  const c2 = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses/categories`, { name: 'Mileage', hasUnitPrice: true, unit: 'km', priceInCents: 150 });
  assert.equal(c2.status, 201);
  assert.equal(c2.data.priceInCents, 150);
  mileage = c2.data;
  const dup = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses/categories`, { name: 'meals' });
  assert.equal(dup.status, 400);

  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/categories?sort-column=NAME&sort-order=DESCENDING`);
  assert.equal(list.status, 200);
  assert.equal(list.data.count, 2);
  assert.equal(list.data.categories[0].name, 'Mileage');
  const byName = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/categories?name=mile`);
  assert.equal(byName.data.count, 1);

  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/expenses/categories/${meals.id}`, { name: 'Meals & drinks' });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.name, 'Meals & drinks');

  const tmp = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses/categories`, { name: 'Temp' });
  const arch = await owner.call('PATCH', `/api/v1/workspaces/${ws}/expenses/categories/${tmp.data.id}/status`, { archived: true });
  assert.equal(arch.status, 200);
  assert.equal(arch.data.archived, true);
  const archived = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/categories?archived=true`);
  assert.equal(archived.data.count, 1);
  const active = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/categories?archived=false`);
  assert.equal(active.data.count, 2);
  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/expenses/categories/${tmp.data.id}`);
  assert.equal(del.status, 204);
});

test('create expense (JSON) – totals for plain and unit-priced categories', async () => {
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses`, { date: '2026-03-10T00:00:00Z', projectId: project.id, taskId: task.id, categoryId: meals.id, amount: 12.5, notes: 'Lunch', billable: true });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.date, '2026-03-10');
  assert.equal(r.data.total, 12.5);
  assert.equal(r.data.quantity, 1);
  assert.equal(r.data.userId, owner.user.id);
  assert.equal(r.data.project.name, 'P1');
  assert.equal(r.data.project.clientName, 'ACME');
  assert.equal(r.data.task.name, 'T1');
  assert.equal(r.data.category.name, 'Meals & drinks');
  assert.equal(r.data.billable, true);
  assert.equal(r.data.locked, false);
  assert.equal(r.data.fileId, null);

  const km = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses`, { date: '2026-03-11', projectId: project.id, categoryId: mileage.id, amount: 10 });
  assert.equal(km.status, 201, km.text);
  assert.equal(km.data.quantity, 10);
  assert.equal(km.data.total, 15); // 10 km × 1.50
  assert.equal(km.data.billable, true); // defaults to the project's billable flag

  const noProject = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses`, { date: '2026-03-11', categoryId: meals.id, amount: 1 });
  assert.equal(noProject.status, 400);
  const badTask = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses`, { date: '2026-03-11', projectId: project.id, taskId: '000000000000000000000000', categoryId: meals.id, amount: 1 });
  assert.equal(badTask.status, 400);
});

test('create expense (multipart) with receipt and download it', async () => {
  const fd = new FormData();
  fd.append('date', '2026-03-12');
  fd.append('projectId', project.id);
  fd.append('categoryId', meals.id);
  fd.append('amount', '33.3');
  fd.append('billable', 'false');
  fd.append('notes', 'Taxi');
  fd.append('file', new Blob(['receipt-content'], { type: 'text/plain' }), 'receipt.txt');
  const res = await fetch(`${t.base}/api/v1/workspaces/${ws}/expenses`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: fd });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  assert.equal(data.total, 33.3);
  assert.equal(data.billable, false);
  assert.equal(data.notes, 'Taxi');
  assert.ok(data.fileId);
  assert.equal(data.fileName, 'receipt.txt');

  const dl = await fetch(`${t.base}/api/v1/workspaces/${ws}/expenses/${data.id}/files/${data.fileId}`, { headers: { Authorization: `Bearer ${owner.token}` } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /text\/plain/);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(await dl.text(), 'receipt-content');

  const wrong = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/${data.id}/files/000000000000000000000000`);
  assert.equal(wrong.status, 404);

  // replace the receipt through multipart PUT limited to changeFields
  const fd2 = new FormData();
  fd2.append('changeFields', 'FILE');
  fd2.append('amount', '999');
  fd2.append('file', new Blob(['v2'], { type: 'text/plain' }), 'receipt2.txt');
  const put = await fetch(`${t.base}/api/v1/workspaces/${ws}/expenses/${data.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${owner.token}` }, body: fd2 });
  const put2 = await put.json();
  assert.equal(put.status, 200, JSON.stringify(put2));
  assert.equal(put2.fileName, 'receipt2.txt');
  assert.notEqual(put2.fileId, data.fileId);
  assert.equal(put2.total, 33.3); // AMOUNT not in changeFields
});

test('list expenses with totals and filters', async () => {
  const all = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses?page=1&page-size=50`);
  assert.equal(all.status, 200);
  assert.equal(all.data.expenses.count, 3);
  assert.equal(all.data.expenses.expenses.length, 3);
  assert.equal(all.data.expenses.expenses[0].date, '2026-03-12'); // newest first
  const day = all.data.dailyTotals.find((d) => d.date === '2026-03-10');
  assert.equal(day.total, 12.5);
  assert.equal(day.dateAsInstant, '2026-03-10T00:00:00Z');
  assert.equal(all.data.dailyTotals.length, 3);
  // 2026-03-10..12 all fall in the week starting Monday 2026-03-09
  assert.equal(all.data.weeklyTotals.length, 1);
  assert.equal(all.data.weeklyTotals[0].date, '2026-03-09');
  assert.equal(all.data.weeklyTotals[0].total, 60.8);

  const byUser = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses?user-id=${owner.user.id}`);
  assert.equal(byUser.data.expenses.count, 3);
  const range = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses?start=2026-03-11&end=2026-03-11`);
  assert.equal(range.data.expenses.count, 1);
  const billable = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses?billable=false`);
  assert.equal(billable.data.expenses.count, 1);
  const cat = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses?category=${mileage.id}`);
  assert.equal(cat.data.expenses.count, 1);
  const paged = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses?page=2&page-size=2`);
  assert.equal(paged.data.expenses.count, 3);
  assert.equal(paged.data.expenses.expenses.length, 1);
});

test('update with changeFields (PUT) and partial PATCH', async () => {
  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses?category=${meals.id}&start=2026-03-10&end=2026-03-10`);
  const e = list.data.expenses.expenses[0];
  const put = await owner.call('PUT', `/api/v1/workspaces/${ws}/expenses/${e.id}`, { changeFields: ['AMOUNT'], amount: 20, notes: 'IGNORED', date: '2026-03-01', projectId: project.id, categoryId: meals.id, userId: owner.user.id });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.data.total, 20);
  assert.equal(put.data.notes, 'Lunch');
  assert.equal(put.data.date, '2026-03-10');

  const patch = await owner.call('PATCH', `/api/v1/workspaces/${ws}/expenses/${e.id}`, { notes: 'Dinner', billable: false });
  assert.equal(patch.status, 200);
  assert.equal(patch.data.notes, 'Dinner');
  assert.equal(patch.data.billable, false);
  assert.equal(patch.data.total, 20);

  // switching to a unit-priced category re-interprets amount as quantity
  const cat = await owner.call('PUT', `/api/v1/workspaces/${ws}/expenses/${e.id}`, { changeFields: ['CATEGORY', 'AMOUNT'], categoryId: mileage.id, amount: 4 });
  assert.equal(cat.status, 200);
  assert.equal(cat.data.quantity, 4);
  assert.equal(cat.data.total, 6);
  const back = await owner.call('PUT', `/api/v1/workspaces/${ws}/expenses/${e.id}`, { changeFields: ['CATEGORY', 'AMOUNT'], categoryId: meals.id, amount: 20 });
  assert.equal(back.data.total, 20);

  const single = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/${e.id}`);
  assert.equal(single.status, 200);
  assert.equal(single.data.id, e.id);
  assert.equal(single.data.categoryId, meals.id);
});

test('members see only their own expenses and locks are enforced', async () => {
  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'member@test.dev' });
  const member = await t.register({ email: 'member@test.dev', name: 'Member' });
  const forOther = await member.call('POST', `/api/v1/workspaces/${ws}/expenses`, { userId: owner.user.id, date: '2026-03-10', projectId: project.id, categoryId: meals.id, amount: 1 });
  assert.equal(forOther.status, 403);
  const mine = await member.call('POST', `/api/v1/workspaces/${ws}/expenses`, { date: '2026-03-05', projectId: project.id, categoryId: meals.id, amount: 7 });
  assert.equal(mine.status, 201, mine.text);
  assert.equal(mine.data.userId, member.user.id);
  const memberList = await member.call('GET', `/api/v1/workspaces/${ws}/expenses`);
  assert.equal(memberList.data.expenses.count, 1);
  const ownerList = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses`);
  assert.equal(ownerList.data.expenses.count, 4);
  const cats = await member.call('POST', `/api/v1/workspaces/${ws}/expenses/categories`, { name: 'Nope' });
  assert.equal(cats.status, 403);
  const hidden = await member.call('GET', `/api/v1/workspaces/${ws}/expenses/${ownerList.data.expenses.expenses[0].id}`);
  assert.equal(hidden.status, 404);

  // lock: entries before 2026-03-08 can't be edited by members
  await owner.call('PUT', `/api/v1/workspaces/${ws}/settings`, { lockTimeEntries: '2026-03-08T00:00:00Z' });
  const lockedGet = await member.call('GET', `/api/v1/workspaces/${ws}/expenses/${mine.data.id}`);
  assert.equal(lockedGet.data.locked, true);
  assert.equal(lockedGet.data.isLocked, true);
  const denied = await member.call('PATCH', `/api/v1/workspaces/${ws}/expenses/${mine.data.id}`, { notes: 'x' });
  assert.equal(denied.status, 403);
  const deniedCreate = await member.call('POST', `/api/v1/workspaces/${ws}/expenses`, { date: '2026-03-01', projectId: project.id, categoryId: meals.id, amount: 7 });
  assert.equal(deniedCreate.status, 403);
  const deniedDelete = await member.call('DELETE', `/api/v1/workspaces/${ws}/expenses/${mine.data.id}`);
  assert.equal(deniedDelete.status, 403);
  const adminOk = await owner.call('PATCH', `/api/v1/workspaces/${ws}/expenses/${mine.data.id}`, { notes: 'by admin' });
  assert.equal(adminOk.status, 200);
  await owner.call('PUT', `/api/v1/workspaces/${ws}/settings`, { lockTimeEntries: null });
  const unlocked = await member.call('PATCH', `/api/v1/workspaces/${ws}/expenses/${mine.data.id}`, { notes: 'mine again' });
  assert.equal(unlocked.status, 200);
});

test('delete is a soft delete and blocks category deletion while in use', async () => {
  const inUse = await owner.call('DELETE', `/api/v1/workspaces/${ws}/expenses/categories/${mileage.id}`);
  assert.equal(inUse.status, 400);
  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses?category=${mileage.id}`);
  const e = list.data.expenses.expenses[0];
  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/expenses/${e.id}`);
  assert.equal(del.status, 200);
  const gone = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/${e.id}`);
  assert.equal(gone.status, 404);
  const row = await t.db.one('SELECT deleted_at FROM expenses WHERE id = $1', [e.id]);
  assert.ok(row.deleted_at);
  const after = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses`);
  assert.equal(after.data.expenses.count, 3);
  const freed = await owner.call('DELETE', `/api/v1/workspaces/${ws}/expenses/categories/${mileage.id}`);
  assert.equal(freed.status, 204);
});
