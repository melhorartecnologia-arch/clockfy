import { one, rows, query, insert, value, transaction } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { toIso, addDaysLocal, localDateString, parseDate, daysBetween } from '../../lib/dates.js';
import { roundSeconds } from '../../lib/duration.js';
import { events } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { dateStr, normalizeDate } from '../expenses/service.js';

export const STATUSES = ['UNSENT', 'SENT', 'PAID', 'PARTIALLY_PAID', 'VOID', 'OVERDUE'];
export const TAX_TYPES = ['SIMPLE', 'COMPOUND', 'NONE'];
export const APPLY_TAXES = ['TAX1', 'TAX2', 'TAX1TAX2', 'NONE'];
export const ZERO_FIELDS = ['TAX', 'TAX_2', 'DISCOUNT'];
export const CALCULATION_TYPES = ['INVOICE_BASED', 'ITEM_BASED'];

// Default labels (LabelsCustomization) – English; pt-BR defaults are used by the PDF export when the locale is Portuguese.
export const DEFAULT_LABELS = {
  amount: 'AMOUNT', billFrom: 'BILL FROM', billTo: 'BILL TO', description: 'DESCRIPTION', discount: 'DISCOUNT', dueDate: 'DUE DATE', issueDate: 'ISSUE DATE',
  itemType: 'ITEM TYPE', notes: 'NOTES', paid: 'PAID', quantity: 'QUANTITY', subtotal: 'SUBTOTAL', tax: 'TAX', tax2: 'TAX 2', total: 'TOTAL',
  totalAmount: 'TOTAL AMOUNT DUE', totalAmountDue: 'TOTAL AMOUNT DUE', unitPrice: 'UNIT PRICE',
};
export const DEFAULT_LABELS_PT = {
  amount: 'VALOR', billFrom: 'DE', billTo: 'PARA', description: 'DESCRIÇÃO', discount: 'DESCONTO', dueDate: 'VENCIMENTO', issueDate: 'DATA DE EMISSÃO',
  itemType: 'TIPO', notes: 'OBSERVAÇÕES', paid: 'PAGO', quantity: 'QUANTIDADE', subtotal: 'SUBTOTAL', tax: 'IMPOSTO', tax2: 'IMPOSTO 2', total: 'TOTAL',
  totalAmount: 'VALOR TOTAL DEVIDO', totalAmountDue: 'VALOR TOTAL DEVIDO', unitPrice: 'PREÇO UNITÁRIO',
};
export const DEFAULT_DEFAULTS = { companyId: null, dueDays: 30, itemType: 'Service', itemTypeId: null, notes: '', subject: '', taxPercent: 0, tax2Percent: 0, taxType: 'SIMPLE', defaultImportTimeItemTypeId: 'Time', defaultImportExpenseItemTypeId: 'Expense' };
export const DEFAULT_EXPORT_FIELDS = { itemType: true, quantity: true, unitPrice: true, tax: true, tax2: true, rtl: false };
export const DEFAULT_ITEM_TYPES = ['Service', 'Product', 'Time', 'Expense'];

export const dateIso = (d) => (d ? `${d}T00:00:00Z` : null);
export const num = (v) => Number(v || 0);
export const isPt = (locale) => /^pt/i.test(String(locale || ''));
export const userLocale = (ctx) => (/^pt/i.test(String(ctx?.user?.settings?.lang || 'PT_BR')) ? 'pt-BR' : 'en');

// ---- permissions -------------------------------------------------------------------
// Invoices are an admin area. Managers (team/project) may access it unless the workspace lists
// INVOICES in settings.adminOnlyPages; regular members never can.
export function requireInvoiceAccess(ctx) {
  if (ctx.isAdmin) return;
  const pages = (ctx.settings.adminOnlyPages || []).map((p) => String(p).toUpperCase());
  if (pages.includes('INVOICES') || pages.includes('INVOICING') || pages.includes('INVOICE')) throw forbidden('Only workspace admins can access invoices', 403);
  if (!(ctx.managedProjects.size || ctx.managedTargets.size)) throw forbidden('Only workspace admins or managers can access invoices', 403);
}

