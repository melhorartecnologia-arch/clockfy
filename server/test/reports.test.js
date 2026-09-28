import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

let t; let owner; let member; let ws; let client; let project; let project2; let tag1; let tag2;
const RANGE = { dateRangeStart: '2026-03-01T00:00:00Z', dateRangeEnd: '2026-03-07T23:59:59Z' };
const R = (p) => `/api/v1/workspaces/${ws}/reports${p}`;

async function entry(who, body) {
  const r = await who.call('POST', `/api/v1/workspaces/${ws}/time-entries`, body);
  assert.equal(r.status, 201, r.text);
  return r.data;
}

before(async () => {
  process.env.RATE_LIMIT_PER_SECOND = process.env.RATE_LIMIT_PER_SECOND || '100000';
  t = await setupTestApp('reports');
  owner = await t.register({ name: 'Owner', workspaceName: 'Reports WS' });
  ws = owner.workspaceId;
  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'bob@test.dev' });
  member = await t.register({ email: 'bob@test.dev', name: 'Bob Member' });
  client = (await owner.call('POST', `/api/v1/workspaces/${ws}/clients`, { name: 'ACME' })).data;
  project = (await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Alpha', clientId: client.id, billable: true, hourlyRate: { amount: 5000, currency: 'USD' }, tasks: [{ name: 'Dev' }] })).data;
  project2 = (await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'Beta', billable: false })).data;
  tag1 = (await owner.call('POST', `/api/v1/workspaces/${ws}/tags`, { name: 'backend' })).data;
  tag2 = (await owner.call('POST', `/api/v1/workspaces/${ws}/tags`, { name: 'urgent' })).data;
  const cost = await owner.call('PUT', `/api/v1/workspaces/${ws}/users/${member.user.id}/cost-rate`, { amount: 2000 });
  assert.equal(cost.status, 200, cost.text);

  await entry(owner, { start: '2026-03-02T09:00:00Z', end: '2026-03-02T11:00:00Z', projectId: project.id, tagIds: [tag1.id], description: 'API work' });
  await entry(owner, { start: '2026-03-03T09:00:00Z', end: '2026-03-03T10:30:00Z', projectId: project.id, taskId: project.tasks[0].id, tagIds: [tag1.id, tag2.id], description: 'Task work' });
  await entry(owner, { start: '2026-03-03T14:00:00Z', end: '2026-03-03T15:00:00Z', projectId: project2.id, description: 'Meeting' });
  await entry(owner, { start: '2026-03-06T10:00:00Z', end: '2026-03-06T10:10:00Z', projectId: project2.id, description: 'Quick' });
  await entry(member, { start: '2026-03-04T08:00:00Z', end: '2026-03-04T12:00:00Z', projectId: project.id, description: 'Member work' });
  await entry(member, { start: '2026-03-05T10:00:00Z', end: '2026-03-05T10:30:00Z', description: '' });
  await entry(owner, { start: '2026-02-01T09:00:00Z', end: '2026-02-01T10:00:00Z', projectId: project.id, description: 'Outside range' });
});
after(async () => { await t.close(); });

test('summary report grouped by PROJECT and USER with totals and amounts', async () => {
  const r = await owner.call('POST', R('/summary'), { ...RANGE, amounts: ['EARNED', 'COST', 'PROFIT'], summaryFilter: { groups: ['PROJECT', 'USER'], sortColumn: 'DURATION' }, sortOrder: 'DESCENDING' });
  assert.equal(r.status, 200, r.text);
  const totals = r.data.totals[0];
  assert.equal(totals.totalTime, 33000);
  assert.equal(totals.totalBillableTime, 27000);
  assert.equal(totals.entriesCount, 6);
  assert.equal(totals.totalAmount, 375);
  assert.deepEqual(totals.amounts, [{ type: 'EARNED', value: 375 }, { type: 'COST', value: 90 }, { type: 'PROFIT', value: 285 }]);
  assert.equal(r.data.groupOne.length, 3);
  const alpha = r.data.groupOne[0];
  assert.equal(alpha._id, project.id);
  assert.equal(alpha.name, 'Alpha');
  assert.equal(alpha.clientName, 'ACME');
  assert.equal(alpha.color, project.color);
  assert.equal(alpha.duration, 27000);
  assert.equal(alpha.amount, 375);
  assert.equal(alpha.children.length, 2);
  const bob = alpha.children.find((c) => c._id === member.user.id);
  assert.equal(bob.duration, 14400);
  assert.deepEqual(bob.amounts, [{ type: 'EARNED', value: 200 }, { type: 'COST', value: 80 }, { type: 'PROFIT', value: 120 }]);
  const none = r.data.groupOne.find((g) => g.name === 'Without project');
  assert.equal(none.duration, 1800);
  assert.equal(none._id, null);
});

