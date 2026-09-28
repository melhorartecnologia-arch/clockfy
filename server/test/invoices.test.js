import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './helpers.js';

process.env.RATE_LIMIT_PER_SECOND = process.env.RATE_LIMIT_PER_SECOND || '10000'; // the suite fires many requests per second

let t; let owner; let ws; let client; let project; let entries = []; let invoice; let category;

before(async () => {
  t = await setupTestApp('invoices');
  owner = await t.register({ name: 'Owner', workspaceName: 'WS' });
  ws = owner.workspaceId;
  client = (await owner.call('POST', `/api/v1/workspaces/${ws}/clients`, { name: 'ACME', address: 'Rua 1, 100\nSão Paulo', email: 'billing@acme.test', ccEmails: ['cc@acme.test'] })).data;
  project = (await owner.call('POST', `/api/v1/workspaces/${ws}/projects`, { name: 'P1', clientId: client.id, billable: true, hourlyRate: { amount: 5000, currency: 'USD' }, tasks: [{ name: 'T1' }] })).data;
  const mk = async (start, end, extra = {}) => {
    const r = await owner.call('POST', `/api/v1/workspaces/${ws}/time-entries`, { start, end, projectId: project.id, description: 'work', ...extra });
    assert.equal(r.status, 201, r.text);
    return r.data;
  };
  entries.push(await mk('2026-02-02T10:00:00Z', '2026-02-02T11:30:00Z'));          // 1.5h billable
  entries.push(await mk('2026-02-03T10:00:00Z', '2026-02-03T12:00:00Z', { taskId: project.tasks[0].id })); // 2h billable
  entries.push(await mk('2026-02-04T10:00:00Z', '2026-02-04T11:00:00Z', { billable: false })); // not billable
  entries.push(await mk('2026-03-04T10:00:00Z', '2026-03-04T11:00:00Z'));          // outside period
  category = (await owner.call('POST', `/api/v1/workspaces/${ws}/expenses/categories`, { name: 'Travel' })).data;
});
after(async () => { await t.close(); });

test('invoice settings: defaults and update', async () => {
  const s = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices/settings`);
  assert.equal(s.status, 200);
  assert.equal(s.data.defaults.dueDays, 30);
  assert.equal(s.data.defaults.taxType, 'SIMPLE');
  assert.equal(s.data.exportFields.quantity, true);
  assert.equal(s.data.labels.billTo, 'BILL TO');
  assert.ok(Array.isArray(s.data.itemTypes));
  const upd = await owner.call('PUT', `/api/v1/workspaces/${ws}/invoices/settings`, {
    defaults: { dueDays: 15, taxPercent: 10, tax2Percent: 5, taxType: 'SIMPLE', subject: 'Services', notes: 'Thank you' },
    exportFields: { itemType: true, quantity: true, unitPrice: true, tax: true, tax2: true, rtl: false },
    labels: { billTo: 'CUSTOMER', amount: 'AMOUNT' },
    company: { name: 'My Company Ltd', address: 'Av. Brasil, 1', email: 'me@company.test' },
    itemTypes: ['Service', 'Product', 'Time', 'Expense'],
  });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.data.defaults.dueDays, 15);
  assert.equal(upd.data.defaults.taxPercent, 10);
  assert.equal(upd.data.labels.billTo, 'CUSTOMER');
  assert.equal(upd.data.labels.amount, 'AMOUNT');
  assert.equal(upd.data.company.name, 'My Company Ltd');
});

test('create invoice with automatic number and defaults from settings', async () => {
  const r = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices`, { clientId: client.id, currency: 'USD', issuedDate: '2026-03-01T00:00:00Z' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.number, '0001');
  assert.equal(r.data.issuedDate, '2026-03-01T00:00:00Z');
  assert.equal(r.data.dueDate, '2026-03-16T00:00:00Z'); // dueDays = 15
  assert.match(r.data.billFrom, /My Company Ltd/);
  invoice = r.data;
  const ov = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices/${invoice.id}`);
  assert.equal(ov.status, 200);
  assert.equal(ov.data.status, 'UNSENT');
  assert.equal(ov.data.clientName, 'ACME');
  assert.match(ov.data.clientAddress, /Rua 1/);
  assert.equal(ov.data.subject, 'Services');
  assert.equal(ov.data.note, 'Thank you');
  assert.equal(ov.data.tax, 10);
  assert.equal(ov.data.tax2, 5);
  assert.deepEqual(ov.data.items, []);
  assert.equal(ov.data.amount, 0);
  const second = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices`, { clientId: client.id, currency: 'USD', issuedDate: '2026-03-02', dueDate: '2026-03-20', number: 'CUSTOM-1' });
  assert.equal(second.data.number, 'CUSTOM-1');
  const third = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices`, { clientId: client.id, currency: 'USD' });
  assert.equal(third.data.number, '0002');
  const dup = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices`, { clientId: client.id, currency: 'USD', number: '0001' });
  assert.equal(dup.status, 400);
  await owner.call('DELETE', `/api/v1/workspaces/${ws}/invoices/${third.data.id}`);
});