// ---- settings ------------------------------------------------------------------------
export async function getSettingsRow(workspaceId) {
  let s = await one('SELECT * FROM invoice_settings WHERE workspace_id = $1', [workspaceId]);
  if (!s) {
    await query('INSERT INTO invoice_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [workspaceId]);
    s = await one('SELECT * FROM invoice_settings WHERE workspace_id = $1', [workspaceId]);
  }
  return s;
}

export function settingsDto(s) {
  const d = { ...DEFAULT_DEFAULTS, ...(s.defaults || {}) };
  const c = s.company || {};
  return {
    defaults: {
      companyId: d.companyId || null,
      dueDays: Number(d.dueDays ?? 30),
      itemType: d.itemType || 'Service',
      itemTypeId: d.itemTypeId || d.itemType || 'Service',
      notes: d.notes || '',
      subject: d.subject || '',
      tax: Math.round(num(d.taxPercent)),
      tax2: Math.round(num(d.tax2Percent)),
      taxPercent: num(d.taxPercent),
      tax2Percent: num(d.tax2Percent),
      taxType: TAX_TYPES.includes(d.taxType) ? d.taxType : 'SIMPLE',
      defaultImportTimeItemTypeId: d.defaultImportTimeItemTypeId || 'Time',
      defaultImportExpenseItemTypeId: d.defaultImportExpenseItemTypeId || 'Expense',
    },
    exportFields: { ...DEFAULT_EXPORT_FIELDS, ...(s.export_fields || {}) },
    labels: { ...DEFAULT_LABELS, ...(s.labels || {}) },
    company: { name: c.name || '', address: c.address || '', email: c.email || '', logoFileId: c.logoFileId || null },
    itemTypes: Array.isArray(s.item_types) && s.item_types.length ? s.item_types : DEFAULT_ITEM_TYPES,
    nextNumber: Number(s.next_number || 1),
  };
}

// Labels for rendering: explicit overrides win, otherwise locale defaults.
export function labelsFor(settings, locale) {
  const base = isPt(locale) ? DEFAULT_LABELS_PT : DEFAULT_LABELS;
  const out = { ...base };
  for (const [k, v] of Object.entries(settings.labels || {})) if (v != null && String(v).trim() !== '' && v !== DEFAULT_LABELS[k]) out[k] = v;
  if (!settings.labels?.totalAmountDue && settings.labels?.totalAmount && settings.labels.totalAmount !== DEFAULT_LABELS.totalAmount) out.totalAmountDue = settings.labels.totalAmount;
  return out;
}

export function billFromOf(company, workspace) {
  return [company?.name || workspace?.name || '', company?.address || ''].filter((s) => String(s).trim()).join('\n');
}

// ---- invoices --------------------------------------------------------------------------
const BASE_SELECT = `
  SELECT i.*, to_char(i.issued_date, 'YYYY-MM-DD') AS issued_str, to_char(i.due_date, 'YYYY-MM-DD') AS due_str,
         c.name AS client_name, c.email AS client_email, c.cc_emails AS client_cc_emails,
         COALESCE((SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) AS paid_cents
  FROM invoices i LEFT JOIN clients c ON c.id = i.client_id`;

export async function loadInvoice(workspaceId, id) {
  const inv = await one(`${BASE_SELECT} WHERE i.id = $1 AND i.workspace_id = $2`, [id, workspaceId]);
  if (!inv) throw notFound('Invoice not found', 404);
  return inv;
}

export async function loadItems(invoiceId) {
  return rows('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position, id', [invoiceId]);
}

export async function loadItemsByInvoice(invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const list = await rows('SELECT * FROM invoice_items WHERE invoice_id = ANY($1) ORDER BY invoice_id, position, id', [invoiceIds]);
  const map = new Map();
  for (const it of list) { if (!map.has(it.invoice_id)) map.set(it.invoice_id, []); map.get(it.invoice_id).push(it); }
  return map;
}

export const itemAmount = (it) => Math.round(num(it.quantity) * num(it.unit_price));

// All amounts in integer cents. Taxes apply per item (applyTaxes) proportionally after the discount;
// tax 2 is computed on the net amount (SIMPLE) or on net + tax 1 (COMPOUND). taxType NONE disables taxes.
export function computeTotals(inv, items, paidCents) {
  const discount = num(inv.discount_percent);
  const taxType = TAX_TYPES.includes(inv.tax_type) ? inv.tax_type : 'SIMPLE';
  const tax = taxType === 'NONE' ? 0 : num(inv.tax_percent);
  const tax2 = taxType === 'NONE' ? 0 : num(inv.tax2_percent);
  let subtotal = 0; let taxAmount = 0; let tax2Amount = 0;
  for (const it of items) {
    const amount = itemAmount(it);
    subtotal += amount;
    const net = amount * (1 - discount / 100);
    const a1 = it.apply_taxes === 'TAX1' || it.apply_taxes === 'TAX1TAX2';
    const a2 = it.apply_taxes === 'TAX2' || it.apply_taxes === 'TAX1TAX2';
    const t1 = a1 ? (net * tax) / 100 : 0;
    const t2 = a2 ? ((net + (taxType === 'COMPOUND' ? t1 : 0)) * tax2) / 100 : 0;
    taxAmount += t1; tax2Amount += t2;
  }
  const discountAmount = Math.round((subtotal * discount) / 100);
  taxAmount = Math.round(taxAmount); tax2Amount = Math.round(tax2Amount);
  const amount = subtotal - discountAmount + taxAmount + tax2Amount;
  const paid = Math.round(num(paidCents));
  return { subtotal, discount, discountAmount, tax, taxAmount, tax2, tax2Amount, taxType, amount, paid, balance: amount - paid };
}

export function daysOverdueOf(inv, today = localDateString(new Date(), 'UTC')) {
  const due = inv.due_str || dateStr(inv.due_date);
  if (!due || !['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status)) return 0;
  const d = daysBetween(due, today);
  return d > 0 ? d : 0;
}

export function itemDto(it) {
  return {
    order: Number(it.position),
    itemType: it.item_type,
    description: it.description || '',
    quantity: num(it.quantity),
    unitPrice: num(it.unit_price),
    amount: itemAmount(it),
    applyTaxes: it.apply_taxes || 'NONE',
    importType: it.import_type || 'NOT_IMPORTED',
    timeEntryIds: it.time_entry_ids || [],
    expenseIds: it.expense_ids || [],
  };
}

// InvoiceDtoV1 (list)
export function invoiceListDto(inv, items) {
  const t = computeTotals(inv, items, inv.paid_cents);
  return {
    id: inv.id, number: inv.number, clientId: inv.client_id || null, clientName: inv.client_name || '', currency: inv.currency,
    issuedDate: dateIso(inv.issued_str || dateStr(inv.issued_date)), dueDate: dateIso(inv.due_str || dateStr(inv.due_date)), status: inv.status,
    amount: t.amount, paid: t.paid, balance: t.balance,
  };
}

// InvoiceInfoV1 (POST /invoices/info)
export function invoiceInfoDto(inv, items) {
  return { ...invoiceListDto(inv, items), billFrom: inv.bill_from || '', daysOverdue: daysOverdueOf(inv), visibleZeroFields: inv.visible_zero_fields || [], subject: inv.subject || '' };
}

// InvoiceOverviewDtoV1
export function overviewDto(inv, items, settings) {
  const t = computeTotals(inv, items, inv.paid_cents);
  return {
    id: inv.id,
    number: inv.number,
    clientId: inv.client_id || null,
    clientName: inv.client_name || '',
    clientAddress: inv.client_address || '',
    billFrom: inv.bill_from || '',
    companyId: settings?.defaults?.companyId ?? null,
    currency: inv.currency,
    issuedDate: dateIso(inv.issued_str || dateStr(inv.issued_date)),
    dueDate: dateIso(inv.due_str || dateStr(inv.due_date)),
    status: inv.status,
    subject: inv.subject || '',
    note: inv.note || '',
    items: items.map(itemDto),
    subtotal: t.subtotal,
    discount: t.discount,
    discountAmount: t.discountAmount,
    tax: t.tax,
    taxAmount: t.taxAmount,
    tax2: t.tax2,
    tax2Amount: t.tax2Amount,
    taxType: t.taxType,
    amount: t.amount,
    paid: t.paid,
    balance: t.balance,
    visibleZeroFields: inv.visible_zero_fields || [],
    containsImportedTimes: items.some((i) => i.import_type === 'TIME_ENTRY_IMPORT'),
    containsImportedExpenses: items.some((i) => i.import_type === 'EXPENSE_IMPORT'),
    calculationType: CALCULATION_TYPES.includes(inv.calculation_type) ? inv.calculation_type : 'INVOICE_BASED',
    userId: inv.user_id || null,
    timeViewMode: inv.time_view_mode || null,
    daysOverdue: daysOverdueOf(inv),
    sentAt: toIso(inv.sent_at),
    createdAt: toIso(inv.created_at),
  };
}

export async function overview(workspaceId, id) {
  const inv = await loadInvoice(workspaceId, id);
  const [items, settings] = await Promise.all([loadItems(inv.id), getSettingsRow(workspaceId)]);
  return overviewDto(inv, items, settingsDto(settings));
}

// Generates the next sequential number ("0001", "0002", ...) from invoice_settings.next_number, skipping used numbers.
export async function nextInvoiceNumber(workspaceId) {
  return transaction(async () => {
    await query('INSERT INTO invoice_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [workspaceId]);
    const s = await one('SELECT next_number FROM invoice_settings WHERE workspace_id = $1 FOR UPDATE', [workspaceId]);
    let n = Math.max(1, Number(s?.next_number || 1));
    let number;
    for (;;) {
      number = String(n).padStart(4, '0');
      const dup = await one('SELECT 1 FROM invoices WHERE workspace_id = $1 AND number = $2', [workspaceId, number]);
      if (!dup) break;
      n++;
    }
    await query('UPDATE invoice_settings SET next_number = $2 WHERE workspace_id = $1', [workspaceId, n + 1]);
    return number;
  });
}

export async function loadClient(workspaceId, clientId) {
  const c = await one('SELECT c.*, cur.code AS currency_code FROM clients c LEFT JOIN workspace_currencies cur ON cur.id = c.currency_id WHERE c.id = $1 AND c.workspace_id = $2', [clientId, workspaceId]);
  if (!c) throw badRequest('Client not found', 400);
  return c;
}

export async function createInvoice(ctx, input) {
  const ws = ctx.workspace;
  const sd = settingsDto(await getSettingsRow(ws.id));
  if (!input.clientId) throw badRequest('clientId is required', 400);
  const client = await loadClient(ws.id, input.clientId);
  const tz = ctx.user?.settings?.timeZone || 'UTC';
  const issued = input.issuedDate ? normalizeDate(input.issuedDate, 'issuedDate') : localDateString(new Date(), tz);
  const due = input.dueDate ? normalizeDate(input.dueDate, 'dueDate') : addDaysLocal(issued, sd.defaults.dueDays);
  if (due < issued) throw badRequest('dueDate must be on or after issuedDate', 400);
  const number = input.number && String(input.number).trim() ? String(input.number).trim() : await nextInvoiceNumber(ws.id);
  const dup = await one('SELECT 1 FROM invoices WHERE workspace_id = $1 AND number = $2', [ws.id, number]);
  if (dup) throw badRequest('An invoice with this number already exists', 400);
  const inv = await insert('invoices', {
    id: input.id && /^[a-f0-9]{24}$/.test(input.id) ? input.id : newId(), workspace_id: ws.id, number, client_id: client.id, user_id: ctx.user.id,
    issued_date: issued, due_date: due, currency: input.currency || client.currency_code || ws.hourly_rate_currency || 'USD', status: 'UNSENT',
    subject: input.subject ?? sd.defaults.subject ?? null, note: input.note ?? sd.defaults.notes ?? null,
    bill_from: input.billFrom ?? billFromOf(sd.company, ws), client_address: input.clientAddress ?? (client.address || ''),
    discount_percent: input.discountPercent ?? 0, tax_percent: input.taxPercent ?? sd.defaults.taxPercent, tax2_percent: input.tax2Percent ?? sd.defaults.tax2Percent,
    tax_type: input.taxType ?? sd.defaults.taxType, calculation_type: input.calculationType || 'INVOICE_BASED',
    visible_zero_fields: input.visibleZeroFields ?? [], time_view_mode: input.timeViewMode || null,
  });
  await audit({ workspaceId: ws.id, userId: ctx.user.id, action: 'CREATE_INVOICE', entityType: 'INVOICE', entityId: inv.id, content: { ...input, number } });
  events.emitAsync('invoice.created', { workspaceId: ws.id, actorId: ctx.user.id, invoiceId: inv.id });
  return loadInvoice(ws.id, inv.id);
}

export async function updateInvoice(ctx, inv, input) {
  const ws = ctx.workspace;
  const data = {};
  if (input.clientId !== undefined && input.clientId !== inv.client_id) {
    const client = await loadClient(ws.id, input.clientId);
    data.client_id = client.id;
    if (input.clientAddress === undefined) data.client_address = client.address || '';
  }
  if (input.clientAddress !== undefined) data.client_address = input.clientAddress ?? '';
  if (input.billFrom !== undefined) data.bill_from = input.billFrom ?? '';
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.number !== undefined && String(input.number).trim() && String(input.number).trim() !== inv.number) {
    const number = String(input.number).trim();
    const dup = await one('SELECT 1 FROM invoices WHERE workspace_id = $1 AND number = $2 AND id <> $3', [ws.id, number, inv.id]);
    if (dup) throw badRequest('An invoice with this number already exists', 400);
    data.number = number;
  }
  if (input.issuedDate !== undefined) data.issued_date = normalizeDate(input.issuedDate, 'issuedDate');
  if (input.dueDate !== undefined) data.due_date = normalizeDate(input.dueDate, 'dueDate');
  const issued = data.issued_date || inv.issued_str; const due = data.due_date || inv.due_str;
  if (due < issued) throw badRequest('dueDate must be on or after issuedDate', 400);
  if (input.subject !== undefined) data.subject = input.subject;
  if (input.note !== undefined) data.note = input.note;
  if (input.discountPercent !== undefined) data.discount_percent = input.discountPercent;
  if (input.taxPercent !== undefined) data.tax_percent = input.taxPercent;
  if (input.tax2Percent !== undefined) data.tax2_percent = input.tax2Percent;
  if (input.taxType !== undefined) data.tax_type = input.taxType;
  if (input.calculationType !== undefined) data.calculation_type = input.calculationType;
  if (input.visibleZeroFields !== undefined) data.visible_zero_fields = input.visibleZeroFields == null ? [] : (Array.isArray(input.visibleZeroFields) ? input.visibleZeroFields : [input.visibleZeroFields]);
  if (input.timeViewMode !== undefined) data.time_view_mode = input.timeViewMode;
  if (input.status !== undefined) data.status = input.status;
  data.updated_at = new Date();
  const keys = Object.keys(data);
  await query(`UPDATE invoices SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')} WHERE id = $1`, [inv.id, ...keys.map((k) => (Array.isArray(data[k]) ? JSON.stringify(data[k]) : data[k]))]);
  const updated = await loadInvoice(ws.id, inv.id);
  await audit({ workspaceId: ws.id, userId: ctx.user.id, action: 'UPDATE_INVOICE', entityType: 'INVOICE', entityId: inv.id, content: input, previous: invoiceListDto(inv, []) });
  events.emitAsync('invoice.updated', { workspaceId: ws.id, actorId: ctx.user.id, invoiceId: inv.id });
  return updated;
}

// Releases time entries / expenses linked to the given items (invoiced=false, invoice_id=NULL)
export async function unmarkItems(invoiceId, items) {
  const teIds = [...new Set(items.flatMap((i) => i.time_entry_ids || []))];
  const exIds = [...new Set(items.flatMap((i) => i.expense_ids || []))];
  if (teIds.length) await query('UPDATE time_entries SET invoiced = false, invoice_id = NULL WHERE id = ANY($1) AND invoice_id = $2', [teIds, invoiceId]);
  if (exIds.length) await query('UPDATE expenses SET invoiced = false, invoice_id = NULL WHERE id = ANY($1) AND invoice_id = $2', [exIds, invoiceId]);
}

export async function markEntries(invoiceId, teIds, exIds) {
  if (teIds.length) await query('UPDATE time_entries SET invoiced = true, invoice_id = $2 WHERE id = ANY($1)', [teIds, invoiceId]);
  if (exIds.length) await query('UPDATE expenses SET invoiced = true, invoice_id = $2 WHERE id = ANY($1)', [exIds, invoiceId]);
}

export async function deleteInvoice(ctx, inv) {
  const items = await loadItems(inv.id);
  await transaction(async () => {
    await unmarkItems(inv.id, items);
    await query('UPDATE time_entries SET invoiced = false, invoice_id = NULL WHERE invoice_id = $1', [inv.id]);
    await query('UPDATE expenses SET invoiced = false, invoice_id = NULL WHERE invoice_id = $1', [inv.id]);
    await query('DELETE FROM invoices WHERE id = $1', [inv.id]);
  });
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'DELETE_INVOICE', entityType: 'INVOICE', entityId: inv.id, previous: invoiceListDto(inv, items) });
  events.emitAsync('invoice.updated', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, invoiceId: inv.id, deleted: true });
}

