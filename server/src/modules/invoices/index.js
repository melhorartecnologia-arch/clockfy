// Module "invoices" – Clockify-compatible invoicing API.
//   /api/v1/workspaces/:workspaceId/invoices
// Extra (UI) routes: PUT /invoices/:invoiceId/items (replace the whole item list), POST /invoices/:invoiceId/send (e-mail the PDF),
//   settings extras (company, itemTypes, nextNumber), GET /invoices?client=&number= filters, overview extras (timeViewMode, daysOverdue, sentAt).
import { Router } from 'express';
import { one, query, insert } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z, bool, list, paging, int } from '../../lib/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { events } from '../../lib/events.js';
import { sendMail } from '../../lib/mailer.js';
import { registerJob } from '../../scheduler.js';
import { normalizeDate } from '../expenses/service.js';
import {
  STATUSES, TAX_TYPES, APPLY_TAXES, ZERO_FIELDS, CALCULATION_TYPES, DEFAULT_LABELS,
  requireInvoiceAccess, getSettingsRow, settingsDto, loadInvoice, loadItems, overviewDto, overview, createInvoice, updateInvoice, deleteInvoice, duplicateInvoice,
  normalizeItem, addItem, deleteItem, replaceItems, importItems, paymentDto, listPayments, refreshPaymentStatus, setStatus, markOverdueInvoices,
  queryInvoices, invoiceListDto, invoiceInfoDto, dateIso, userLocale, isPt,
} from './service.js';
import { renderInvoicePdf } from './pdf.js';

export const router = Router({ mergeParams: true }); // /workspaces/:workspaceId/invoices

router.use((req, res, next) => { try { requireInvoiceAccess(req.ctx); next(); } catch (err) { next(err); } });

async function respondOverview(req, res, id, status = 200) {
  res.status(status).json(await overview(req.workspace.id, id));
}

// ---- Settings -------------------------------------------------------------------------
const defaultsSchema = z.object({
  companyId: z.string().nullable().optional(),
  dueDays: z.number().int().min(0).max(3650).optional(),
  itemType: z.string().max(100).nullable().optional(),
  itemTypeId: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  subject: z.string().max(500).nullable().optional(),
  taxPercent: z.number().min(0).max(100).optional(),
  tax2Percent: z.number().min(0).max(100).optional(),
  tax: z.number().optional(),
  tax2: z.number().optional(),
  taxType: z.enum(TAX_TYPES).optional(),
  defaultImportTimeItemTypeId: z.string().max(100).nullable().optional(),
  defaultImportExpenseItemTypeId: z.string().max(100).nullable().optional(),
});
const exportFieldsSchema = z.object({ itemType: z.boolean().optional(), quantity: z.boolean().optional(), unitPrice: z.boolean().optional(), tax: z.boolean().optional(), tax2: z.boolean().optional(), rtl: z.boolean().optional(), RTL: z.boolean().optional() });
const labelsSchema = z.object(Object.fromEntries(Object.keys(DEFAULT_LABELS).map((k) => [k, z.string().max(40).nullable().optional()])));
const companySchema = z.object({ name: z.string().max(250).nullable().optional(), address: z.string().max(1000).nullable().optional(), email: z.string().max(250).nullable().optional(), logoFileId: z.string().nullable().optional() });
const settingsSchema = z.object({
  defaults: defaultsSchema.optional(),
  exportFields: exportFieldsSchema.optional(),
  labels: labelsSchema.optional(),
  company: companySchema.optional(),
  itemTypes: z.array(z.string().min(1).max(100)).optional(),
  nextNumber: z.number().int().min(1).optional(),
});

router.get('/settings', async (req, res) => {
  res.json(settingsDto(await getSettingsRow(req.workspace.id)));
});

