import { one, rows, query, insert, transaction } from '../../lib/db.js';
import { newId, randomToken } from '../../lib/ids.js';
import { DEFAULT_WORKSPACE_SETTINGS } from '../../lib/settings.js';
import { workspaceDto } from '../../lib/dto.js';
import { sha256 } from '../../lib/auth.js';
import { sendMail } from '../../lib/mailer.js';
import { config } from '../../config.js';
import { events } from '../../lib/events.js';
import { badRequest } from '../../lib/errors.js';

export async function createWorkspace({ name, owner, id, settings, currency = 'USD' }) {
  return transaction(async () => {
    const wsId = id || newId();
    const ws = await insert('workspaces', {
      id: wsId, name, owner_id: owner.id, hourly_rate_currency: currency,
      settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...(settings || {}) },
    });
    await insert('workspace_currencies', { id: newId(), workspace_id: wsId, code: currency, is_default: true });
    await query('INSERT INTO workspace_members (workspace_id, user_id, status) VALUES ($1,$2,$3)', [wsId, owner.id, 'ACTIVE']);
    await query('INSERT INTO roles (id, workspace_id, user_id, role, entity_id) VALUES ($1,$2,$3,$4,$5)', [newId(), wsId, owner.id, 'OWNER', wsId]);
    await query('INSERT INTO roles (id, workspace_id, user_id, role, entity_id) VALUES ($1,$2,$3,$4,$5)', [newId(), wsId, owner.id, 'WORKSPACE_ADMIN', wsId]);
    await query('INSERT INTO invoice_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [wsId]);
    return ws;
  });
}

export async function getWorkspaceDto(id) {
  const ws = await one('SELECT * FROM workspaces WHERE id = $1', [id]);
  if (!ws) return null;
  const memberships = await rows("SELECT * FROM workspace_members WHERE workspace_id = $1 AND status <> 'DECLINED'", [id]);
  const currencies = await rows('SELECT * FROM workspace_currencies WHERE workspace_id = $1 ORDER BY is_default DESC, code', [id]);
  return workspaceDto(ws, { memberships, currencies });
}

// Adds (invites) a user by email to the workspace. Creates a placeholder account if needed.
export async function addUserToWorkspace({ workspace, email, invitedBy, sendEmail = true, name, status, userId }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!userId && !normalized) throw badRequest('email is required', 400);
  return transaction(async () => {
    let user = userId
      ? await one('SELECT * FROM users WHERE id = $1', [userId])
      : await one('SELECT * FROM users WHERE lower(email) = $1', [normalized]);
    let created = false;
    if (!user) {
      user = await insert('users', { id: userId || newId(), email: normalized, name: name || normalized.split('@')[0], status: 'PENDING_EMAIL_VERIFICATION', settings: {} });
      created = true;
    }
    const existing = await one('SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspace.id, user.id]);
    const memberStatus = status || (user.password_hash ? 'ACTIVE' : 'PENDING');
    if (existing) {
      if (existing.status === 'INACTIVE' || existing.status === 'DECLINED') {
        await query('UPDATE workspace_members SET status = $3 WHERE workspace_id = $1 AND user_id = $2', [workspace.id, user.id, memberStatus]);
      }
    } else {
      await query('INSERT INTO workspace_members (workspace_id, user_id, status, invited_at) VALUES ($1,$2,$3,now())', [workspace.id, user.id, memberStatus]);
    }
    if (!user.active_workspace_id) {
      await query('UPDATE users SET active_workspace_id = $2, default_workspace_id = COALESCE(default_workspace_id, $2) WHERE id = $1', [user.id, workspace.id]);
    }
    let inviteLink = null;
    if (!user.password_hash) {
      const raw = randomToken();
      await insert('user_tokens', { id: newId(), user_id: user.id, type: 'INVITE', token_hash: sha256(raw), meta: { workspaceId: workspace.id, invitedBy: invitedBy?.id }, expires_at: new Date(Date.now() + 30 * 86400e3) });
      inviteLink = `${config.appUrl}/invite?token=${raw}`;
      if (sendEmail) {
        await sendMail({ to: user.email, subject: `Você foi convidado para o workspace ${workspace.name}`, text: `${invitedBy?.name || 'Alguém'} convidou você para o workspace "${workspace.name}" no Clockfy. Acesse: ${inviteLink}` });
      }
    } else if (sendEmail && !existing) {
      await sendMail({ to: user.email, subject: `Você foi adicionado ao workspace ${workspace.name}`, text: `${invitedBy?.name || 'Alguém'} adicionou você ao workspace "${workspace.name}". Acesse ${config.appUrl}` });
    }
    events.emitAsync('user.joined_workspace', { workspaceId: workspace.id, userId: user.id, actorId: invitedBy?.id, created });
    return { user, inviteLink, created };
  });
}