export async function resequence(invoiceId) {
  await query('UPDATE invoice_items x SET position = s.rn FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS rn FROM invoice_items WHERE invoice_id = $1) s WHERE x.id = s.id', [invoiceId]);
}

export function normalizeItem(input, { itemTypes } = {}) {
  const quantity = Number(input.quantity ?? 1);
  const unitPrice = Number(input.unitPrice ?? 0);
  if (Number.isNaN(quantity) || quantity < 0) throw badRequest('quantity must be a non-negative number', 400);
  if (Number.isNaN(unitPrice) || !Number.isFinite(unitPrice)) throw badRequest('unitPrice must be a number (cents)', 400);
  const applyTaxes = input.applyTaxes ? String(input.applyTaxes).toUpperCase() : 'NONE';
  if (!APPLY_TAXES.includes(applyTaxes)) throw badRequest('applyTaxes must be one of TAX1, TAX2, TAX1TAX2, NONE', 400);
  return {
    item_type: String(input.itemType || (itemTypes && itemTypes[0]) || 'Service').slice(0, 100),
    description: String(input.description ?? '').slice(0, 3000),
    quantity: Math.round(quantity * 10000) / 10000,
    unit_price: Math.round(unitPrice),
    apply_taxes: applyTaxes,
    import_type: ['NOT_IMPORTED', 'TIME_ENTRY_IMPORT', 'EXPENSE_IMPORT'].includes(input.importType) ? input.importType : 'NOT_IMPORTED',
    time_entry_ids: Array.isArray(input.timeEntryIds) ? input.timeEntryIds : [],
    expense_ids: Array.isArray(input.expenseIds) ? input.expenseIds : [],
  };
}

