// Invoice PDF export (pdfkit). Labels come from invoice settings (overrides) merged with locale defaults.
import PDFDocument from 'pdfkit';
import { labelsFor, isPt } from './service.js';

const STRINGS = {
  en: { invoice: 'INVOICE', number: 'Invoice #', status: 'Status', subject: 'Subject', page: 'Page', hours: 'h' },
  pt: { invoice: 'FATURA', number: 'Fatura nº', status: 'Situação', subject: 'Assunto', page: 'Página', hours: 'h' },
};

export function fmtMoney(cents, currency, locale) {
  const v = Number(cents || 0) / 100;
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'USD' }).format(v); } catch { return `${currency || ''} ${v.toFixed(2)}`.trim(); }
}

export function fmtNumber(n, locale) {
  const v = Number(n || 0);
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v); } catch { return String(v); }
}

export function fmtDate(iso, locale) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(new Date(iso)); } catch { return String(iso).slice(0, 10); }
}

// Renders the invoice overview DTO to a PDF Buffer.
export function renderInvoicePdf({ overview, settings, locale = 'en', logo = null }) {
  const loc = isPt(locale) ? 'pt-BR' : 'en';
  const L = labelsFor(settings, locale);
  const S = STRINGS[isPt(locale) ? 'pt' : 'en'];
  const ef = { ...settings.exportFields };
  const rtl = !!ef.rtl;
  const align = rtl ? 'right' : 'left';
  const cur = overview.currency;
  const money = (c) => fmtMoney(c, cur, loc);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${S.invoice} ${overview.number}`, Author: settings.company?.name || '' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left; const right = doc.page.width - doc.page.margins.right; const width = right - left;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const gray = '#666666'; const line = '#dddddd';

    // Header: logo + company (bill from) on the left, title/number/dates on the right
    let y = 50;
    if (logo) { try { doc.image(logo, left, y, { fit: [140, 60] }); y += 70; } catch { /* unsupported image format – skip logo */ } }
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#222222').text(S.invoice, left + width / 2, 50, { width: width / 2, align: 'right' });
    doc.font('Helvetica').fontSize(11).fillColor(gray).text(`${S.number} ${overview.number}`, left + width / 2, 76, { width: width / 2, align: 'right' });
    doc.fontSize(9).fillColor(gray).text(`${S.status}: ${overview.status}`, left + width / 2, 92, { width: width / 2, align: 'right' });

    doc.fontSize(8).fillColor(gray).font('Helvetica-Bold').text(L.billFrom, left, y, { width: width / 2, align });
    doc.font('Helvetica').fontSize(10).fillColor('#222222');
    const billFrom = overview.billFrom || settings.company?.name || '';
    doc.text(billFrom, left, doc.y + 2, { width: width / 2, align });
    if (settings.company?.email) doc.text(settings.company.email, { width: width / 2, align });
    const afterFrom = doc.y;

    // Dates block (right column)
    let ry = Math.max(115, y);
    const dateRow = (label, val) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(gray).text(label, left + width / 2, ry, { width: width / 4, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor('#222222').text(val, left + (3 * width) / 4, ry - 1, { width: width / 4, align: 'right' });
      ry += 16;
    };
    dateRow(L.issueDate, fmtDate(overview.issuedDate, loc));
    dateRow(L.dueDate, fmtDate(overview.dueDate, loc));

    y = Math.max(afterFrom, ry) + 16;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(gray).text(L.billTo, left, y, { width: width / 2, align });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#222222').text(overview.clientName || '', left, doc.y + 2, { width: width / 2, align });
    if (overview.clientAddress) doc.font('Helvetica').fontSize(10).text(overview.clientAddress, { width: width / 2, align });
    y = doc.y + 14;
    if (overview.subject) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(gray).text(S.subject, left, y, { width, align });
      doc.font('Helvetica').fontSize(11).fillColor('#222222').text(overview.subject, left, doc.y + 2, { width, align });
      y = doc.y + 14;
    }

    // Items table
    const showTax = ef.tax !== false && (overview.tax > 0 || (overview.visibleZeroFields || []).includes('TAX')) && overview.taxType !== 'NONE';
    const showTax2 = ef.tax2 !== false && (overview.tax2 > 0 || (overview.visibleZeroFields || []).includes('TAX_2')) && overview.taxType !== 'NONE';
    const cols = [];
    if (ef.itemType !== false) cols.push({ key: 'itemType', label: L.itemType, w: 65, align: 'left' });
    cols.push({ key: 'description', label: L.description, w: 0, align: 'left' });
    if (ef.quantity !== false) cols.push({ key: 'quantity', label: L.quantity, w: 70, align: 'right' });
    if (ef.unitPrice !== false) cols.push({ key: 'unitPrice', label: L.unitPrice, w: 90, align: 'right' });
    if (showTax) cols.push({ key: 'tax', label: L.tax, w: 55, align: 'right' });
    if (showTax2) cols.push({ key: 'tax2', label: L.tax2, w: 55, align: 'right' });
    cols.push({ key: 'amount', label: L.amount, w: 85, align: 'right' });
    const fixed = cols.reduce((a, c) => a + c.w, 0);
    cols.find((c) => c.key === 'description').w = width - fixed;
    if (rtl) cols.reverse();
    const pad = 4;
    const cellValue = (it, c) => {
      switch (c.key) {
        case 'itemType': return it.itemType || '';
        case 'description': return it.description || '';
        case 'quantity': return fmtNumber(it.quantity, loc);
        case 'unitPrice': return money(it.unitPrice);
        case 'tax': return it.applyTaxes === 'TAX1' || it.applyTaxes === 'TAX1TAX2' ? `${fmtNumber(overview.tax, loc)}%` : '-';
        case 'tax2': return it.applyTaxes === 'TAX2' || it.applyTaxes === 'TAX1TAX2' ? `${fmtNumber(overview.tax2, loc)}%` : '-';
        case 'amount': return money(it.amount);
        default: return '';
      }
    };
    const drawHeader = () => {
      doc.rect(left, y, width, 20).fill('#f0f0f0');
      let x = left;
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#333333');
      for (const c of cols) { doc.text(c.label, x + pad, y + 7, { width: c.w - pad * 2, align: c.align, lineBreak: false, ellipsis: true, height: 10 }); x += c.w; }
      y += 20;
    };
    drawHeader();
    doc.font('Helvetica').fontSize(9).fillColor('#222222');
    for (const it of overview.items) {
      const heights = cols.map((c) => doc.heightOfString(cellValue(it, c), { width: c.w - pad * 2 }));
      const h = Math.max(14, ...heights) + pad * 2;
      if (y + h > bottom - 20) { doc.addPage(); y = doc.page.margins.top; drawHeader(); doc.font('Helvetica').fontSize(9).fillColor('#222222'); }
      let x = left;
      for (const c of cols) { doc.text(cellValue(it, c), x + pad, y + pad, { width: c.w - pad * 2, align: c.align }); x += c.w; }
      y += h;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(line).lineWidth(0.5).stroke();
    }
    y += 10;

    // Totals
    const totals = [];
    totals.push([L.subtotal, money(overview.subtotal)]);
    if (overview.discount > 0 || (overview.visibleZeroFields || []).includes('DISCOUNT')) totals.push([`${L.discount} (${fmtNumber(overview.discount, loc)}%)`, `-${money(overview.discountAmount)}`]);
    if (showTax) totals.push([`${L.tax} (${fmtNumber(overview.tax, loc)}%)`, money(overview.taxAmount)]);
    if (showTax2) totals.push([`${L.tax2} (${fmtNumber(overview.tax2, loc)}%)`, money(overview.tax2Amount)]);
    totals.push([L.total, money(overview.amount), true]);
    if (overview.paid > 0) totals.push([L.paid, `-${money(overview.paid)}`]);
    totals.push([L.totalAmountDue || L.totalAmount, money(overview.balance), true]);
    const tw = 260; const tx = right - tw;
    if (y + totals.length * 18 > bottom - 20) { doc.addPage(); y = doc.page.margins.top; }
    for (const [label, val, bold] of totals) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(bold ? '#222222' : gray);
      doc.text(label, tx, y, { width: tw / 2, align: 'left', lineBreak: false });
      doc.fillColor('#222222').text(val, tx + tw / 2, y, { width: tw / 2, align: 'right', lineBreak: false });
      y += bold ? 20 : 16;
    }

    // Notes
    if (overview.note) {
      y += 10;
      const nh = doc.heightOfString(overview.note, { width }) + 20;
      if (y + nh > bottom) { doc.addPage(); y = doc.page.margins.top; }
      doc.font('Helvetica-Bold').fontSize(8).fillColor(gray).text(L.notes, left, y, { width, align });
      doc.font('Helvetica').fontSize(9).fillColor('#222222').text(overview.note, left, doc.y + 2, { width, align });
    }
    doc.end();
  });
}
