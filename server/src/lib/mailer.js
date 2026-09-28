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

export async function sendMail({ to, subject, text, html, attachments }) {
  const msg = { from: config.smtp.from, to, subject, text, html, attachments };
  outbox.push(msg);
  if (outbox.length > 100) outbox.shift();
  try { return await getTransporter().sendMail(msg); } catch (err) { console.error('[mail] failed', err.message); return null; }
}