export async function addItem(inv, item) {
  const pos = await value('SELECT COALESCE(MAX(position), 0) + 1 FROM invoice_items WHERE invoice_id = $1', [inv.id]);
  return insert('invoice_items', { id: newId(), invoice_id: inv.id, position: pos, ...item });
}

export async function deleteItem(inv, order) {
  const it = await one('SELECT * FROM invoice_items WHERE invoice_id = $1 AND position = $2', [inv.id, order]);
  if (!it) throw notFound('Invoice item not found', 404);
  await transaction(async () => {
    await unmarkItems(inv.id, [it]);
    await query('DELETE FROM invoice_items WHERE id = $1', [it.id]);
    await resequence(inv.id);
  });
  return it;
}

// Replaces the whole item list; links (time entries/expenses) no longer referenced are released.
export async function replaceItems(inv, inputs, { itemTypes } = {}) {
  const items = inputs.map((i) => normalizeItem(i, { itemTypes }));
  const current = await loadItems(inv.id);
  await transaction(async () => {
    await unmarkItems(inv.id, current);
    await query('DELETE FROM invoice_items WHERE invoice_id = $1', [inv.id]);
    let pos = 1;
    for (const it of items) {
      await insert('invoice_items', { id: newId(), invoice_id: inv.id, position: pos++, ...it });
      await markEntries(inv.id, it.time_entry_ids, it.expense_ids);
    }
  });
}

