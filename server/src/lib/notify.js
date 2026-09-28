import { query } from './db.js';
import { newId } from './ids.js';

export async function notify(userIds, { workspaceId, type, title, body, payload }) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  for (const uid of ids) {
    await query(
      'INSERT INTO notifications (id, workspace_id, user_id, type, title, body, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [newId(), workspaceId || null, uid, type, title, body || null, JSON.stringify(payload || {})],
    );
  }
}