test('summary supports rounding, TAG/DATE groups, chart and the /reports/v1 prefix', async () => {
  const rounded = await owner.call('POST', `/reports/v1/workspaces/${ws}/reports/summary`, { ...RANGE, rounding: true, summaryFilter: { groups: ['PROJECT'] } });
  assert.equal(rounded.status, 200, rounded.text);
  assert.equal(rounded.data.groupOne.find((g) => g.name === 'Beta').duration, 4500);
  const tags = await owner.call('POST', R('/summary'), { ...RANGE, summaryFilter: { groups: ['TAG', 'DATE'], summaryChartType: 'PROJECT' } });
  assert.equal(tags.status, 200, tags.text);
  const urgent = tags.data.groupOne.find((g) => g._id === tag2.id);
  assert.equal(urgent.duration, 5400);
  assert.equal(urgent.children[0]._id, '2026-03-03');
  assert.equal(tags.data.groupOne.find((g) => g.name === 'Without tag').duration, 20400);
  assert.equal(tags.data.chart.length, 7);
  assert.equal(tags.data.chart.find((c) => c.date === '2026-03-03').totalTime, 9000);
  const bad = await owner.call('POST', R('/summary'), { ...RANGE, summaryFilter: { groups: ['NOPE'] } });
  assert.equal(bad.status, 400);
  const missing = await owner.call('POST', R('/summary'), { summaryFilter: { groups: ['PROJECT'] } });
  assert.equal(missing.status, 400);
});

