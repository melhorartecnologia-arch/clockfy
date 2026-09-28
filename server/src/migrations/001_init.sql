-- Clockfy: full schema (PostgreSQL 13+)
-- IDs are 24-char hex strings (same format as Clockify ObjectIds) so data imported
-- from Clockify keeps its original identifiers.

CREATE TABLE users (
  id            CHAR(24) PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT,
  name          TEXT NOT NULL,
  profile_picture TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | PENDING_EMAIL_VERIFICATION | DELETED | NOT_REGISTERED
  active_workspace_id  CHAR(24),
  default_workspace_id CHAR(24),
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

CREATE TABLE user_tokens (
  id         CHAR(24) PRIMARY KEY,
  user_id    CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL, -- PASSWORD_RESET | INVITE | EMAIL_VERIFY
  token_hash TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_hash_idx ON user_tokens (token_hash);

CREATE TABLE api_keys (
  id           CHAR(24) PRIMARY KEY,
  user_id      CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'API key',
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id                   CHAR(24) PRIMARY KEY,
  name                 TEXT NOT NULL,
  owner_id             CHAR(24) NOT NULL REFERENCES users(id),
  image_url            TEXT,
  hourly_rate_amount   INTEGER NOT NULL DEFAULT 0,   -- cents
  hourly_rate_currency TEXT NOT NULL DEFAULT 'USD',
  cost_rate_amount     INTEGER NOT NULL DEFAULT 0,   -- cents
  settings             JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_plan         TEXT NOT NULL DEFAULT 'ENTERPRISE',
  subdomain            TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_currencies (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (workspace_id, code)
);

CREATE TABLE workspace_members (
  workspace_id       CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id            CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'ACTIVE', -- PENDING | ACTIVE | INACTIVE | DECLINED
  hourly_rate_amount INTEGER,
  hourly_rate_currency TEXT,
  cost_rate_amount   INTEGER,
  week_start         TEXT,
  working_days       JSONB, -- ["MONDAY",...]
  work_capacity      TEXT,  -- ISO duration, e.g. PT8H
  kiosk_pin          TEXT,
  invited_at         TIMESTAMPTZ,
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE roles (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL, -- OWNER | WORKSPACE_ADMIN | TEAM_MANAGER | PROJECT_MANAGER
  entity_id    CHAR(24),      -- project id (PROJECT_MANAGER), user id or group id (TEAM_MANAGER), workspace id otherwise
  source_type  TEXT,          -- USER_GROUP when granted through a group
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id, role, entity_id)
);
CREATE INDEX roles_ws_user_idx ON roles (workspace_id, user_id);

CREATE TABLE user_groups (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE user_group_members (
  group_id CHAR(24) NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id  CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE clients (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  address      TEXT,
  email        TEXT,
  cc_emails    JSONB NOT NULL DEFAULT '[]'::jsonb,
  note         TEXT,
  currency_id  CHAR(24),
  archived     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clients_ws_idx ON clients (workspace_id, lower(name));

CREATE TABLE projects (
  id                   CHAR(24) PRIMARY KEY,
  workspace_id         CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  client_id            CHAR(24) REFERENCES clients(id) ON DELETE SET NULL,
  color                TEXT NOT NULL DEFAULT '#03A9F4',
  note                 TEXT,
  billable             BOOLEAN NOT NULL DEFAULT false,
  is_public            BOOLEAN NOT NULL DEFAULT true,
  archived             BOOLEAN NOT NULL DEFAULT false,
  is_template          BOOLEAN NOT NULL DEFAULT false,
  hourly_rate_amount   INTEGER,
  hourly_rate_currency TEXT,
  cost_rate_amount     INTEGER,
  -- estimates
  estimate_type        TEXT NOT NULL DEFAULT 'AUTO',  -- AUTO | MANUAL (time estimate)
  time_estimate        JSONB NOT NULL DEFAULT '{"estimate":"PT0S","type":"AUTO","active":false,"includeNonBillable":true,"resetOption":null}'::jsonb,
  budget_estimate      JSONB NOT NULL DEFAULT '{"estimate":0,"type":"AUTO","active":false,"includeExpenses":false,"resetOption":null}'::jsonb,
  estimate_reset       JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_ws_idx ON projects (workspace_id, archived, lower(name));
CREATE INDEX projects_client_idx ON projects (client_id);

CREATE TABLE project_members (
  project_id           CHAR(24) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type          TEXT NOT NULL DEFAULT 'USER', -- USER | USERGROUP
  target_id            CHAR(24) NOT NULL,
  hourly_rate_amount   INTEGER,
  hourly_rate_currency TEXT,
  cost_rate_amount     INTEGER,
  status               TEXT NOT NULL DEFAULT 'ACTIVE',
  is_manager           BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, target_type, target_id)
);
CREATE INDEX project_members_target_idx ON project_members (target_id);

CREATE TABLE project_favorites (
  user_id    CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id CHAR(24) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE tasks (
  id                   CHAR(24) PRIMARY KEY,
  workspace_id         CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id           CHAR(24) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | DONE
  estimate_seconds     BIGINT,
  budget_estimate      BIGINT,
  billable             BOOLEAN,
  hourly_rate_amount   INTEGER,
  hourly_rate_currency TEXT,
  cost_rate_amount     INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_project_idx ON tasks (project_id, status);
CREATE TABLE task_assignees (
  task_id CHAR(24) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);
CREATE TABLE task_user_groups (
  task_id  CHAR(24) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  group_id CHAR(24) NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, group_id)
);

CREATE TABLE tags (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  archived     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tags_ws_idx ON tags (workspace_id, lower(name));

CREATE TABLE custom_fields (
  id                      CHAR(24) PRIMARY KEY,
  workspace_id            CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  type                    TEXT NOT NULL, -- TXT | NUMBER | DROPDOWN_SINGLE | DROPDOWN_MULTIPLE | CHECKBOX | LINK
  entity_type             TEXT NOT NULL DEFAULT 'TIMEENTRY', -- TIMEENTRY | USER
  placeholder             TEXT,
  description             TEXT,
  allowed_values          JSONB NOT NULL DEFAULT '[]'::jsonb,
  workspace_default_value JSONB,
  status                  TEXT NOT NULL DEFAULT 'VISIBLE', -- VISIBLE | INVISIBLE | INACTIVE
  required                BOOLEAN NOT NULL DEFAULT false,
  only_admin_can_edit     BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE custom_field_project_defaults (
  custom_field_id CHAR(24) NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  project_id      CHAR(24) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  value           JSONB,
  status          TEXT NOT NULL DEFAULT 'VISIBLE',
  PRIMARY KEY (custom_field_id, project_id)
);

CREATE TABLE kiosks (
  id               CHAR(24) PRIMARY KEY,
  workspace_id     CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  code             TEXT NOT NULL UNIQUE,
  pin_required     BOOLEAN NOT NULL DEFAULT true,
  session_duration_seconds INTEGER NOT NULL DEFAULT 86400,
  default_project_id CHAR(24),
  user_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  group_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE time_entries (
  id                   CHAR(24) PRIMARY KEY,
  workspace_id         CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id              CHAR(24) NOT NULL REFERENCES users(id),
  project_id           CHAR(24) REFERENCES projects(id) ON DELETE SET NULL,
  task_id              CHAR(24) REFERENCES tasks(id) ON DELETE SET NULL,
  description          TEXT NOT NULL DEFAULT '',
  start_time           TIMESTAMPTZ NOT NULL,
  end_time             TIMESTAMPTZ,              -- NULL while the timer is running
  billable             BOOLEAN NOT NULL DEFAULT false,
  type                 TEXT NOT NULL DEFAULT 'REGULAR', -- REGULAR | BREAK | HOLIDAY | TIME_OFF
  locked               BOOLEAN NOT NULL DEFAULT false,
  invoiced             BOOLEAN NOT NULL DEFAULT false,
  invoice_id           CHAR(24),
  approval_request_id  CHAR(24),
  approval_status      TEXT,                    -- PENDING | APPROVED | REJECTED | WITHDRAWN_SUBMISSION | WITHDRAWN_APPROVAL
  kiosk_id             CHAR(24),
  hourly_rate_amount   INTEGER,                 -- snapshot of billable rate (cents)
  hourly_rate_currency TEXT,
  cost_rate_amount     INTEGER,                 -- snapshot of cost rate (cents)
  time_zone            TEXT,
  origin               TEXT NOT NULL DEFAULT 'MANUAL', -- TIMER | MANUAL | IMPORT | KIOSK | AUTO
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX time_entries_ws_user_start_idx ON time_entries (workspace_id, user_id, start_time DESC) WHERE deleted_at IS NULL;
CREATE INDEX time_entries_ws_start_idx ON time_entries (workspace_id, start_time) WHERE deleted_at IS NULL;
CREATE INDEX time_entries_project_idx ON time_entries (project_id) WHERE deleted_at IS NULL;
CREATE INDEX time_entries_task_idx ON time_entries (task_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX time_entries_running_idx ON time_entries (workspace_id, user_id) WHERE end_time IS NULL AND deleted_at IS NULL;
CREATE INDEX time_entries_approval_idx ON time_entries (approval_request_id);
CREATE INDEX time_entries_invoice_idx ON time_entries (invoice_id);

CREATE TABLE time_entry_tags (
  time_entry_id CHAR(24) NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  tag_id        CHAR(24) NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (time_entry_id, tag_id)
);
CREATE INDEX time_entry_tags_tag_idx ON time_entry_tags (tag_id);

CREATE TABLE custom_field_values (
  entity_type     TEXT NOT NULL,   -- TIMEENTRY | USER
  entity_id       CHAR(24) NOT NULL,
  custom_field_id CHAR(24) NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  workspace_id    CHAR(24) NOT NULL,
  value           JSONB,
  source_type     TEXT NOT NULL DEFAULT 'TIMEENTRY',
  PRIMARY KEY (entity_type, entity_id, custom_field_id)
);
CREATE INDEX custom_field_values_field_idx ON custom_field_values (custom_field_id);

CREATE TABLE favorite_entries (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description  TEXT NOT NULL DEFAULT '',
  project_id   CHAR(24),
  task_id      CHAR(24),
  tag_ids      JSONB NOT NULL DEFAULT '[]'::jsonb,
  billable     BOOLEAN NOT NULL DEFAULT false,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rate_history (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,  -- WORKSPACE | USER | PROJECT | PROJECT_USER | TASK
  entity_id    CHAR(24) NOT NULL,
  user_id      CHAR(24),
  rate_type    TEXT NOT NULL,  -- HOURLY | COST
  amount       INTEGER NOT NULL,
  currency     TEXT,
  since        TIMESTAMPTZ,
  created_by   CHAR(24),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rate_history_entity_idx ON rate_history (workspace_id, entity_type, entity_id, rate_type, since);

-- Approvals ---------------------------------------------------------------
CREATE TABLE approval_requests (
  id              CHAR(24) PRIMARY KEY,
  workspace_id    CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id   CHAR(24) NOT NULL REFERENCES users(id),
  creator_user_id CHAR(24) NOT NULL REFERENCES users(id),
  period          TEXT NOT NULL DEFAULT 'WEEKLY', -- WEEKLY | SEMI_MONTHLY | MONTHLY
  date_start      TIMESTAMPTZ NOT NULL,
  date_end        TIMESTAMPTZ NOT NULL,
  state           TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED | WITHDRAWN_SUBMISSION | WITHDRAWN_APPROVAL
  note            TEXT,
  updated_by      CHAR(24),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX approval_requests_ws_idx ON approval_requests (workspace_id, state, date_start);
CREATE INDEX approval_requests_owner_idx ON approval_requests (owner_user_id, date_start);

-- Time off -------------------------------------------------------------------
CREATE TABLE time_off_policies (
  id                        CHAR(24) PRIMARY KEY,
  workspace_id              CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  color                     TEXT,
  icon                      TEXT,
  time_unit                 TEXT NOT NULL DEFAULT 'DAYS', -- DAYS | HOURS
  allow_half_day            BOOLEAN NOT NULL DEFAULT false,
  allow_negative_balance    BOOLEAN NOT NULL DEFAULT false,
  negative_balance          JSONB, -- {amount, period}
  approve                   JSONB NOT NULL DEFAULT '{"requiresApproval":false,"teamManagers":false,"specificMembers":false,"userIds":[]}'::jsonb,
  automatic_accrual         JSONB, -- {amount, period: MONTH|YEAR, timeUnit}
  automatic_time_entry_creation JSONB, -- {enabled, defaultEntities:{projectId, taskId}}
  everyone_including_new    BOOLEAN NOT NULL DEFAULT false,
  has_expiration            BOOLEAN NOT NULL DEFAULT false,
  archived                  BOOLEAN NOT NULL DEFAULT false,
  last_accrual_at           TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE time_off_policy_users (
  policy_id CHAR(24) NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
  user_id   CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, user_id)
);
CREATE TABLE time_off_policy_groups (
  policy_id CHAR(24) NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
  group_id  CHAR(24) NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, group_id)
);
CREATE TABLE time_off_balances (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_id    CHAR(24) NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
  user_id      CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  used         NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, user_id)
);
CREATE TABLE time_off_balance_history (
  id         CHAR(24) PRIMARY KEY,
  balance_id CHAR(24) NOT NULL REFERENCES time_off_balances(id) ON DELETE CASCADE,
  delta      NUMERIC(12,2) NOT NULL,
  note       TEXT,
  author_id  CHAR(24),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE time_off_requests (
  id                CHAR(24) PRIMARY KEY,
  workspace_id      CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_id         CHAR(24) NOT NULL REFERENCES time_off_policies(id) ON DELETE CASCADE,
  user_id           CHAR(24) NOT NULL REFERENCES users(id),
  requester_user_id CHAR(24) NOT NULL REFERENCES users(id),
  start_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ NOT NULL,
  days              NUMERIC(8,2),
  half_day          BOOLEAN NOT NULL DEFAULT false,
  half_day_period   TEXT,
  time_unit         TEXT NOT NULL DEFAULT 'DAYS',
  balance_diff      NUMERIC(12,2) NOT NULL DEFAULT 0,
  note              TEXT,
  status            TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED | WITHDRAWN
  status_note       TEXT,
  status_changed_by CHAR(24),
  status_changed_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX time_off_requests_ws_idx ON time_off_requests (workspace_id, start_time);
CREATE INDEX time_off_requests_user_idx ON time_off_requests (user_id, start_time);

CREATE TABLE holidays (
  id                     CHAR(24) PRIMARY KEY,
  workspace_id           CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  color                  TEXT,
  start_date             DATE NOT NULL,
  end_date               DATE NOT NULL,
  occurs_annually        BOOLEAN NOT NULL DEFAULT false,
  everyone_including_new BOOLEAN NOT NULL DEFAULT true,
  automatic_time_entry_creation JSONB,
  project_id             CHAR(24),
  task_id                CHAR(24),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE holiday_users (
  holiday_id CHAR(24) NOT NULL REFERENCES holidays(id) ON DELETE CASCADE,
  user_id    CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (holiday_id, user_id)
);
CREATE TABLE holiday_groups (
  holiday_id CHAR(24) NOT NULL REFERENCES holidays(id) ON DELETE CASCADE,
  group_id   CHAR(24) NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (holiday_id, group_id)
);

-- Scheduling -----------------------------------------------------------------
CREATE TABLE scheduling_assignments (
  id                       CHAR(24) PRIMARY KEY,
  workspace_id             CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id               CHAR(24) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id                  CHAR(24) REFERENCES tasks(id) ON DELETE SET NULL,
  user_id                  CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date               DATE NOT NULL,
  end_date                 DATE NOT NULL,
  hours_per_day            NUMERIC(6,2) NOT NULL DEFAULT 8,
  start_time               TEXT, -- HH:mm
  include_non_working_days BOOLEAN NOT NULL DEFAULT false,
  note                     TEXT,
  billable                 BOOLEAN,
  published                BOOLEAN NOT NULL DEFAULT false,
  series_id                CHAR(24),
  recurring_weeks          INTEGER,
  recurring_repeat         BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduling_assignments_ws_idx ON scheduling_assignments (workspace_id, start_date, end_date);
CREATE INDEX scheduling_assignments_user_idx ON scheduling_assignments (user_id, start_date);
CREATE INDEX scheduling_assignments_series_idx ON scheduling_assignments (series_id);

CREATE TABLE scheduling_milestones (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id   CHAR(24) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  date         DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Files (receipts, profile pictures, invoice logos) -----------------------
CREATE TABLE files (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24),
  user_id      CHAR(24),
  name         TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Expenses -------------------------------------------------------------------
CREATE TABLE expense_categories (
  id             CHAR(24) PRIMARY KEY,
  workspace_id   CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  has_unit_price BOOLEAN NOT NULL DEFAULT false,
  unit           TEXT,
  price_in_cents INTEGER NOT NULL DEFAULT 0,
  archived       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE expenses (
  id                  CHAR(24) PRIMARY KEY,
  workspace_id        CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id             CHAR(24) NOT NULL REFERENCES users(id),
  project_id          CHAR(24) REFERENCES projects(id) ON DELETE SET NULL,
  task_id             CHAR(24) REFERENCES tasks(id) ON DELETE SET NULL,
  category_id         CHAR(24) REFERENCES expense_categories(id) ON DELETE SET NULL,
  date                DATE NOT NULL,
  notes               TEXT,
  quantity            NUMERIC(12,3) NOT NULL DEFAULT 1,
  total               NUMERIC(14,2) NOT NULL DEFAULT 0,
  billable            BOOLEAN NOT NULL DEFAULT false,
  file_id             CHAR(24) REFERENCES files(id) ON DELETE SET NULL,
  locked              BOOLEAN NOT NULL DEFAULT false,
  invoiced            BOOLEAN NOT NULL DEFAULT false,
  invoice_id          CHAR(24),
  approval_request_id CHAR(24),
  approval_status     TEXT,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX expenses_ws_idx ON expenses (workspace_id, date) WHERE deleted_at IS NULL;
CREATE INDEX expenses_user_idx ON expenses (user_id, date) WHERE deleted_at IS NULL;

-- Invoices -------------------------------------------------------------------
CREATE TABLE invoice_settings (
  workspace_id  CHAR(24) PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  defaults      JSONB NOT NULL DEFAULT '{}'::jsonb,
  export_fields JSONB NOT NULL DEFAULT '{"itemType":true,"quantity":true,"unitPrice":true,"tax":true,"tax2":true,"rtl":false}'::jsonb,
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb,
  company       JSONB NOT NULL DEFAULT '{}'::jsonb, -- {name, address, logoFileId, email}
  next_number   INTEGER NOT NULL DEFAULT 1,
  item_types    JSONB NOT NULL DEFAULT '["Service","Product","Time","Expense"]'::jsonb
);
CREATE TABLE invoices (
  id                CHAR(24) PRIMARY KEY,
  workspace_id      CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number            TEXT NOT NULL,
  client_id         CHAR(24) REFERENCES clients(id) ON DELETE SET NULL,
  user_id           CHAR(24),
  issued_date       DATE NOT NULL,
  due_date          DATE NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  status            TEXT NOT NULL DEFAULT 'UNSENT', -- UNSENT | SENT | PAID | PARTIALLY_PAID | VOID | OVERDUE
  subject           TEXT,
  note              TEXT,
  bill_from         TEXT,
  client_address    TEXT,
  discount_percent  NUMERIC(8,3) NOT NULL DEFAULT 0,
  tax_percent       NUMERIC(8,3) NOT NULL DEFAULT 0,
  tax2_percent      NUMERIC(8,3) NOT NULL DEFAULT 0,
  tax_type          TEXT NOT NULL DEFAULT 'SIMPLE', -- SIMPLE | COMPOUND | NONE
  calculation_type  TEXT NOT NULL DEFAULT 'NET',
  visible_zero_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  time_view_mode    TEXT,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number)
);
CREATE INDEX invoices_ws_idx ON invoices (workspace_id, issued_date DESC);
CREATE TABLE invoice_items (
  id             CHAR(24) PRIMARY KEY,
  invoice_id     CHAR(24) NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  item_type      TEXT NOT NULL DEFAULT 'Service',
  description    TEXT NOT NULL DEFAULT '',
  quantity       NUMERIC(14,4) NOT NULL DEFAULT 1,
  unit_price     BIGINT NOT NULL DEFAULT 0, -- cents
  apply_taxes    TEXT NOT NULL DEFAULT 'NONE', -- TAX1 | TAX2 | TAX1TAX2 | NONE
  import_type    TEXT NOT NULL DEFAULT 'NOT_IMPORTED', -- NOT_IMPORTED | TIME_ENTRY_IMPORT | EXPENSE_IMPORT
  time_entry_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  expense_ids    JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE invoice_payments (
  id         CHAR(24) PRIMARY KEY,
  invoice_id CHAR(24) NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount     BIGINT NOT NULL, -- cents
  date       DATE NOT NULL,
  note       TEXT,
  author_id  CHAR(24),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhooks -------------------------------------------------------------------
CREATE TABLE webhooks (
  id                  CHAR(24) PRIMARY KEY,
  workspace_id        CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id             CHAR(24) NOT NULL,
  name                TEXT,
  url                 TEXT NOT NULL,
  event               TEXT NOT NULL,
  trigger_source      JSONB NOT NULL DEFAULT '[]'::jsonb,
  trigger_source_type TEXT NOT NULL DEFAULT 'WORKSPACE_ID',
  auth_token          TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  delivery_enabled    BOOLEAN NOT NULL DEFAULT true,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
  id             CHAR(24) PRIMARY KEY,
  webhook_id     CHAR(24) NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_status_id CHAR(24) NOT NULL,
  request_body   TEXT NOT NULL,
  response_body  TEXT,
  status_code    INTEGER,
  attempt        INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TIMESTAMPTZ,
  succeeded      BOOLEAN,
  responded_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (next_attempt_at) WHERE succeeded IS NOT TRUE AND next_attempt_at IS NOT NULL;

-- Reports --------------------------------------------------------------------
CREATE TABLE shared_reports (
  id                     CHAR(24) PRIMARY KEY,
  workspace_id           CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                CHAR(24) NOT NULL,
  name                   TEXT NOT NULL,
  type                   TEXT NOT NULL DEFAULT 'SUMMARY',
  filter                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  fixed_date             BOOLEAN NOT NULL DEFAULT false,
  is_public              BOOLEAN NOT NULL DEFAULT false,
  visible_to_users       JSONB NOT NULL DEFAULT '[]'::jsonb,
  visible_to_user_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE scheduled_reports (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      CHAR(24) NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'SUMMARY',
  filter       JSONB NOT NULL DEFAULT '{}'::jsonb,
  frequency    TEXT NOT NULL DEFAULT 'WEEKLY', -- DAILY | WEEKLY | MONTHLY
  day_of_week  TEXT,
  day_of_month INTEGER,
  hour         INTEGER NOT NULL DEFAULT 8,
  recipients   JSONB NOT NULL DEFAULT '[]'::jsonb,
  export_type  TEXT NOT NULL DEFAULT 'PDF',
  enabled      BOOLEAN NOT NULL DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alerts, reminders, notifications, audit -----------------------------------
CREATE TABLE alerts (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target       TEXT NOT NULL DEFAULT 'PROJECT', -- PROJECT | TASK
  estimate_type TEXT NOT NULL DEFAULT 'TIME',   -- TIME | BUDGET
  percentage   INTEGER NOT NULL DEFAULT 80,
  notify       JSONB NOT NULL DEFAULT '["ADMINS"]'::jsonb, -- ADMINS | PROJECT_MANAGERS | MEMBERS
  project_ids  JSONB NOT NULL DEFAULT '[]'::jsonb, -- empty = all
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE alert_triggers (
  alert_id   CHAR(24) NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  entity_id  CHAR(24) NOT NULL,
  period_key TEXT NOT NULL DEFAULT '',
  fired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, entity_id, period_key)
);
CREATE TABLE reminders (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'TARGET', -- TARGET (min hours) | LIMIT (max hours) | TIMESHEET (submit)
  period       TEXT NOT NULL DEFAULT 'DAY',    -- DAY | WEEK | MONTH
  hours        NUMERIC(6,2) NOT NULL DEFAULT 8,
  days         JSONB NOT NULL DEFAULT '["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"]'::jsonb,
  send_time    TEXT NOT NULL DEFAULT '17:00',
  user_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
  group_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  everyone     BOOLEAN NOT NULL DEFAULT true,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  last_run_key TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24),
  user_id      CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  read         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read, created_at DESC);
CREATE TABLE audit_log (
  id               CHAR(24) PRIMARY KEY,
  workspace_id     CHAR(24) NOT NULL,
  user_id          CHAR(24),
  action           TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  entity_id        CHAR(24),
  content          JSONB,
  previous_content JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_ws_idx ON audit_log (workspace_id, created_at DESC);

CREATE TABLE import_jobs (
  id           CHAR(24) PRIMARY KEY,
  workspace_id CHAR(24) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      CHAR(24) NOT NULL,
  source       TEXT NOT NULL, -- CLOCKIFY_API | CLOCKIFY_CSV
  status       TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | RUNNING | DONE | FAILED
  options      JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress     JSONB NOT NULL DEFAULT '{}'::jsonb,
  log          JSONB NOT NULL DEFAULT '[]'::jsonb,
  error        TEXT,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['users','workspaces','clients','projects','tasks','time_entries','expenses','invoices','scheduling_assignments'] LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
