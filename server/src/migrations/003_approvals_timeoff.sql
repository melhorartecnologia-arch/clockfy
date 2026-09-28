-- Approvals / time off / holidays / scheduling support tables.
-- Links between time off requests (or holidays) and the time entries created automatically for them,
-- so they can be removed when a request is rejected/withdrawn and never duplicated by the holiday job.

CREATE TABLE time_off_request_entries (
  request_id    CHAR(24) NOT NULL REFERENCES time_off_requests(id) ON DELETE CASCADE,
  time_entry_id CHAR(24) NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, time_entry_id)
);
CREATE INDEX time_off_request_entries_entry_idx ON time_off_request_entries (time_entry_id);

CREATE TABLE holiday_time_entries (
  holiday_id    CHAR(24) NOT NULL REFERENCES holidays(id) ON DELETE CASCADE,
  user_id       CHAR(24) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  time_entry_id CHAR(24) NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (holiday_id, user_id, date)
);
CREATE INDEX holiday_time_entries_entry_idx ON holiday_time_entries (time_entry_id);

CREATE INDEX time_off_requests_status_idx ON time_off_requests (workspace_id, status, start_time);
CREATE INDEX time_off_balances_user_idx ON time_off_balances (user_id);
CREATE INDEX scheduling_milestones_project_idx ON scheduling_milestones (project_id, date);