router.put('/settings', async (req, res) => {
  req.ctx.requireAdmin();
  const body = parse(settingsSchema, req.body);
  const s = await getSettingsRow(req.workspace.id);
  const defaults = { ...(s.defaults || {}) };
  if (body.defaults) {
    for (const [k, v] of Object.entries(body.defaults)) if (v !== undefined) defaults[k] = v;
    if (body.defaults.tax !== undefined && body.defaults.taxPercent === undefined) defaults.taxPercent = body.defaults.tax;
    if (body.defaults.tax2 !== undefined && body.defaults.tax2Percent === undefined) defaults.tax2Percent = body.defaults.tax2;
    delete defaults.tax; delete defaults.tax2;
  }
  const exportFields = { ...(s.export_fields || {}) };
  if (body.exportFields) {
    for (const [k, v] of Object.entries(body.exportFields)) if (v !== undefined) exportFields[k === 'RTL' ? 'rtl' : k] = v;
  }
  // Only store labels that differ from the English defaults, so locale defaults (pt-BR) still apply on export.
  const labels = { ...(s.labels || {}) };
  if (body.labels) {
    for (const [k, v] of Object.entries(body.labels)) {
      if (v === undefined) continue;
      if (v == null || !String(v).trim() || v === DEFAULT_LABELS[k]) delete labels[k]; else labels[k] = v;
    }
  }
  const company = { ...(s.company || {}) };
  if (body.company) {
    for (const [k, v] of Object.entries(body.company)) if (v !== undefined) company[k] = v;
    if (company.logoFileId) {
      const f = await one('SELECT 1 FROM files WHERE id = $1', [company.logoFileId]);
      if (!f) throw badRequest('logoFileId: file not found', 400);
    }
  }
  const itemTypes = body.itemTypes ? [...new Set(body.itemTypes.map((t) => t.trim()).filter(Boolean))] : undefined;
  if (itemTypes && !itemTypes.length) throw badRequest('itemTypes must not be empty', 400);
  await query(
    'UPDATE invoice_settings SET defaults = $2, export_fields = $3, labels = $4, company = $5, item_types = COALESCE($6, item_types), next_number = COALESCE($7, next_number) WHERE workspace_id = $1',
    [req.workspace.id, JSON.stringify(defaults), JSON.stringify(exportFields), JSON.stringify(labels), JSON.stringify(company), itemTypes ? JSON.stringify(itemTypes) : null, body.nextNumber ?? null],
  );
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_INVOICE_SETTINGS', entityType: 'INVOICE_SETTINGS', entityId: req.workspace.id, content: body, previous: settingsDto(s) });
  res.json(settingsDto(await getSettingsRow(req.workspace.id)));
});

// ---- Invoices ----------------------------------------------------------------------------
const zeroFields = z.union([z.enum(ZERO_FIELDS), z.array(z.enum(ZERO_FIELDS))]).nullable().optional();
const invoiceSchema = z.object({
  id: z.string().optional(),
  clientId: z.string().optional(),
  companyId: z.string().nullable().optional(),
  currency: z.string().min(1).max(10).optional(),
  dueDate: z.string().optional(),
  issuedDate: z.string().optional(),
  number: z.string().max(100).nullable().optional(),
  timeViewMode: z.enum(['TIME_SENSITIVE_VIEW', 'AGGREGATED_TIME_VIEW']).nullable().optional(),
  subject: z.string().max(500).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
  billFrom: z.string().max(2000).nullable().optional(),
  clientAddress: z.string().max(2000).nullable().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  taxPercent: z.number().min(0).max(100).optional(),
  tax2Percent: z.number().min(0).max(100).optional(),
  taxType: z.enum(TAX_TYPES).optional(),
  calculationType: z.enum(CALCULATION_TYPES).optional(),
  visibleZeroFields: zeroFields,
});

router.get('/', async (req, res) => {
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  const q = req.query;
  const { total, page } = await queryInvoices(req.workspace.id, {
    statuses: list(q.statuses || q.status), clientIds: list(q.clients || q.client), invoiceNumber: q.number || q['invoice-number'], strictSearch: bool(q['strict-search'], false),
    issueStart: q['issue-date-start'] || q.start, issueEnd: q['issue-date-end'] || q.end,
    sortColumn: q['sort-column'] || q.sortColumn, sortOrder: q['sort-order'] || q.sortOrder, limit, offset,
  });
  res.json({ invoices: page.map(({ inv, items }) => invoiceListDto(inv, items)), total });
});

router.post('/', async (req, res) => {
  const b = parse(invoiceSchema, req.body);
  const inv = await createInvoice(req.ctx, b);
  res.status(201).json({ id: inv.id, number: inv.number, clientId: inv.client_id, currency: inv.currency, issuedDate: dateIso(inv.issued_str), dueDate: dateIso(inv.due_str), billFrom: inv.bill_from || '' });
});