test('detailed report: pagination, sorting, filters and totals over the whole set', async () => {
  const page = await owner.call('POST', R('/detailed'), { ...RANGE, detailedFilter: { page: 1, pageSize: 2, sortColumn: 'DATE' }, sortOrder: 'ASCENDING' });
  assert.equal(page.status, 200, page.text);
  assert.equal(page.data.timeEntries.length, 2);
  assert.equal(page.data.timeentries.length, 2);
  assert.equal(page.data.count, 6);
  const first = page.data.timeEntries[0];
  assert.equal(first.description, 'API work');
  assert.equal(first.projectName, 'Alpha');
  assert.equal(first.clientName, 'ACME');
  assert.equal(first.userName, 'Owner');
  assert.equal(first.timeInterval.duration, 7200);
  assert.equal(first.timeInterval.start, '2026-03-02T09:00:00Z');
  assert.equal(first.hourlyRate, 5000);
  assert.equal(first.earnedAmount, 100);
  assert.deepEqual(first.tags, [{ _id: tag1.id, name: 'backend' }]);
  assert.equal(page.data.timeEntries[1].taskName, 'Dev');
  const totals = page.data.totals[0];
  assert.equal(totals.entriesCount, 6);
  assert.equal(totals.totalTime, 33000);
  assert.equal(totals.totalAmount, 375);

  const desc = await owner.call('POST', R('/detailed'), { ...RANGE, detailedFilter: { page: 1, pageSize: 50, sortColumn: 'DURATION' }, sortOrder: 'DESCENDING' });
  assert.equal(desc.data.timeEntries[0].description, 'Member work');

  const byTag = await owner.call('POST', R('/detailed'), { ...RANGE, tags: { ids: [tag2.id], contains: 'CONTAINS' }, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(byTag.data.timeEntries.length, 1);
  assert.equal(byTag.data.timeEntries[0].description, 'Task work');
  const noTag = await owner.call('POST', R('/detailed'), { ...RANGE, tags: { ids: [tag1.id], contains: 'DOES_NOT_CONTAIN' }, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(noTag.data.timeEntries.length, 4);
  const onlyTag = await owner.call('POST', R('/detailed'), { ...RANGE, tags: { ids: [tag1.id, tag2.id], contains: 'CONTAINS_ONLY' }, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(onlyTag.data.timeEntries.length, 1);
  const byDesc = await owner.call('POST', R('/detailed'), { ...RANGE, description: 'work', detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(byDesc.data.timeEntries.length, 3);
  const noDesc = await owner.call('POST', R('/detailed'), { ...RANGE, withoutDescription: true, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(noDesc.data.timeEntries.length, 1);
  const byUser = await owner.call('POST', R('/detailed'), { ...RANGE, users: { ids: [member.user.id], contains: 'CONTAINS', status: 'ALL' }, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(byUser.data.timeEntries.length, 2);
  const nonBillable = await owner.call('POST', R('/detailed'), { ...RANGE, billable: false, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(nonBillable.data.timeEntries.length, 3);
  const byClient = await owner.call('POST', R('/detailed'), { ...RANGE, clients: { ids: [client.id] }, projects: { ids: [project.id], contains: 'CONTAINS' }, detailedFilter: { page: 1, pageSize: 50 } });
  assert.equal(byClient.data.timeEntries.length, 3);
  const relative = await owner.call('POST', R('/detailed'), { dateRangeType: 'THIS_YEAR', dateRangeStart: 'x', dateRangeEnd: 'x', detailedFilter: { page: 1, pageSize: 50, options: { totals: 'EXCLUDE' } } });
  assert.equal(relative.status, 200, relative.text);
  assert.equal(relative.data.totals, undefined);
});

test('weekly report: totals per day and groups', async () => {
  const r = await owner.call('POST', R('/weekly'), { dateRangeStart: '2026-03-02T00:00:00', dateRangeEnd: '2026-03-08T23:59:59', weeklyFilter: { group: 'PROJECT', subgroup: 'TIME' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.totalsByDay.length, 7);
  assert.equal(r.data.totalsByDay[0].date, '2026-03-02');
  assert.equal(r.data.totalsByDay[1].duration, 9000);
  assert.equal(r.data.totalsByDay[4].duration, 600);
  assert.equal(r.data.totals[0].totalTime, 33000);
  const alpha = r.data.groupOne.find((g) => g.name === 'Alpha');
  assert.equal(alpha.days.length, 7);
  assert.equal(alpha.days[1].duration, 5400);
  assert.equal(alpha.children.length, 2);
  assert.equal(alpha.children.find((c) => c.name === 'Bob Member').days[2].duration, 14400);
  const byUser = await owner.call('POST', R('/weekly'), { dateRangeStart: '2026-03-02', dateRangeEnd: '2026-03-08', weeklyFilter: { group: 'USER', subgroup: 'EARNINGS' }, includeUsersWithoutTime: true });
  assert.equal(byUser.data.groupOne.find((g) => g.name === 'Owner').amount, 175);
  assert.deepEqual(byUser.data.usersWithoutTime, []);
});

test('attendance report computes capacity, breaks and overtime per user/day', async () => {
  const r = await owner.call('POST', R('/attendance'), { dateRangeStart: '2026-03-02T00:00:00Z', dateRangeEnd: '2026-03-06T23:59:59Z', attendanceFilter: { sortColumn: 'DATE' }, sortOrder: 'ASCENDING' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.entities.length, 5);
  const day = r.data.entities.find((x) => x.date === '2026-03-03');
  assert.equal(day.userName, 'Owner');
  assert.equal(day.startTime, '2026-03-03T09:00:00Z');
  assert.equal(day.endTime, '2026-03-03T15:00:00Z');
  assert.equal(day.totalDuration, 9000);
  assert.equal(day.break, 0);
  assert.equal(day.capacity, 28800);
  assert.equal(day.remainingCapacity, 19800);
  assert.equal(day.overtime, 0);
  assert.equal(day.hasRunningEntry, false);
  const filtered = await owner.call('POST', R('/attendance'), { dateRangeStart: '2026-03-02', dateRangeEnd: '2026-03-06', attendanceFilter: { workFilters: [{ filtrationType: 'LARGER_THAN', value: '200' }] } });
  assert.equal(filtered.data.entities.length, 2);
});

test('expense report reads the expenses table', async () => {
  const { query } = t.db;
  await query(`INSERT INTO expenses (id, workspace_id, user_id, project_id, date, notes, quantity, total, billable) VALUES ('aaaaaaaaaaaaaaaaaaaaaaa1',$1,$2,$3,'2026-03-03','Taxi',1,123.45,true), ('aaaaaaaaaaaaaaaaaaaaaaa2',$1,$4,NULL,'2026-03-04','Coffee',2,10,false)`, [ws, member.user.id, project.id, owner.user.id]);
  const r = await owner.call('POST', R('/expenses/detailed'), { ...RANGE, sortColumn: 'DATE', sortOrder: 'ASCENDING' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.expenses.length, 2);
  assert.deepEqual(r.data.totals, { expensesCount: 2, totalAmount: 133.45, totalAmountBillable: 123.45 });
  assert.equal(r.data.expenses[0].projectName, 'Alpha');
  assert.equal(r.data.expenses[0].userName, 'Bob Member');
  assert.equal(r.data.expenses[0].amount, 123.45);
  assert.equal(r.data.expenses[0].date, '2026-03-03T00:00:00Z');
  const billable = await owner.call('POST', R('/expenses/detailed'), { ...RANGE, billable: true, users: { ids: [member.user.id] } });
  assert.equal(billable.data.expenses.length, 1);
  const csv = await owner.call('POST', R('/expenses/detailed'), { ...RANGE, exportType: 'CSV' });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
});

test('exports: CSV, XLSX and PDF', async () => {
  const csv = await owner.call('POST', R('/detailed'), { ...RANGE, exportType: 'CSV', amounts: ['EARNED', 'COST', 'PROFIT'], dateFormat: 'YYYY-MM-DD', detailedFilter: { sortColumn: 'DATE' }, sortOrder: 'ASCENDING' });
  assert.equal(csv.status, 200, csv.text);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="Clockfy_Detailed_report_2026-03-01_2026-03-07\.csv"/);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines[0], 'Project,Client,Description,Task,User,Group,Email,Tags,Billable,Start Date,Start Time,End Date,End Time,Duration (h),Duration (decimal),Billable Rate (USD),Billable Amount (USD),Cost Rate (USD),Cost Amount (USD),Profit (USD)');
  assert.equal(lines.length, 8);
  assert.equal(lines[1], 'Alpha,ACME,API work,,Owner,,' + owner.user.email + ',backend,Yes,2026-03-02,09:00:00,2026-03-02,11:00:00,02:00:00,2.00,50.00,100.00,0.00,0.00,100.00');
  assert.match(lines[7], /^Total,.*09:10:00,9\.17,,375\.00,,90\.00,285\.00$/);

  const xlsx = await owner.call('POST', R('/summary'), { ...RANGE, exportType: 'XLSX', summaryFilter: { groups: ['PROJECT', 'USER'] } });
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  assert.ok(xlsx.text.startsWith('PK'));

  const pdf = await owner.call('POST', R('/weekly'), { dateRangeStart: '2026-03-02', dateRangeEnd: '2026-03-08', exportType: 'PDF', weeklyFilter: { group: 'USER' } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok(pdf.text.startsWith('%PDF'));
});

test('members only see their own rates and respect onlyAdminsSeeAllTimeEntries', async () => {
  const r = await member.call('POST', R('/summary'), { ...RANGE, summaryFilter: { groups: ['USER'] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.totals[0].entriesCount, 6);
  assert.equal(r.data.totals[0].totalAmount, 200);
  assert.equal(r.data.groupOne.find((g) => g._id === owner.user.id).amount, 0);
  const det = await member.call('POST', R('/detailed'), { ...RANGE, detailedFilter: { page: 1, pageSize: 50, sortColumn: 'USER' } });
  const ownersEntry = det.data.timeEntries.find((e) => e.userId === owner.user.id);
  assert.equal(ownersEntry.hourlyRate, null);
  assert.equal(ownersEntry.earnedAmount, null);
  assert.deepEqual(ownersEntry.amounts, []);
  assert.equal(det.data.timeEntries.find((e) => e.description === 'Member work').hourlyRate, 5000);
  assert.equal(det.data.timeEntries.find((e) => e.description === 'Member work').earnedAmount, 200);

  await owner.call('PUT', `/api/v1/workspaces/${ws}/settings`, { onlyAdminsSeeAllTimeEntries: true });
  const own = await member.call('POST', R('/summary'), { ...RANGE, summaryFilter: { groups: ['USER'] } });
  assert.equal(own.data.totals[0].entriesCount, 2);
  assert.equal(own.data.groupOne.length, 1);
  await owner.call('PUT', `/api/v1/workspaces/${ws}/settings`, { onlyAdminsSeeAllTimeEntries: false });
});

test('shared reports: CRUD, public access without token and restricted access', async () => {
  const filter = { ...RANGE, summaryFilter: { groups: ['PROJECT'] } };
  const created = await owner.call('POST', `/api/v1/workspaces/${ws}/shared-reports`, { name: 'Public summary', type: 'SUMMARY', filter, isPublic: true, fixedDate: false });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.data.link, `http://localhost:3000/shared/${created.data.id}`);
  assert.equal(created.data.userId, owner.user.id);

  const anon = await t.api()('GET', `/api/v1/shared-reports/${created.data.id}`);
  assert.equal(anon.status, 200, anon.text);
  assert.equal(anon.data.name, 'Public summary');
  assert.equal(anon.data.workspaceName, 'Reports WS');
  assert.equal(anon.data.totals[0].totalTime, 33000);
  assert.equal(anon.data.groupOne.length, 3);
  const narrowed = await t.api()('GET', `/reports/v1/shared-reports/${created.data.id}?dateRangeStart=2026-03-04T00:00:00&dateRangeEnd=2026-03-05T23:59:59&exportType=JSON`);
  assert.equal(narrowed.status, 200, narrowed.text);
  assert.equal(narrowed.data.totals[0].entriesCount, 2);
  const csv = await t.api()('GET', `/api/v1/shared-reports/${created.data.id}?exportType=CSV`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);

  const priv = await owner.call('POST', `/api/v1/workspaces/${ws}/shared-reports`, { name: 'Private detailed', type: 'DETAILED', filter: { ...RANGE, detailedFilter: { page: 1, pageSize: 50 } }, isPublic: false, fixedDate: true });
  assert.equal(priv.status, 200, priv.text);
  assert.equal((await t.api()('GET', `/api/v1/shared-reports/${priv.data.id}`)).status, 401);
  assert.equal((await member.call('GET', `/api/v1/shared-reports/${priv.data.id}`)).status, 403);
  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/shared-reports/${priv.data.id}`, { name: 'Private detailed', visibleToUsers: [member.user.id] });
  assert.equal(upd.status, 200, upd.text);
  const asMember = await member.call('GET', `/api/v1/shared-reports/${priv.data.id}?dateRangeStart=2026-03-04&dateRangeEnd=2026-03-04`);
  assert.equal(asMember.status, 200, asMember.text);
  assert.equal(asMember.data.timeEntries.length, 6); // fixedDate: query range ignored, runs with the author's permissions
  assert.equal(asMember.data.type, 'DETAILED');

  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/shared-reports?sharedReportsFilter=CREATED_BY_ME`);
  assert.equal(list.data.count, 2);
  assert.equal(list.data.reports.find((x) => x.id === priv.data.id).visibleToUsers[0].name, 'Bob Member');
  const sharedWithMe = await member.call('GET', `/api/v1/workspaces/${ws}/shared-reports?sharedReportsFilter=SHARED_WITH_ME`);
  assert.equal(sharedWithMe.data.count, 1);
  assert.equal((await member.call('DELETE', `/api/v1/workspaces/${ws}/shared-reports/${priv.data.id}`)).status, 403);
  assert.equal((await owner.call('DELETE', `/api/v1/workspaces/${ws}/shared-reports/${priv.data.id}`)).status, 204);
  assert.equal((await t.api()('GET', `/api/v1/shared-reports/${priv.data.id}`)).status, 404);
});

test('scheduled reports: CRUD, due-time logic and e-mail delivery with attachment', async () => {
  const { outbox } = await import('../src/lib/mailer.js');
  const { isDue } = await import('../src/modules/reports/scheduledReports.js');
  const created = await owner.call('POST', `/api/v1/workspaces/${ws}/scheduled-reports`, { name: 'Weekly summary', type: 'SUMMARY', filter: { summaryFilter: { groups: ['PROJECT', 'USER'] } }, frequency: 'WEEKLY', dayOfWeek: 'MONDAY', hour: 8, recipients: ['boss@test.dev'], exportType: 'XLSX' });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.frequency, 'WEEKLY');
  assert.equal(created.data.lastSentAt, null);
  const row = { hour: 8, frequency: 'WEEKLY', day_of_week: 'MONDAY', created_at: '2026-01-01T00:00:00Z', last_sent_at: null };
  assert.equal(isDue(row, new Date('2026-03-02T09:00:00Z'), 'UTC'), true);
  assert.equal(isDue(row, new Date('2026-03-02T07:00:00Z'), 'UTC'), false);
  assert.equal(isDue(row, new Date('2026-03-03T09:00:00Z'), 'UTC'), false);
  assert.equal(isDue({ ...row, last_sent_at: '2026-03-02T08:30:00Z' }, new Date('2026-03-02T09:00:00Z'), 'UTC'), false);
  assert.equal(isDue({ ...row, frequency: 'MONTHLY', day_of_month: 31 }, new Date('2026-02-28T10:00:00Z'), 'UTC'), true);
  assert.equal(isDue({ ...row, frequency: 'DAILY' }, new Date('2026-03-05T10:00:00Z'), 'America/Sao_Paulo'), false);

  const before = outbox.length;
  const sent = await owner.call('POST', `/api/v1/workspaces/${ws}/scheduled-reports/${created.data.id}/send`);
  assert.equal(sent.status, 200, sent.text);
  assert.match(sent.data.filename, /^Clockfy_Summary_report_.*\.xlsx$/);
  assert.equal(outbox.length, before + 1);
  const mail = outbox[outbox.length - 1];
  assert.equal(mail.to, 'boss@test.dev');
  assert.equal(mail.attachments[0].filename, sent.data.filename);
  assert.ok(mail.attachments[0].content.length > 1000);
  const after = await owner.call('GET', `/api/v1/workspaces/${ws}/scheduled-reports/${created.data.id}`);
  assert.ok(after.data.lastSentAt);
  assert.equal((await member.call('DELETE', `/api/v1/workspaces/${ws}/scheduled-reports/${created.data.id}`)).status, 403);
  assert.equal((await owner.call('DELETE', `/api/v1/workspaces/${ws}/scheduled-reports/${created.data.id}`)).status, 204);
});

test('dashboard data for ME and TEAM', async () => {
  const team = await owner.call('GET', `/api/v1/workspaces/${ws}/dashboard?start=2026-03-02&end=2026-03-08&selection=TEAM&type=PROJECT`);
  assert.equal(team.status, 200, team.text);
  assert.equal(team.data.totalTime, 33000);
  assert.equal(team.data.billableTime, 27000);
  assert.equal(team.data.earned, 375);
  assert.equal(team.data.byDay.length, 7);
  assert.equal(team.data.byDay[1].duration, 9000);
  assert.equal(team.data.byProject[0].name, 'Alpha');
  assert.equal(team.data.topActivities[0].description, 'Member work');
  assert.equal(team.data.team.length, 2);
  assert.equal(team.data.team.find((u) => u.userId === member.user.id).totalTime, 16200);
  const me = await member.call('GET', `/api/v1/workspaces/${ws}/dashboard?start=2026-03-02&end=2026-03-08&selection=ME`);
  assert.equal(me.data.totalTime, 16200);
  assert.equal(me.data.team, null);
  await owner.call('PUT', `/api/v1/workspaces/${ws}/settings`, { onlyAdminsSeeDashboard: true });
  assert.equal((await member.call('GET', `/api/v1/workspaces/${ws}/dashboard?selection=TEAM`)).status, 403);
  await owner.call('PUT', `/api/v1/workspaces/${ws}/settings`, { onlyAdminsSeeDashboard: false });
});
