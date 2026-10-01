// Approval of accounts created through the public sign-up page.
//
// With REGISTRATION_APPROVAL on (default), POST /auth/register creates the account as PENDING_APPROVAL: it cannot sign
// in until a system administrator (users.is_super_admin) approves it. Accounts created by an administrator – workspace
// invitations and the Clockify import – do not go through this queue. The very first account of an installation is
// approved automatically and becomes system administrator, so that someone can approve the next ones.
import { one, rows, query, transaction } from '../../lib/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { sendMail } from '../../lib/mailer.js';
import { toIso } from '../../lib/dates.js';
import { config } from '../../config.js';
import { createWorkspace, addUserToWorkspace } from '../workspaces/service.js';

export const PENDING = 'PENDING_APPROVAL';
export const REJECTED = 'REJECTED';
export const ACCOUNT_STATUSES = ['PENDING_APPROVAL', 'REJECTED', 'ACTIVE', 'PENDING_EMAIL_VERIFICATION', 'NOT_REGISTERED', 'DELETED'];

// Error codes (body.code) the web app uses to show the right screen
export const CODE_EMAIL_INVITED = 1010;
export const CODE_PENDING_APPROVAL = 1011;
export const CODE_REJECTED = 1012;

// Statuses a successful password reset / accepted invitation turns into ACTIVE (accounts created by an administrator)
export const ACTIVATABLE = ['PENDING_EMAIL_VERIFICATION', 'NOT_REGISTERED', 'ACTIVE'];

export const PENDING_MESSAGE = 'Sua conta está aguardando a aprovação de um administrador. Você receberá um e-mail quando ela for aprovada.';
export const REJECTED_MESSAGE = 'O cadastro desta conta não foi aprovado. Fale com um administrador do Clockfy.';

// Error for an account that may not sign in, or null.
export function signInBlock(user) {
  if (user.status === PENDING) return forbidden(PENDING_MESSAGE, CODE_PENDING_APPROVAL);
  if (user.status === REJECTED) return forbidden(REJECTED_MESSAGE, CODE_REJECTED);
  return null;
}

export async function systemAdmins() {
  return rows("SELECT id, email, name FROM users WHERE is_super_admin AND status = 'ACTIVE' ORDER BY created_at");
}

// The first account of an installation needs no approval (nobody could approve it).
export async function isFirstAccount() {
  return !(await one("SELECT 1 FROM users WHERE status = 'ACTIVE' AND password_hash IS NOT NULL LIMIT 1"));
}

// Installations that already had accounts before approvals existed get their oldest active account as system
// administrator (run at startup while approvals are on and there is no administrator).
export async function ensureSystemAdmin() {
  if (!config.registrationApproval) return null;
  if ((await systemAdmins()).length) return null;
  return one(`UPDATE users SET is_super_admin = true WHERE id = (SELECT id FROM users WHERE status = 'ACTIVE' AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1) RETURNING id, email, name`);
}

export function accountDto(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    systemAdmin: !!u.is_super_admin,
    createdAt: toIso(u.created_at),
    requestedWorkspaceName: u.signup?.workspaceName || null,
    signup: u.signup ? { workspaceName: u.signup.workspaceName || null, timeZone: u.signup.timeZone || null, ip: u.signup.ip || null, requestedAt: u.signup.requestedAt || null } : null,
    approvedAt: toIso(u.approved_at),
    approvedBy: u.approved_by ? { id: u.approved_by, name: u.approver_name || null } : null,
    rejectedAt: toIso(u.rejected_at),
    rejectedBy: u.rejected_by ? { id: u.rejected_by, name: u.rejecter_name || null } : null,
    rejectionReason: u.rejection_reason || null,
    workspaces: u.workspace_count == null ? undefined : Number(u.workspace_count),
  };
}

