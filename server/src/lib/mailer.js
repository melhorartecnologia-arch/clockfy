import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transporter = null;
export const outbox = []; // last sent messages (useful for tests / dev without SMTP)

function getTransporter() {
  if (transporter) return transporter;
  if (config.smtp.host) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  } else {
    transporter = { sendMail: async (msg) => { console.log(`[mail] (SMTP not configured) to=${msg.to} subject=${msg.subject}`); return { messageId: 'console' }; } };
  }
  return transporter;
}

// Placeholder addresses under the reserved ".invalid" TLD (RFC 2606) – e.g. imported Clockify users that have no
// e-mail – never receive mail.
const deliverable = (addr) => !/\.invalid>?$/i.test(String(addr || '').trim());
function filterRecipients(to) {
  if (Array.isArray(to)) return to.filter(deliverable);
  if (typeof to === 'string') return to.split(',').map((s) => s.trim()).filter((s) => s && deliverable(s)).join(', ');
  return to;
}

export async function sendMail({ to, subject, text, html, attachments }) {
  to = filterRecipients(to);
  if (!to || (Array.isArray(to) && !to.length)) return null;
  const msg = { from: config.smtp.from, to, subject, text, html, attachments };
  outbox.push(msg);
  if (outbox.length > 100) outbox.shift();
  try { return await getTransporter().sendMail(msg); } catch (err) { console.error('[mail] failed', err.message); return null; }
}