const filterSchema = z.object({
  clients: z.object({ ids: z.array(z.string()).optional(), contains: z.string().optional(), status: z.string().optional() }).optional(),
  companies: z.any().optional(),
  statuses: z.array(z.enum(STATUSES)).optional(),
  invoiceNumber: z.string().optional(),
  strictSearch: z.boolean().optional(),
  issueDate: z.object({ 'issue-date-start': z.string().optional(), 'issue-date-end': z.string().optional(), start: z.string().optional(), end: z.string().optional() }).optional(),
  exactAmount: z.number().nullable().optional(), greaterThanAmount: z.number().nullable().optional(), lessThanAmount: z.number().nullable().optional(),
  exactBalance: z.number().nullable().optional(), greaterThanBalance: z.number().nullable().optional(), lessThanBalance: z.number().nullable().optional(),
  sortColumn: z.string().optional(), sortOrder: z.string().optional(),
  page: z.number().int().optional(), pageSize: z.number().int().optional(),
});

router.post('/info', async (req, res) => {
  const b = parse(filterSchema, req.body || {});
  const { limit, offset } = paging({ page: b.page, 'page-size': b.pageSize }, { page: 1, pageSize: 50, max: 5000 });
  const { total, page } = await queryInvoices(req.workspace.id, {
    statuses: b.statuses, clientIds: b.clients?.ids, clientContains: b.clients?.contains, clientStatus: b.clients?.status ? String(b.clients.status).toUpperCase() : undefined,
    invoiceNumber: b.invoiceNumber, strictSearch: b.strictSearch,
    issueStart: b.issueDate?.['issue-date-start'] || b.issueDate?.start, issueEnd: b.issueDate?.['issue-date-end'] || b.issueDate?.end,
    exactAmount: b.exactAmount, greaterThanAmount: b.greaterThanAmount, lessThanAmount: b.lessThanAmount,
    exactBalance: b.exactBalance, greaterThanBalance: b.greaterThanBalance, lessThanBalance: b.lessThanBalance,
    sortColumn: b.sortColumn, sortOrder: b.sortOrder, limit, offset,
  });
  res.json({ invoices: page.map(({ inv, items }) => invoiceInfoDto(inv, items)), total });
});

router.get('/:invoiceId', async (req, res) => {
  await respondOverview(req, res, (await loadInvoice(req.workspace.id, req.params.invoiceId)).id);
});

router.put('/:invoiceId', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const b = parse(invoiceSchema.extend({ status: z.enum(STATUSES).optional() }), req.body);
  await updateInvoice(req.ctx, inv, b);
  await respondOverview(req, res, inv.id);
});

router.delete('/:invoiceId', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const dto = await overview(req.workspace.id, inv.id);
  await deleteInvoice(req.ctx, inv);
  res.status(200).json(dto);
});

router.post('/:invoiceId/duplicate', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const copy = await duplicateInvoice(req.ctx, inv);
  await respondOverview(req, res, copy.id, 201);
});

router.patch('/:invoiceId/status', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const { invoiceStatus } = parse(z.object({ invoiceStatus: z.enum(STATUSES).optional(), status: z.enum(STATUSES).optional() }).transform((v) => ({ invoiceStatus: v.invoiceStatus || v.status })), req.body);
  if (!invoiceStatus) throw badRequest('invoiceStatus is required', 400);
  await setStatus(req.ctx, inv, invoiceStatus);
  await respondOverview(req, res, inv.id);
});

// ---- Items ---------------------------------------------------------------------------------
const itemSchema = z.object({
  itemType: z.string().max(100).optional(),
  description: z.string().max(3000).optional(),
  quantity: z.number().min(0).optional(),
  unitPrice: z.number().optional(),
  applyTaxes: z.enum(APPLY_TAXES).optional(),
  importType: z.string().optional(),
  timeEntryIds: z.array(z.string()).optional(),
  expenseIds: z.array(z.string()).optional(),
});

router.post('/:invoiceId/items', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const b = parse(itemSchema, req.body);
  const sd = settingsDto(await getSettingsRow(req.workspace.id));
  await addItem(inv, normalizeItem({ ...b, importType: 'NOT_IMPORTED', timeEntryIds: [], expenseIds: [] }, { itemTypes: sd.itemTypes }));
  await query('UPDATE invoices SET updated_at = now() WHERE id = $1', [inv.id]);
  events.emitAsync('invoice.updated', { workspaceId: req.workspace.id, actorId: req.user.id, invoiceId: inv.id });
  await respondOverview(req, res, inv.id);
});