export async function listAccounts({ status = PENDING, q, limit = 50, offset = 0 } = {}) {
  const conds = []; const params = [];
  if (status && status !== 'ALL') { params.push(status); conds.push(`u.status = $${params.length}`); }
  if (q) { params.push(`%${String(q).toLowerCase()}%`); conds.push(`(lower(u.email) LIKE $${params.length} OR lower(u.name) LIKE $${params.length})`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = Number((await one(`SELECT count(*)::int AS c FROM users u ${where}`, params)).c);
  params.push(limit, offset);
  const list = await rows(
    `SELECT u.*, a.name AS approver_name, r.name AS rejecter_name,
            (SELECT count(*) FROM workspace_members m WHERE m.user_id = u.id AND m.status = 'ACTIVE') AS workspace_count
       FROM users u LEFT JOIN users a ON a.id = u.approved_by LEFT JOIN users r ON r.id = u.rejected_by
       ${where} ORDER BY ${status === PENDING ? 'u.created_at ASC' : 'u.created_at DESC'} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { total, accounts: list.map(accountDto) };
}

export async function accountSummary() {
  const r = await one(`SELECT count(*) FILTER (WHERE status = 'PENDING_APPROVAL')::int AS pending, count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
                              count(*) FILTER (WHERE is_super_admin AND status = 'ACTIVE')::int AS admins FROM users`);
  return { pending: r.pending, rejected: r.rejected, systemAdmins: r.admins, registrationApproval: config.registrationApproval };
}

// Tells the system administrators that someone is waiting (in-app notification + e-mail).
export async function notifyAdminsOfSignup(user) {
  const admins = await systemAdmins();
  if (!admins.length) return;
  const link = `${config.appUrl}/accounts`;
  await notify(admins.map((a) => a.id), {
    type: 'ACCOUNT_PENDING_APPROVAL',
    title: 'Novo cadastro aguardando aprovação',
    body: `${user.name} <${user.email}> criou uma conta e aguarda aprovação.`,
    payload: { userId: user.id, email: user.email, link: '/accounts' },
  });
  await sendMail({
    to: admins.map((a) => a.email),
    subject: 'Novo cadastro aguardando aprovação – Clockfy',
    text: `${user.name} <${user.email}> criou uma conta no Clockfy e só poderá entrar depois de aprovada.\n\nConfirme que a pessoa é quem diz ser e aprove ou recuse em: ${link}`,
  });
}

async function loadAccount(userId) {
  const u = await one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!u) throw notFound('Conta não encontrada', 404);
  return u;
}

// Approves a pending (or previously rejected) account. The person either joins an existing workspace (workspaceId) or
// gets a workspace of their own (named after the sign-up request unless workspaceName is given).
export async function approveAccount({ userId, approver, workspaceId, workspaceName }) {
  const u = await loadAccount(userId);
  if (![PENDING, REJECTED].includes(u.status)) throw conflict(`Só cadastros aguardando aprovação (ou recusados) podem ser aprovados; esta conta está ${u.status}`, 409);
  let workspace = null;
  if (workspaceId) {
    workspace = await one('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) throw badRequest('Workspace não encontrado', 400);
  }
  const approved = await transaction(async () => {
    let row = await one(
      `UPDATE users SET status = 'ACTIVE', approved_at = now(), approved_by = $2, rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL WHERE id = $1 RETURNING *`,
      [u.id, approver?.id || null],
    );
    if (workspace) {
      await addUserToWorkspace({ workspace, userId: row.id, invitedBy: approver, sendEmail: false, status: 'ACTIVE' });
      await query('UPDATE users SET active_workspace_id = $2, default_workspace_id = COALESCE(default_workspace_id, $2) WHERE id = $1', [row.id, workspace.id]);
    } else {
      const active = row.active_workspace_id && await one("SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2 AND status = 'ACTIVE'", [row.id, row.active_workspace_id]);
      if (!active) {
        const name = String(workspaceName || u.signup?.workspaceName || '').trim() || `${row.name}'s workspace`;
        workspace = await createWorkspace({ name, owner: row, currency: u.signup?.currency || 'USD' });
        await query('UPDATE users SET active_workspace_id = $2, default_workspace_id = $2 WHERE id = $1', [row.id, workspace.id]);
      }
    }
    row = await one('SELECT * FROM users WHERE id = $1', [u.id]);
    return row;
  });
  await sendMail({
    to: approved.email,
    subject: 'Sua conta no Clockfy foi aprovada',
    text: `Olá, ${approved.name}!\n\nSua conta no Clockfy foi aprovada${approver?.name ? ` por ${approver.name}` : ''}. Entre com o seu e-mail e a senha que você cadastrou em: ${config.appUrl}/login`,
  });
  return { account: approved, workspace };
}

export async function rejectAccount({ userId, approver, reason, notifyUser = false }) {
  const u = await loadAccount(userId);
  if (u.status !== PENDING) throw conflict(`Só cadastros aguardando aprovação podem ser recusados; esta conta está ${u.status}`, 409);
  const row = await one(`UPDATE users SET status = 'REJECTED', rejected_at = now(), rejected_by = $2, rejection_reason = $3 WHERE id = $1 RETURNING *`, [u.id, approver?.id || null, reason || null]);
  if (notifyUser) {
    await sendMail({
      to: row.email,
      subject: 'Seu cadastro no Clockfy não foi aprovado',
      text: `Olá, ${row.name}.\n\nO cadastro da sua conta no Clockfy não foi aprovado.${reason ? `\n\nMotivo: ${reason}` : ''}\n\nEm caso de dúvida, fale com o administrador da sua empresa.`,
    });
  }
  return row;
}

// Removes a sign-up that was never approved (frees the e-mail). Approved accounts are never deleted here.
export async function deleteSignup(userId) {
  const u = await loadAccount(userId);
  if (![PENDING, REJECTED].includes(u.status)) throw conflict('Só cadastros que nunca foram aprovados (pendentes ou recusados) podem ser excluídos', 409);
  await transaction(async () => {
    await query('DELETE FROM workspace_members WHERE user_id = $1', [u.id]);
    await query('DELETE FROM roles WHERE user_id = $1', [u.id]);
    await query('DELETE FROM users WHERE id = $1', [u.id]);
  });
}

export async function setSystemAdmin({ userId, value, actor }) {
  const u = await loadAccount(userId);
  if (value) {
    if (u.status !== 'ACTIVE') throw conflict('Só contas ativas podem ser administradoras do sistema', 409);
  } else if (u.is_super_admin) {
    const others = await one("SELECT count(*)::int AS c FROM users WHERE is_super_admin AND status = 'ACTIVE' AND id <> $1", [u.id]);
    if (!others.c) throw conflict('É preciso manter ao menos um administrador do sistema', 409);
  }
  const row = await one('UPDATE users SET is_super_admin = $2 WHERE id = $1 RETURNING *', [u.id, !!value]);
  if (value && actor && actor.id !== u.id) {
    await notify(u.id, { type: 'SYSTEM_ADMIN_GRANTED', title: 'Você agora é administrador do sistema', body: `${actor.name} deu a você acesso à aprovação de contas.`, payload: { link: '/accounts' } });
  }
  return row;
}