test('manual items, taxes and discount calculation', async () => {
  const add = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items`, { itemType: 'Service', description: 'Consulting', quantity: 2, unitPrice: 10000, applyTaxes: 'TAX1TAX2' });
  assert.equal(add.status, 200, add.text);
  assert.equal(add.data.items.length, 1);
  assert.equal(add.data.items[0].order, 1);
  assert.equal(add.data.items[0].amount, 20000);
  assert.equal(add.data.subtotal, 20000);
  assert.equal(add.data.taxAmount, 2000);
  assert.equal(add.data.tax2Amount, 1000);
  assert.equal(add.data.amount, 23000);
  assert.equal(add.data.balance, 23000);

  const disc = await owner.call('PUT', `/api/v1/workspaces/${ws}/invoices/${invoice.id}`, { currency: 'USD', number: '0001', issuedDate: '2026-03-01T00:00:00Z', dueDate: '2026-03-16T00:00:00Z', discountPercent: 10, taxPercent: 10, tax2Percent: 5, taxType: 'SIMPLE', visibleZeroFields: 'DISCOUNT' });
  assert.equal(disc.status, 200, disc.text);
  assert.equal(disc.data.discount, 10);
  assert.equal(disc.data.discountAmount, 2000);
  assert.equal(disc.data.taxAmount, 1800);
  assert.equal(disc.data.tax2Amount, 900);
  assert.equal(disc.data.amount, 20700);
  assert.deepEqual(disc.data.visibleZeroFields, ['DISCOUNT']);

  const comp = await owner.call('PUT', `/api/v1/workspaces/${ws}/invoices/${invoice.id}`, { currency: 'USD', number: '0001', issuedDate: '2026-03-01', dueDate: '2026-03-16', discountPercent: 10, taxPercent: 10, tax2Percent: 5, taxType: 'COMPOUND' });
  assert.equal(comp.data.tax2Amount, 990); // (18000 + 1800) × 5%
  assert.equal(comp.data.amount, 20790);

  const noTax = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items`, { itemType: 'Product', description: 'Hardware', quantity: 1, unitPrice: 5000, applyTaxes: 'NONE' });
  assert.equal(noTax.data.subtotal, 25000);
  assert.equal(noTax.data.discountAmount, 2500);
  assert.equal(noTax.data.taxAmount, 1800); // only the taxed item
  assert.equal(noTax.data.tax2Amount, 990);
  assert.equal(noTax.data.amount, 25000 - 2500 + 1800 + 990);

  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items/2`);
  assert.equal(del.status, 200);
  assert.equal(del.data.items.length, 1);
  assert.equal(del.data.amount, 20790);
  // back to SIMPLE, no discount for the following tests
  await owner.call('PUT', `/api/v1/workspaces/${ws}/invoices/${invoice.id}`, { currency: 'USD', number: '0001', issuedDate: '2026-03-01', dueDate: '2026-03-16', discountPercent: 0, taxPercent: 10, tax2Percent: 5, taxType: 'SIMPLE' });
});

test('import billable time entries marks them as invoiced', async () => {
  const imp = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items/import`, {
    from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z', projectFilter: { ids: [], contains: 'CONTAINS', status: 'ALL' }, timeEntryGroupType: 'SINGLE_ITEM', importExpenses: false,
  });
  assert.equal(imp.status, 200, imp.text);
  assert.equal(imp.data.containsImportedTimes, true);
  const item = imp.data.items.find((i) => i.importType === 'TIME_ENTRY_IMPORT');
  assert.ok(item);
  assert.equal(item.quantity, 3.5);
  assert.equal(item.unitPrice, 5000);
  assert.equal(item.amount, 17500);
  assert.equal(item.itemType, 'Time');
  assert.deepEqual([...item.timeEntryIds].sort(), [entries[0].id, entries[1].id].sort());
  assert.equal(imp.data.subtotal, 37500);
  const e0 = await owner.call('GET', `/api/v1/workspaces/${ws}/time-entries/${entries[0].id}`);
  assert.equal(e0.data.invoiced, true);
  assert.equal(e0.data.invoiceId, invoice.id);
  const e2 = await owner.call('GET', `/api/v1/workspaces/${ws}/time-entries/${entries[2].id}`);
  assert.equal(e2.data.invoiced, false);

  // importing again finds nothing new
  const again = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items/import`, { from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z', projectFilter: {}, timeEntryGroupType: 'DETAILED', importExpenses: false });
  assert.equal(again.data.items.length, 2);

  // deleting the imported item releases the entries
  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items/${item.order}`);
  assert.equal(del.status, 200);
  const released = await owner.call('GET', `/api/v1/workspaces/${ws}/time-entries/${entries[0].id}`);
  assert.equal(released.data.invoiced, false);
  assert.equal(released.data.invoiceId, null);

  // detailed import: one item per entry, rounded durations
  const detailed = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items/import`, {
    from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z', projectFilter: { ids: [project.id], contains: 'CONTAINS', status: 'ACTIVE' }, timeEntryGroupType: 'DETAILED',
    timeEntryFieldsForDetailedGroup: ['DATE', 'PROJECT', 'TASK', 'DESCRIPTION'], roundTimeEntryDuration: true, importExpenses: false,
  });
  assert.equal(detailed.status, 200, detailed.text);
  const imported = detailed.data.items.filter((i) => i.importType === 'TIME_ENTRY_IMPORT');
  assert.equal(imported.length, 2);
  assert.equal(imported[1].description, '2026-02-03 - P1 - T1 - work');
  assert.equal(imported[0].quantity, 1.5);
  assert.equal(imported[1].quantity, 2);
  assert.equal(detailed.data.subtotal, 20000 + 17500);
});

test('import billable expenses', async () => {
  const exp = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses`, { date: '2026-02-10', projectId: project.id, categoryId: category.id, amount: 80.5, billable: true, notes: 'Flight' });
  assert.equal(exp.status, 201, exp.text);
  const nb = await owner.call('POST', `/api/v1/workspaces/${ws}/expenses`, { date: '2026-02-11', projectId: project.id, categoryId: category.id, amount: 10, billable: false });
  assert.equal(nb.status, 201);
  const imp = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items/import`, {
    from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z', projectFilter: {}, timeEntryGroupType: 'SINGLE_ITEM', importExpenses: true, expensesGroupType: 'GROUPED', expensesGroupBy: 'CATEGORY',
  });
  assert.equal(imp.status, 200, imp.text);
  assert.equal(imp.data.containsImportedExpenses, true);
  const item = imp.data.items.find((i) => i.importType === 'EXPENSE_IMPORT');
  assert.equal(item.description, 'Travel');
  assert.equal(item.amount, 8050);
  assert.equal(item.itemType, 'Expense');
  assert.deepEqual(item.expenseIds, [exp.data.id]);
  const e = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/${exp.data.id}`);
  assert.equal(e.data.invoiced, true);
  assert.equal(e.data.locked, true);
  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/items/${item.order}`);
  assert.equal(del.status, 200);
  const e2 = await owner.call('GET', `/api/v1/workspaces/${ws}/expenses/${exp.data.id}`);
  assert.equal(e2.data.invoiced, false);
});

test('payments change the status (partial / paid) and can be removed', async () => {
  const before = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices/${invoice.id}`);
  const total = before.data.amount;
  assert.ok(total > 0);
  const p1 = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/payments`, { amount: 5000, note: 'first', paymentDate: '2026-03-05T00:00:00Z' });
  assert.equal(p1.status, 201, p1.text);
  assert.equal(p1.data.status, 'PARTIALLY_PAID');
  assert.equal(p1.data.paid, 5000);
  assert.equal(p1.data.balance, total - 5000);
  const p2 = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/payments`, { amount: total - 5000, paymentDate: '2026-03-06' });
  assert.equal(p2.status, 201);
  assert.equal(p2.data.status, 'PAID');
  assert.equal(p2.data.balance, 0);
  const list = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/payments`);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 2);
  assert.equal(list.data[0].date, '2026-03-06T00:00:00Z');
  assert.equal(list.data[1].note, 'first');
  assert.equal(list.data[1].author, 'Owner');
  const paymentId = list.data[0].id;
  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/payments/${paymentId}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.status, 'PARTIALLY_PAID');
  assert.equal(del.data.paid, 5000);
  const bad = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/payments`, { amount: 0 });
  assert.equal(bad.status, 400);
});

