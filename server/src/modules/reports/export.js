// CSV / XLSX / PDF exports for reports. Each report is first turned into a generic table
// ({title, subtitle, columns, rows, footer}) and then rendered by one of the three writers.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatHms, formatDecimal } from '../../lib/duration.js';
import { zonedParts, localDateString } from '../../lib/dates.js';

const MIME = {
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
};
const EXT = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf' };

export function isFileExport(type) { return ['CSV', 'XLSX', 'PDF'].includes(String(type || '').toUpperCase()); }

// ---- formatting ---------------------------------------------------------------
export function formatDate(date, timeZone, format = 'YYYY-MM-DD') {
  if (!date) return '';
  const p = zonedParts(new Date(date), timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return String(format || 'YYYY-MM-DD').replace(/YYYY/g, String(p.year)).replace(/MM/g, pad(p.month)).replace(/DD/g, pad(p.day));
}

export function formatTime(date, timeZone, timeFormat = 'HOUR24') {
  if (!date) return '';
  const p = zonedParts(new Date(date), timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  if (String(timeFormat).toUpperCase() === 'HOUR12') {
    const h = p.hour % 12 || 12;
    return `${pad(h)}:${pad(p.minute)}:${pad(p.second)} ${p.hour < 12 ? 'AM' : 'PM'}`;
  }
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

const money = (v) => (v == null ? '' : Number(v).toFixed(2));
const rateMoney = (cents) => (cents == null ? '' : (Number(cents) / 100).toFixed(2));

export function rangeLabel(f) {
  return `${localDateString(f.start, f.timeZone)} - ${localDateString(f.end, f.timeZone)}`;
}

function amountColumns(f, currency) {
  const cols = [];
  if (f.amountTypes.includes('EARNED')) cols.push({ key: 'billableRate', label: `Billable Rate (${currency})`, align: 'right' }, { key: 'earned', label: `Billable Amount (${currency})`, align: 'right' });
  if (f.amountTypes.includes('COST')) cols.push({ key: 'costRate', label: `Cost Rate (${currency})`, align: 'right' }, { key: 'cost', label: `Cost Amount (${currency})`, align: 'right' });
  if (f.amountTypes.includes('PROFIT')) cols.push({ key: 'profit', label: `Profit (${currency})`, align: 'right' });
  return cols;
}

// ---- table builders ------------------------------------------------------------
export function detailedTable({ result, filter: f, entries, userGroups }, ctx) {
  const currency = ctx.workspace.hourly_rate_currency || 'USD';
  const columns = [
    { key: 'project', label: 'Project' }, { key: 'client', label: 'Client' }, { key: 'description', label: 'Description', width: 2 }, { key: 'task', label: 'Task' },
    { key: 'user', label: 'User' }, { key: 'group', label: 'Group' }, { key: 'email', label: 'Email' }, { key: 'tags', label: 'Tags' }, { key: 'billable', label: 'Billable' },
    { key: 'startDate', label: 'Start Date' }, { key: 'startTime', label: 'Start Time' }, { key: 'endDate', label: 'End Date' }, { key: 'endTime', label: 'End Time' },
    { key: 'duration', label: 'Duration (h)', align: 'right' }, { key: 'decimal', label: 'Duration (decimal)', align: 'right' },
    ...amountColumns(f, currency),
  ];
  const rows = entries.map((e) => ({
    project: e.project_name || '', client: e.client_name || '', description: e.description || '', task: e.task_name || '',
    user: e.user_name || '', group: (userGroups?.get(e.user_id) || []).map((g) => g.name).join(', '), email: e.user_email || '',
    tags: (e.tags || []).map((t) => t.name).join(', '), billable: e.billable ? 'Yes' : 'No',
    startDate: formatDate(e.start_time, f.timeZone, f.dateFormat), startTime: formatTime(e.start_time, f.timeZone, f.timeFormat),
    endDate: formatDate(e.end_time, f.timeZone, f.dateFormat), endTime: formatTime(e.end_time, f.timeZone, f.timeFormat),
    duration: formatHms(e.seconds), decimal: formatDecimal(e.seconds),
    billableRate: e.ratesVisible ? rateMoney(e.hourly_rate_amount) : '', earned: e.ratesVisible ? money(e.earned) : '',
    costRate: e.ratesVisible ? rateMoney(e.cost_rate_amount) : '', cost: e.ratesVisible ? money(e.cost) : '', profit: e.ratesVisible ? money(e.profit) : '',
  }));
  const t = result.totals?.[0];
  const footer = t ? { project: 'Total', duration: formatHms(t.totalTime), decimal: formatDecimal(t.totalTime), earned: money(t.amounts.find((a) => a.type === 'EARNED')?.value), cost: money(t.amounts.find((a) => a.type === 'COST')?.value), profit: money(t.amounts.find((a) => a.type === 'PROFIT')?.value) } : null;
  return { title: 'Detailed report', subtitle: `${ctx.workspace.name} · ${rangeLabel(f)}`, columns, rows, footer };
}

const GROUP_LABELS = { PROJECT: 'Project', CLIENT: 'Client', USER: 'User', TASK: 'Task', TAG: 'Tag', DATE: 'Date', WEEK: 'Week', MONTH: 'Month', YEAR: 'Year', USERGROUP: 'Group', USER_GROUP: 'Group', TIMEENTRY: 'Time Entry', BILLABILITY: 'Billability' };

export function summaryTable({ result, filter: f, groups }, ctx) {
  const currency = ctx.workspace.hourly_rate_currency || 'USD';
  const levels = groups.map((g, i) => ({ key: `g${i}`, label: GROUP_LABELS[g] || 'Custom field', width: i === 0 ? 1.5 : 1 }));
  const columns = [...levels, { key: 'duration', label: 'Duration (h)', align: 'right' }, { key: 'decimal', label: 'Duration (decimal)', align: 'right' }];
  for (const a of f.amountTypes) columns.push({ key: a.toLowerCase(), label: `${a === 'EARNED' ? 'Amount' : a === 'COST' ? 'Cost' : 'Profit'} (${currency})`, align: 'right' });
  const rows = [];
  const walk = (list, path) => {
    for (const g of list || []) {
      const row = { duration: formatHms(g.duration), decimal: formatDecimal(g.duration) };
      path.forEach((name, i) => { row[`g${i}`] = name; });
      row[`g${path.length}`] = g.name;
      for (const a of g.amounts || []) row[a.type.toLowerCase()] = money(a.value);
      rows.push(row);
      if (g.children) walk(g.children, [...path, g.name]);
    }
  };
  walk(result.groupOne, []);
  const t = result.totals?.[0];
  const footer = t ? { g0: 'Total', duration: formatHms(t.totalTime), decimal: formatDecimal(t.totalTime), ...Object.fromEntries((t.amounts || []).map((a) => [a.type.toLowerCase(), money(a.value)])) } : null;
  return { title: 'Summary report', subtitle: `${ctx.workspace.name} · ${rangeLabel(f)}`, columns, rows, footer };
}

export function weeklyTable({ result, filter: f, days, group, subgroup }, ctx) {
  const currency = ctx.workspace.hourly_rate_currency || 'USD';
  const earnings = subgroup === 'EARNINGS';
  const columns = [{ key: 'group', label: group === 'USER' ? 'User' : 'Project', width: 1.5 }, { key: 'sub', label: group === 'USER' ? 'Project' : 'User', width: 1.5 }];
  for (const d of days) columns.push({ key: d, label: d, align: 'right' });
  columns.push({ key: 'total', label: earnings ? `Total (${currency})` : 'Total', align: 'right' });
  const cell = (dt) => (earnings ? money(dt.amount) : formatHms(dt.duration));
  const rows = [];
  for (const g of result.groupOne) {
    const row = { group: g.name, sub: '', total: earnings ? money(g.amount) : formatHms(g.duration) };
    for (const dt of g.days) row[dt.date] = cell(dt);
    rows.push(row);
    for (const c of g.children || []) {
      const r = { group: '', sub: c.name, total: earnings ? money(c.amount) : formatHms(c.duration) };
      for (const dt of c.days) r[dt.date] = cell(dt);
      rows.push(r);
    }
  }
  const t = result.totals?.[0];
  const footer = { group: 'Total', total: earnings ? money(t?.totalAmount) : formatHms(t?.totalTime || 0) };
  for (const dt of result.totalsByDay) footer[dt.date] = cell(dt);
  return { title: 'Weekly report', subtitle: `${ctx.workspace.name} · ${rangeLabel(f)}`, columns, rows, footer };
}

export function attendanceTable({ result, filter: f }, ctx) {
  const columns = [
    { key: 'user', label: 'User', width: 1.5 }, { key: 'date', label: 'Date' }, { key: 'start', label: 'Start' }, { key: 'end', label: 'End' },
    { key: 'break', label: 'Break', align: 'right' }, { key: 'work', label: 'Work', align: 'right' }, { key: 'capacity', label: 'Capacity', align: 'right' },
    { key: 'remaining', label: 'Remaining', align: 'right' }, { key: 'overtime', label: 'Overtime', align: 'right' }, { key: 'timeOff', label: 'Time off', align: 'right' },
  ];
  const rows = result.entities.map((x) => ({
    user: x.userName, date: formatDate(`${x.date}T00:00:00Z`, 'UTC', f.dateFormat), start: formatTime(x.startTime, f.timeZone, f.timeFormat), end: x.hasRunningEntry ? 'running' : formatTime(x.endTime, f.timeZone, f.timeFormat),
    break: formatHms(x.break), work: formatHms(x.totalDuration), capacity: formatHms(x.capacity), remaining: formatHms(x.remainingCapacity), overtime: formatHms(x.overtime), timeOff: formatHms(x.timeOff),
  }));
  const sum = (k) => result.entities.reduce((s, x) => s + (x[k] || 0), 0);
  const footer = { user: 'Total', break: formatHms(sum('break')), work: formatHms(sum('totalDuration')), capacity: formatHms(sum('capacity')), remaining: formatHms(sum('remainingCapacity')), overtime: formatHms(sum('overtime')), timeOff: formatHms(sum('timeOff')) };
  return { title: 'Attendance report', subtitle: `${ctx.workspace.name} · ${rangeLabel(f)}`, columns, rows, footer };
}

export function expensesTable({ result, filter: f }, ctx) {
  const currency = ctx.workspace.hourly_rate_currency || 'USD';
  const columns = [
    { key: 'user', label: 'User' }, { key: 'email', label: 'Email' }, { key: 'project', label: 'Project' }, { key: 'client', label: 'Client' }, { key: 'category', label: 'Category' },
    { key: 'date', label: 'Date' }, { key: 'note', label: 'Note', width: 2 }, { key: 'quantity', label: 'Quantity', align: 'right' }, { key: 'amount', label: `Amount (${currency})`, align: 'right' },
    { key: 'billable', label: 'Billable' }, { key: 'invoiced', label: 'Invoiced' },
  ];
  const rows = result.expenses.map((x) => ({
    user: x.userName, email: x.userEmail, project: x.projectName, client: x.clientName, category: x.categoryName, date: formatDate(x.date, 'UTC', f.dateFormat),
    note: x.notes, quantity: String(x.quantity), amount: money(x.amount), billable: x.billable ? 'Yes' : 'No', invoiced: x.invoicingInfo ? 'Yes' : 'No',
  }));
  const footer = { user: 'Total', amount: money(result.totals.totalAmount), note: `${result.totals.expensesCount} expense(s)` };
  return { title: 'Expense report', subtitle: `${ctx.workspace.name} · ${rangeLabel(f)}`, columns, rows, footer };
}

// ---- writers -------------------------------------------------------------------
export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(table) {
  const lines = [table.columns.map((c) => csvEscape(c.label)).join(',')];
  for (const r of table.rows) lines.push(table.columns.map((c) => csvEscape(r[c.key])).join(','));
  if (table.footer) lines.push(table.columns.map((c) => csvEscape(table.footer[c.key])).join(','));
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

export async function toXlsx(table) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Clockfy';
  const ws = wb.addWorksheet(table.title.slice(0, 31));
  ws.addRow([table.title]).font = { bold: true, size: 14 };
  ws.addRow([table.subtitle]);
  ws.addRow([]);
  const header = ws.addRow(table.columns.map((c) => c.label));
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  for (const r of table.rows) ws.addRow(table.columns.map((c) => r[c.key] ?? ''));
  if (table.footer) ws.addRow(table.columns.map((c) => table.footer[c.key] ?? '')).font = { bold: true };
  table.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(60, Math.max(12, ...table.rows.slice(0, 200).map((r) => String(r[c.key] ?? '').length + 2), c.label.length + 2));
    if (c.align === 'right') col.alignment = { horizontal: 'right' };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(table) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true, info: { Title: table.title, Author: 'Clockfy' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const weights = table.columns.map((c) => c.width || 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / totalWeight) * width);
    const fontSize = table.columns.length > 14 ? 6 : table.columns.length > 9 ? 7 : 8;
    const pad = 3;

    doc.font('Helvetica-Bold').fontSize(16).text(table.title, left, 30);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(table.subtitle, left, doc.y + 2).fillColor('#000');
    doc.moveDown(0.8);

    const rowHeight = (values, font) => {
      doc.font(font).fontSize(fontSize);
      let h = fontSize + pad * 2;
      table.columns.forEach((c, i) => {
        const txt = values[c.key] == null ? '' : String(values[c.key]);
        h = Math.max(h, doc.heightOfString(txt, { width: widths[i] - pad * 2 }) + pad * 2);
      });
      return h;
    };
    const drawRow = (values, { font = 'Helvetica', fill } = {}) => {
      const h = rowHeight(values, font);
      if (doc.y + h > bottom) { doc.addPage(); drawHeader(); }
      const y = doc.y;
      if (fill) doc.rect(left, y, width, h).fill(fill).fillColor('#000');
      doc.font(font).fontSize(fontSize);
      let x = left;
      table.columns.forEach((c, i) => {
        const txt = values[c.key] == null ? '' : String(values[c.key]);
        doc.text(txt, x + pad, y + pad, { width: widths[i] - pad * 2, align: c.align || 'left' });
        x += widths[i];
      });
      doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).strokeColor('#cccccc').stroke().strokeColor('#000');
      doc.x = left;
      doc.y = y + h;
    };
    const drawHeader = () => drawRow(Object.fromEntries(table.columns.map((c) => [c.key, c.label])), { font: 'Helvetica-Bold', fill: '#efefef' });

    drawHeader();
    for (const r of table.rows) drawRow(r);
    if (table.footer) drawRow(table.footer, { font: 'Helvetica-Bold', fill: '#f7f7f7' });
    if (!table.rows.length) { doc.moveDown(); doc.font('Helvetica-Oblique').fontSize(9).text('No data for the selected filter.', left); }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(7).fillColor('#777').text(`Page ${i + 1} of ${range.count} · Generated by Clockfy`, left, doc.page.height - 22, { width, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

export async function renderTable(table, type) {
  const t = String(type).toUpperCase();
  if (t === 'CSV') return { buffer: toCsv(table), mime: MIME.CSV, ext: EXT.CSV };
  if (t === 'XLSX') return { buffer: await toXlsx(table), mime: MIME.XLSX, ext: EXT.XLSX };
  return { buffer: await toPdf(table), mime: MIME.PDF, ext: EXT.PDF };
}

export function exportFileName(title, f, ext) {
  const base = `Clockfy_${title.replace(/\s+/g, '_')}_${localDateString(f.start, f.timeZone)}_${localDateString(f.end, f.timeZone)}`;
  return `${base}.${ext}`;
}

// Writes the export as a file download
export async function sendExport(res, table, type, f) {
  const { buffer, mime, ext } = await renderTable(table, type);
  const filename = exportFileName(table.title, f, ext);
  res.set('Content-Type', mime);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Content-Length', String(buffer.length));
  res.status(200).end(buffer);
  return filename;
}
