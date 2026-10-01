-- Accounts created through the public sign-up page wait (status PENDING_APPROVAL) until a system administrator
-- (users.is_super_admin) approves them; REJECTED accounts cannot sign in.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup JSONB,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by CHAR(24),
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by CHAR(24),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);