export async function duplicateInvoice(ctx, inv) {
  const items = await loadItems(inv.id);
  const sd = settingsDto(await getSettingsRow(ctx.workspace.id));
  const tz = ctx.user?.settings?.timeZone || 'UTC';
  const issued = localDateString(new Date(), tz);
  const copy = await transaction(async () => {
    const number = await nextInvoiceNumber(ctx.workspace.id);
    const c = await insert('invoices', {
      id: newId(), workspace_id: ctx.workspace.id, number, client_id: inv.client_id, user_id: ctx.user.id, issued_date: issued, due_date: addDaysLocal(issued, sd.defaults.dueDays),
      currency: inv.currency, status: 'UNSENT', subject: inv.subject, note: inv.note, bill_from: inv.bill_from, client_address: inv.client_address,
      discount_percent: inv.discount_percent, tax_percent: inv.tax_percent, tax2_percent: inv.tax2_percent, tax_type: inv.tax_type, calculation_type: inv.calculation_type,
      visible_zero_fields: inv.visible_zero_fields || [], time_view_mode: inv.time_view_mode,
    });
    let pos = 1;
    for (const it of items) {
      // imported links stay with the original invoice; the copy gets plain items
      await insert('invoice_items', { id: newId(), invoice_id: c.id, position: pos++, item_type: it.item_type, description: it.description, quantity: it.quantity, unit_price: it.unit_price, apply_taxes: it.apply_taxes, import_type: 'NOT_IMPORTED', time_entry_ids: [], expense_ids: [] });
    }
    return c;
  });
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'CREATE_INVOICE', entityType: 'INVOICE', entityId: copy.id, content: { duplicatedFrom: inv.id, number: copy.number } });
  events.emitAsync('invoice.created', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, invoiceId: copy.id, duplicatedFrom: inv.id });
  return loadInvoice(ctx.workspace.id, copy.id);
}