test('status changes, export PDF and send by e-mail', async () => {
  const st = await owner.call('PATCH', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/status`, { invoiceStatus: 'SENT' });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.data.status, 'SENT');
  assert.ok(st.data.sentAt);

  for (const locale of ['pt-BR', 'en']) {
    const res = await fetch(`${t.base}/api/v1/workspaces/${ws}/invoices/${invoice.id}/export?userLocale=${locale}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="invoice-0001.pdf"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buf.length > 1000);
  }

  const { outbox } = await import('../src/lib/mailer.js');
  const send = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/send`, { message: 'Please pay' });
  assert.equal(send.status, 200, send.text);
  assert.equal(send.data.status, 'SENT');
  const mail = outbox[outbox.length - 1];
  assert.match(mail.to, /billing@acme.test/);
  assert.match(mail.to, /cc@acme.test/);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].contentType, 'application/pdf');
  assert.equal(mail.text, 'Please pay');
});

test('overdue job, list filters and /info', async () => {
  const old = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices`, { clientId: client.id, currency: 'USD', issuedDate: '2026-01-01', dueDate: '2026-01-10' });
  assert.equal(old.status, 201);
  await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${old.data.id}/items`, { itemType: 'Service', description: 'Old work', quantity: 1, unitPrice: 1000, applyTaxes: 'NONE' });
  await owner.call('PATCH', `/api/v1/workspaces/${ws}/invoices/${old.data.id}/status`, { invoiceStatus: 'SENT' });
  const { markOverdueInvoices } = await import('../src/modules/invoices/service.js');
  const n = await markOverdueInvoices();
  assert.ok(n >= 1);
  const ov = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices/${old.data.id}`);
  assert.equal(ov.data.status, 'OVERDUE');
  assert.ok(ov.data.daysOverdue > 0);

  const all = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices?sort-column=ISSUE_DATE&sort-order=ASCENDING`);
  assert.equal(all.status, 200);
  assert.equal(all.data.total, 3);
  assert.equal(all.data.invoices[0].id, old.data.id);
  assert.ok('balance' in all.data.invoices[0]);
  // invoice 0001 (SENT, due 2026-03-16) is also past due by now, so the job marks both
  const overdue = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices?statuses=OVERDUE,PAID`);
  assert.equal(overdue.data.total, 2);
  const main = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices/${invoice.id}`);
  assert.equal(main.data.status, 'OVERDUE');
  const paged = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices?page=2&page-size=2`);
  assert.equal(paged.data.invoices.length, 1);

  const info = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/info`, { clients: { ids: [client.id], contains: 'CONTAINS', status: 'ALL' }, statuses: ['OVERDUE'], sortColumn: 'AMOUNT', sortOrder: 'DESCENDING', page: 1, pageSize: 10 });
  assert.equal(info.status, 200, info.text);
  assert.equal(info.data.total, 2);
  assert.equal(info.data.invoices[0].id, invoice.id); // larger amount first
  assert.equal(info.data.invoices[1].id, old.data.id);
  assert.equal(info.data.invoices[1].daysOverdue, ov.data.daysOverdue);
  assert.ok(info.data.invoices[0].daysOverdue > 0);
  const byNumber = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/info`, { invoiceNumber: '000', strictSearch: false });
  assert.equal(byNumber.data.total, 2);
  const strict = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/info`, { invoiceNumber: '000', strictSearch: true });
  assert.equal(strict.data.total, 0);
  const amounts = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/info`, { greaterThanAmount: 5000 });
  assert.equal(amounts.data.total, 1);
  const period = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/info`, { issueDate: { 'issue-date-start': '2026-03-01', 'issue-date-end': '2026-03-31' } });
  assert.equal(period.data.total, 2);
});

test('duplicate and delete release imported entries; members are denied', async () => {
  const dup = await owner.call('POST', `/api/v1/workspaces/${ws}/invoices/${invoice.id}/duplicate`);
  assert.equal(dup.status, 201, dup.text);
  assert.notEqual(dup.data.number, '0001');
  assert.equal(dup.data.status, 'UNSENT');
  assert.equal(dup.data.items.length, 3);
  assert.ok(dup.data.items.every((i) => i.importType === 'NOT_IMPORTED'));
  await owner.call('DELETE', `/api/v1/workspaces/${ws}/invoices/${dup.data.id}`);

  const stillInvoiced = await owner.call('GET', `/api/v1/workspaces/${ws}/time-entries/${entries[1].id}`);
  assert.equal(stillInvoiced.data.invoiced, true);
  const del = await owner.call('DELETE', `/api/v1/workspaces/${ws}/invoices/${invoice.id}`);
  assert.equal(del.status, 200);
  const gone = await owner.call('GET', `/api/v1/workspaces/${ws}/invoices/${invoice.id}`);
  assert.equal(gone.status, 404);
  const released = await owner.call('GET', `/api/v1/workspaces/${ws}/time-entries/${entries[1].id}`);
  assert.equal(released.data.invoiced, false);
  assert.equal(released.data.invoiceId, null);

  await owner.call('POST', `/api/v1/workspaces/${ws}/users?send-email=false`, { email: 'member@test.dev' });
  const member = await t.register({ email: 'member@test.dev', name: 'Member' });
  const denied = await member.call('GET', `/api/v1/workspaces/${ws}/invoices`);
  assert.equal(denied.status, 403);
  const deniedSettings = await member.call('GET', `/api/v1/workspaces/${ws}/invoices/settings`);
  assert.equal(deniedSettings.status, 403);
});