// Replace the whole item list (UI); body: [items] or {items:[...]}
router.put('/:invoiceId/items', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const raw = Array.isArray(req.body) ? req.body : req.body?.items;
  if (!Array.isArray(raw)) throw badRequest('Body must be an array of items or {items: [...]}', 400);
  const items = raw.map((i) => parse(itemSchema, i));
  const sd = settingsDto(await getSettingsRow(req.workspace.id));
  await replaceItems(inv, items, { itemTypes: sd.itemTypes });
  await query('UPDATE invoices SET updated_at = now() WHERE id = $1', [inv.id]);
  events.emitAsync('invoice.updated', { workspaceId: req.workspace.id, actorId: req.user.id, invoiceId: inv.id });
  await respondOverview(req, res, inv.id);
});

const importSchema = z.object({
  from: z.string(),
  to: z.string(),
  projectFilter: z.object({ ids: z.array(z.string()).optional(), contains: z.string().optional(), status: z.string().optional() }).nullable().optional(),
  timeEntryGroupType: z.enum(['SINGLE_ITEM', 'GROUPED', 'DETAILED']).optional(),
  timeEntryPrimaryGroupBy: z.enum(['USER', 'PROJECT', 'DATE']).optional(),
  timeEntrySecondaryGroupBy: z.enum(['PROJECT', 'USER', 'TASK', 'DATE', 'DESCRIPTION', 'NONE']).optional(),
  timeEntryFieldsForDetailedGroup: z.array(z.enum(['PROJECT', 'TASK', 'TAGS', 'DESCRIPTION', 'DATE', 'USER'])).optional(),
  roundTimeEntryDuration: z.boolean().optional(),
  importExpenses: z.boolean().optional(),
  expensesGroupType: z.enum(['GROUPED', 'DETAILED']).optional(),
  expensesGroupBy: z.enum(['CATEGORY', 'PROJECT', 'USER']).optional(),
  expenseFieldsForDetailedGroup: z.array(z.enum(['PROJECT', 'TASK', 'CATEGORY', 'NOTE', 'DATE', 'USER'])).optional(),
});

router.post('/:invoiceId/items/import', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const b = parse(importSchema, req.body);
  const result = await importItems(req.ctx, inv, b);
  if (result.items.length) {
    await query('UPDATE invoices SET updated_at = now() WHERE id = $1', [inv.id]);
    await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'UPDATE_INVOICE', entityType: 'INVOICE', entityId: inv.id, content: { import: b, timeEntries: result.timeEntryIds.length, expenses: result.expenseIds.length } });
    events.emitAsync('invoice.updated', { workspaceId: req.workspace.id, actorId: req.user.id, invoiceId: inv.id });
  }
  await respondOverview(req, res, inv.id);
});

router.delete('/:invoiceId/items/:order', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const order = int(req.params.order, NaN);
  if (Number.isNaN(order)) throw badRequest('order must be an integer', 400);
  await deleteItem(inv, order);
  await query('UPDATE invoices SET updated_at = now() WHERE id = $1', [inv.id]);
  events.emitAsync('invoice.updated', { workspaceId: req.workspace.id, actorId: req.user.id, invoiceId: inv.id });
  await respondOverview(req, res, inv.id);
});

// ---- Payments -------------------------------------------------------------------------------
router.get('/:invoiceId/payments', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const { limit, offset } = paging(req.query, { page: 1, pageSize: 50, max: 5000 });
  res.json((await listPayments(inv.id, { limit, offset })).map(paymentDto));
});

router.post('/:invoiceId/payments', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const b = parse(z.object({ amount: z.number().int().positive(), note: z.string().max(2000).nullable().optional(), paymentDate: z.string().optional(), date: z.string().optional() }), req.body);
  if (inv.status === 'VOID') throw badRequest('Cannot add payments to a void invoice', 400);
  const date = b.paymentDate || b.date ? normalizeDate(b.paymentDate || b.date, 'paymentDate') : new Date().toISOString().slice(0, 10);
  const p = await insert('invoice_payments', { id: newId(), invoice_id: inv.id, amount: b.amount, date, note: b.note || null, author_id: req.user.id });
  const status = await refreshPaymentStatus(inv);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'CREATE_INVOICE_PAYMENT', entityType: 'INVOICE', entityId: inv.id, content: { paymentId: p.id, ...b, status } });
  events.emitAsync('invoice.updated', { workspaceId: req.workspace.id, actorId: req.user.id, invoiceId: inv.id, paymentId: p.id, status });
  await respondOverview(req, res, inv.id, 201);
});