// ---- import of time entries & expenses --------------------------------------------------
function projectFilterConds(filter, params, conds) {
  const f = filter || {};
  const status = String(f.status || 'ALL').toUpperCase();
  if (status === 'ACTIVE') conds.push('p.archived = false');
  if (status === 'ARCHIVED') conds.push('p.archived = true');
  const ids = Array.isArray(f.ids) ? f.ids.filter(Boolean) : [];
  if (ids.length) {
    params.push(ids);
    const contains = String(f.contains || 'CONTAINS').toUpperCase();
    conds.push(contains === 'DOES_NOT_CONTAIN' ? `NOT (p.id = ANY($${params.length}))` : `p.id = ANY($${params.length})`);
  }
}

const strings = {
  en: { timeEntries: 'Time entries', expenses: 'Expenses', noProject: 'No project', noCategory: 'No category', hours: 'h' },
  pt: { timeEntries: 'Registros de tempo', expenses: 'Despesas', noProject: 'Sem projeto', noCategory: 'Sem categoria', hours: 'h' },
};

export async function importItems(ctx, inv, b) {
  const ws = ctx.workspace;
  if (!inv.client_id) throw badRequest('Invoice has no client; imports need a client', 400);
  const from = parseDate(b.from, 'from'); const to = parseDate(b.to, 'to');
  if (!from || !to || to <= from) throw badRequest('Invalid period: `to` must be after `from`', 400);
  const sd = settingsDto(await getSettingsRow(ws.id));
  const s = strings[isPt(userLocale(ctx)) ? 'pt' : 'en'];
  const tz = ctx.user?.settings?.timeZone || 'UTC';

  const pParams = [ws.id, inv.client_id]; const pConds = ['p.workspace_id = $1', 'p.client_id = $2'];
  projectFilterConds(b.projectFilter, pParams, pConds);
  const projects = await rows(`SELECT p.id, p.name FROM projects p WHERE ${pConds.join(' AND ')}`, pParams);
  const pids = projects.map((p) => p.id);
  const result = { timeEntryIds: [], expenseIds: [], items: [] };
  if (!pids.length) return result;

  const items = [];
  // Time entries: billable, not yet invoiced, completed, within the period
  const entries = await rows(
    `SELECT e.*, u.name AS user_name, p.name AS project_name, t.name AS task_name,
            (SELECT string_agg(tg.name, ', ' ORDER BY tg.name) FROM time_entry_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.time_entry_id = e.id) AS tag_names
     FROM time_entries e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tasks t ON t.id = e.task_id
     WHERE e.workspace_id = $1 AND e.project_id = ANY($2) AND e.billable = true AND e.invoiced = false AND e.deleted_at IS NULL AND e.end_time IS NOT NULL
       AND e.type = 'REGULAR' AND e.start_time >= $3 AND e.start_time < $4
     ORDER BY e.start_time, e.id`, [ws.id, pids, from, to]);
  const round = ctx.settings.round || {};
  const secondsOf = (e) => {
    const sec = Math.max(0, Math.round((new Date(e.end_time) - new Date(e.start_time)) / 1000));
    return b.roundTimeEntryDuration ? roundSeconds(sec, round.round, round.minutes || 15) : sec;
  };
  const rateOf = (e) => num(e.hourly_rate_amount);
  const fieldValue = (e, f) => {
    switch (String(f).toUpperCase()) {
      case 'USER': return e.user_name || '';
      case 'PROJECT': return e.project_name || s.noProject;
      case 'TASK': return e.task_name || '';
      case 'DATE': return localDateString(new Date(e.start_time), e.time_zone || tz);
      case 'DESCRIPTION': return e.description || '';
      case 'TAGS': return e.tag_names || '';
      default: return '';
    }
  };
  const timeType = sd.defaults.defaultImportTimeItemTypeId || 'Time';
  const buildTimeItem = (description, group) => {
    const totalSec = group.reduce((a, e) => a + secondsOf(e), 0);
    const totalAmount = group.reduce((a, e) => a + (secondsOf(e) / 3600) * rateOf(e), 0);
    const rates = new Set(group.map(rateOf));
    const hours = Math.round((totalSec / 3600) * 100) / 100;
    const unitPrice = rates.size === 1 ? [...rates][0] : (totalSec > 0 ? Math.round(totalAmount / (totalSec / 3600)) : 0);
    return { item_type: timeType, description: description.slice(0, 3000), quantity: hours, unit_price: unitPrice, apply_taxes: 'TAX1TAX2', import_type: 'TIME_ENTRY_IMPORT', time_entry_ids: group.map((e) => e.id), expense_ids: [] };
  };
  if (entries.length) {
    const type = String(b.timeEntryGroupType || 'SINGLE_ITEM').toUpperCase();
    if (type === 'SINGLE_ITEM') {
      items.push(buildTimeItem(`${s.timeEntries} (${localDateString(from, tz)} - ${localDateString(new Date(to.getTime() - 1), tz)})`, entries));
    } else if (type === 'GROUPED') {
      const primary = String(b.timeEntryPrimaryGroupBy || 'PROJECT').toUpperCase();
      const secondary = String(b.timeEntrySecondaryGroupBy || 'NONE').toUpperCase();
      const groups = new Map();
      for (const e of entries) {
        const parts = [fieldValue(e, primary)];
        if (secondary !== 'NONE' && secondary !== primary) parts.push(fieldValue(e, secondary));
        const key = parts.join('\u0000');
        if (!groups.has(key)) groups.set(key, { label: parts.filter((p) => p !== '').join(' - ') || s.timeEntries, list: [] });
        groups.get(key).list.push(e);
      }
      for (const g of groups.values()) items.push(buildTimeItem(g.label, g.list));
    } else {
      const fields = Array.isArray(b.timeEntryFieldsForDetailedGroup) && b.timeEntryFieldsForDetailedGroup.length ? b.timeEntryFieldsForDetailedGroup : ['DATE', 'PROJECT', 'DESCRIPTION'];
      for (const e of entries) {
        const label = fields.map((f) => fieldValue(e, f)).filter((v) => v !== '').join(' - ') || s.timeEntries;
        items.push(buildTimeItem(label, [e]));
      }
    }
    result.timeEntryIds = entries.map((e) => e.id);
  }

  // Expenses: billable, not invoiced, within the period (by date)
  if (b.importExpenses) {
    const fromDate = localDateString(from, tz); const toDate = localDateString(new Date(to.getTime() - 1), tz);
    const expenses = await rows(
      `SELECT e.*, to_char(e.date, 'YYYY-MM-DD') AS date_str, u.name AS user_name, p.name AS project_name, t.name AS task_name, c.name AS category_name, c.has_unit_price, c.price_in_cents
       FROM expenses e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN expense_categories c ON c.id = e.category_id
       WHERE e.workspace_id = $1 AND e.project_id = ANY($2) AND e.billable = true AND e.invoiced = false AND e.deleted_at IS NULL AND e.date >= $3::date AND e.date <= $4::date
       ORDER BY e.date, e.created_at`, [ws.id, pids, fromDate, toDate]);
    const expType = sd.defaults.defaultImportExpenseItemTypeId || 'Expense';
    const cents = (e) => Math.round(num(e.total) * 100);
    const expField = (e, f) => {
      switch (String(f).toUpperCase()) {
        case 'PROJECT': return e.project_name || s.noProject;
        case 'TASK': return e.task_name || '';
        case 'CATEGORY': return e.category_name || s.noCategory;
        case 'NOTE': case 'NOTES': return e.notes || '';
        case 'DATE': return e.date_str;
        case 'USER': return e.user_name || '';
        default: return '';
      }
    };
    if (expenses.length) {
      const gtype = String(b.expensesGroupType || 'GROUPED').toUpperCase();
      if (gtype === 'DETAILED') {
        const fields = Array.isArray(b.expenseFieldsForDetailedGroup) && b.expenseFieldsForDetailedGroup.length ? b.expenseFieldsForDetailedGroup : ['DATE', 'CATEGORY', 'NOTE'];
        for (const e of expenses) {
          const label = fields.map((f) => expField(e, f)).filter((v) => v !== '').join(' - ') || s.expenses;
          const unit = e.has_unit_price ? num(e.price_in_cents) : cents(e);
          items.push({ item_type: expType, description: label.slice(0, 3000), quantity: e.has_unit_price ? num(e.quantity) : 1, unit_price: unit, apply_taxes: 'TAX1TAX2', import_type: 'EXPENSE_IMPORT', time_entry_ids: [], expense_ids: [e.id] });
        }
      } else {
        const by = String(b.expensesGroupBy || 'CATEGORY').toUpperCase();
        const groups = new Map();
        for (const e of expenses) {
          const key = expField(e, by) || s.expenses;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(e);
        }
        for (const [label, list] of groups) {
          items.push({ item_type: expType, description: label.slice(0, 3000), quantity: 1, unit_price: list.reduce((a, e) => a + cents(e), 0), apply_taxes: 'TAX1TAX2', import_type: 'EXPENSE_IMPORT', time_entry_ids: [], expense_ids: list.map((e) => e.id) });
        }
      }
      result.expenseIds = expenses.map((e) => e.id);
    }
  }

  if (items.length) {
    await transaction(async () => {
      let pos = Number(await value('SELECT COALESCE(MAX(position), 0) FROM invoice_items WHERE invoice_id = $1', [inv.id]));
      for (const it of items) await insert('invoice_items', { id: newId(), invoice_id: inv.id, position: ++pos, ...it });
      await markEntries(inv.id, result.timeEntryIds, result.expenseIds);
    });
  }
  result.items = items;
  return result;
}

