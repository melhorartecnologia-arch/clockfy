-- Webhooks / alerts / kiosk: supporting tables and indexes
-- (001_init.sql already contains webhooks, webhook_deliveries, alerts, alert_triggers, reminders, notifications, audit_log, kiosks)

-- One row per (reminder, user, local day) so reminders fire only once per day per user
CREATE TABLE IF NOT EXISTS reminder_runs (
  run_key     TEXT PRIMARY KEY,           -- "<reminderId>:<userId>:<YYYY-MM-DD>"
  reminder_id CHAR(24) NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  user_id     CHAR(24) NOT NULL,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminder_runs_reminder_idx ON reminder_runs (reminder_id);

-- Kiosk sessions (PIN login); the JWT carries the session id so logout can revoke it
CREATE TABLE IF NOT EXISTS kiosk_sessions (
  id           CHAR(24) PRIMARY KEY,
  kiosk_id     CHAR(24) NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kiosk_sessions_user_idx ON kiosk_sessions (kiosk_id, user_id);

CREATE INDEX IF NOT EXISTS webhook_deliveries_retry_idx ON webhook_deliveries (next_attempt_at) WHERE next_attempt_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhooks_workspace_event_idx ON webhooks (workspace_id, event);
CREATE INDEX IF NOT EXISTS audit_log_workspace_idx ON audit_log (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
