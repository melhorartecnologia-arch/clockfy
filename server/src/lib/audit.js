import { query } from './db.js';
import { newId } from './ids.js';

export async function audit({ workspaceId, userId, action, entityType, entityId, content, previous }) {
  try {
    await query(
      `INSERT INTO audit_log (id, workspace_id, user_id, action, entity_type, entity_id, content, previous_content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), workspaceId, userId || null, action, entityType, entityId || null, content == null ? null : JSON.stringify(content), previous == null ? null : JSON.stringify(previous)],
    );
  } catch (err) {
    console.error('[audit] failed', err.message);
  }
}