// ---- payments ------------------------------------------------------------------------------
export function paymentDto(p) {
  return { id: p.id, amount: num(p.amount), date: dateIso(p.date_str || dateStr(p.date)), note: p.note || '', author: p.author_name || p.author_id || '' };
}

export async function listPayments(invoiceId, { limit = 50, offset = 0 } = {}) {
  return rows(`SELECT p.*, to_char(p.date, 'YYYY-MM-DD') AS date_str, u.name AS author_name FROM invoice_payments p LEFT JOIN users u ON u.id = p.author_id WHERE p.invoice_id = $1 ORDER BY p.date DESC, p.created_at DESC LIMIT $2 OFFSET $3`, [invoiceId, limit, offset]);
}

// Recomputes status after payments change: PAID when balance <= 0, PARTIALLY_PAID otherwise; back to SENT/UNSENT when no payments remain.
export async function refreshPaymentStatus(inv) {
  const items = await loadItems(inv.id);
  const paid = num(await value('SELECT COALESCE(SUM(amount), 0) FROM invoice_payments WHERE invoice_id = $1', [inv.id]));
  const t = computeTotals(inv, items, paid);
  let status = inv.status;
  if (paid > 0) status = t.balance <= 0 ? 'PAID' : 'PARTIALLY_PAID';
  else if (inv.status === 'PAID' || inv.status === 'PARTIALLY_PAID') status = inv.sent_at ? 'SENT' : 'UNSENT';
  if (status !== inv.status) await query('UPDATE invoices SET status = $2, updated_at = now() WHERE id = $1', [inv.id, status]);
  return status;
}