router.delete('/:invoiceId/payments/:paymentId', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const p = await one('SELECT * FROM invoice_payments WHERE id = $1 AND invoice_id = $2', [req.params.paymentId, inv.id]);
  if (!p) throw notFound('Payment not found', 404);
  await query('DELETE FROM invoice_payments WHERE id = $1', [p.id]);
  const status = await refreshPaymentStatus(inv);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'DELETE_INVOICE_PAYMENT', entityType: 'INVOICE', entityId: inv.id, previous: paymentDto(p), content: { status } });
  events.emitAsync('invoice.updated', { workspaceId: req.workspace.id, actorId: req.user.id, invoiceId: inv.id, status });
  await respondOverview(req, res, inv.id);
});

// ---- Export (PDF) & send ------------------------------------------------------------------------
async function buildPdf(req, inv, locale) {
  const settings = settingsDto(await getSettingsRow(req.workspace.id));
  const dto = overviewDto(inv, await loadItems(inv.id), settings);
  let logo = null;
  if (settings.company.logoFileId) {
    const f = await one('SELECT mime_type, data FROM files WHERE id = $1', [settings.company.logoFileId]);
    if (f && /^image\/(png|jpe?g)$/i.test(f.mime_type)) logo = f.data;
  }
  const pdf = await renderInvoicePdf({ overview: dto, settings, locale, logo });
  const filename = `invoice-${String(inv.number).replace(/[^\w.-]+/g, '_')}.pdf`;
  return { pdf, filename, dto, settings };
}

router.get('/:invoiceId/export', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const locale = req.query.userLocale || req.query.locale || userLocale(req.ctx);
  const { pdf, filename } = await buildPdf(req, inv, locale);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Length', String(pdf.length));
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdf);
});

router.post('/:invoiceId/send', async (req, res) => {
  const inv = await loadInvoice(req.workspace.id, req.params.invoiceId);
  const b = parse(z.object({ to: z.union([z.string(), z.array(z.string())]).optional(), cc: z.union([z.string(), z.array(z.string())]).optional(), subject: z.string().max(500).optional(), message: z.string().max(10000).optional(), userLocale: z.string().optional() }), req.body || {});
  const to = list(b.to).length ? list(b.to) : (inv.client_email ? [inv.client_email] : []);
  if (!to.length) throw badRequest('Client has no e-mail address; provide `to`', 400);
  const cc = b.cc !== undefined ? list(b.cc) : (inv.client_cc_emails || []);
  const locale = b.userLocale || userLocale(req.ctx);
  const { pdf, filename, dto, settings } = await buildPdf(req, inv, locale);
  const pt = isPt(locale);
  const company = settings.company.name || req.workspace.name;
  const subject = b.subject || (pt ? `Fatura ${inv.number} - ${company}` : `Invoice ${inv.number} - ${company}`);
  const text = b.message || (pt
    ? `Olá ${dto.clientName},\n\nSegue em anexo a fatura ${inv.number} no valor de ${dto.currency} ${(dto.amount / 100).toFixed(2)}, com vencimento em ${String(dto.dueDate).slice(0, 10)}.\n\n${company}`
    : `Hello ${dto.clientName},\n\nPlease find attached invoice ${inv.number} for ${dto.currency} ${(dto.amount / 100).toFixed(2)}, due on ${String(dto.dueDate).slice(0, 10)}.\n\n${company}`);
  // mailer.sendMail has no cc field: recipients are combined in `to`
  await sendMail({ to: [...new Set([...to, ...cc])].join(', '), subject, text, attachments: [{ filename, content: pdf, contentType: 'application/pdf' }] });
  const newStatus = ['UNSENT', 'SENT', 'OVERDUE'].includes(inv.status) ? 'SENT' : inv.status;
  await query('UPDATE invoices SET status = $2, sent_at = now(), updated_at = now() WHERE id = $1', [inv.id, newStatus]);
  await audit({ workspaceId: req.workspace.id, userId: req.user.id, action: 'SEND_INVOICE', entityType: 'INVOICE', entityId: inv.id, content: { to, cc, subject } });
  events.emitAsync('invoice.updated', { workspaceId: req.workspace.id, actorId: req.user.id, invoiceId: inv.id, status: newStatus, sent: true });
  await respondOverview(req, res, inv.id);
});

// Scheduler: hourly check marking SENT / PARTIALLY_PAID invoices past due as OVERDUE.
registerJob('invoices.mark-overdue', 60 * 60 * 1000, markOverdueInvoices);

export { markOverdueInvoices, overview, loadInvoice };
export default {
  name: 'invoices',
  workspace(ws) { ws.use('/invoices', router); },
};