export async function setStatus(ctx, inv, status) {
  if (!STATUSES.includes(status)) throw badRequest('Invalid invoice status', 400);
  await query('UPDATE invoices SET status = $2, sent_at = CASE WHEN $2 = \'SENT\' AND sent_at IS NULL THEN now() ELSE sent_at END, updated_at = now() WHERE id = $1', [inv.id, status]);
  await audit({ workspaceId: ctx.workspace.id, userId: ctx.user.id, action: 'UPDATE_INVOICE', entityType: 'INVOICE', entityId: inv.id, content: { invoiceStatus: status }, previous: { status: inv.status } });
  events.emitAsync('invoice.updated', { workspaceId: ctx.workspace.id, actorId: ctx.user.id, invoiceId: inv.id, status });
}

// Scheduler job: SENT / PARTIALLY_PAID invoices past their due date become OVERDUE.
export async function markOverdueInvoices() {
  const updated = await rows("UPDATE invoices SET status = 'OVERDUE', updated_at = now() WHERE status IN ('SENT','PARTIALLY_PAID') AND due_date < CURRENT_DATE RETURNING id, workspace_id");
  for (const inv of updated) events.emitAsync('invoice.updated', { workspaceId: inv.workspace_id, actorId: null, invoiceId: inv.id, status: 'OVERDUE' });
  return updated.length;
}

// ---- listing / filtering -----------------------------------------------------------------------
// Totals are computed in JS (tax rules), so filtering by amount/balance and sorting happen in memory.
export async function queryInvoices(workspaceId, f) {
  const conds = ['i.workspace_id = $1']; const params = [workspaceId];
  if (f.statuses && f.statuses.length) { params.push(f.statuses.map((s) => String(s).toUpperCase())); conds.push(`i.status = ANY($${params.length})`); }
  if (f.clientIds && f.clientIds.length) {
    params.push(f.clientIds);
    conds.push(String(f.clientContains || 'CONTAINS').toUpperCase() === 'DOES_NOT_CONTAIN' ? `NOT (i.client_id = ANY($${params.length}))` : `i.client_id = ANY($${params.length})`);
  }
  if (f.clientStatus === 'ACTIVE') conds.push('COALESCE(c.archived, false) = false');
  if (f.clientStatus === 'ARCHIVED') conds.push('c.archived = true');
  if (f.invoiceNumber) {
    if (f.strictSearch) { params.push(String(f.invoiceNumber)); conds.push(`i.number = $${params.length}`); } else { params.push(`%${String(f.invoiceNumber).toLowerCase()}%`); conds.push(`lower(i.number) LIKE $${params.length}`); }
  }
  if (f.issueStart) { params.push(normalizeDate(f.issueStart, 'issue-date-start')); conds.push(`i.issued_date >= $${params.length}::date`); }
  if (f.issueEnd) { params.push(normalizeDate(f.issueEnd, 'issue-date-end')); conds.push(`i.issued_date <= $${params.length}::date`); }
  const list = await rows(`${BASE_SELECT} WHERE ${conds.join(' AND ')} ORDER BY i.created_at DESC, i.id DESC`, params);
  const itemsBy = await loadItemsByInvoice(list.map((i) => i.id));
  let computed = list.map((inv) => ({ inv, items: itemsBy.get(inv.id) || [], totals: computeTotals(inv, itemsBy.get(inv.id) || [], inv.paid_cents) }));
  const cmp = (v, op, x) => (x == null ? true : op === '>' ? v > Number(x) : op === '<' ? v < Number(x) : v === Number(x));
  computed = computed.filter(({ totals }) => cmp(totals.amount, '=', f.exactAmount) && cmp(totals.amount, '>', f.greaterThanAmount) && cmp(totals.amount, '<', f.lessThanAmount)
    && cmp(totals.balance, '=', f.exactBalance) && cmp(totals.balance, '>', f.greaterThanBalance) && cmp(totals.balance, '<', f.lessThanBalance));
  const col = String(f.sortColumn || 'ID').toUpperCase(); const dir = String(f.sortOrder || 'ASCENDING').toUpperCase() === 'DESCENDING' ? -1 : 1;
  const key = ({ inv, totals }) => {
    switch (col) {
      case 'CLIENT': return (inv.client_name || '').toLowerCase();
      case 'DUE_ON': return inv.due_str;
      case 'ISSUE_DATE': return inv.issued_str;
      case 'AMOUNT': return totals.amount;
      case 'BALANCE': return totals.balance;
      case 'NUMBER': return inv.number;
      default: return new Date(inv.created_at).getTime();
    }
  };
  computed.sort((a, b) => { const ka = key(a); const kb = key(b); return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir; });
  const total = computed.length;
  const page = computed.slice(f.offset || 0, (f.offset || 0) + (f.limit || 50));
  return { total, page };
}
