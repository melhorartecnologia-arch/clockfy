# reports

Clockify Reports API (`/reports/v1/...` and `/api/v1/...`), shared reports, scheduled (e-mailed) reports and the UI dashboard.

## Clockify-compatible endpoints (`/workspaces/:workspaceId`)

| Method | Path | Body → Response |
| --- | --- | --- |
| POST | `/reports/summary` | `SummaryReportFilterV1` → `{totals:[...], groupOne:[...], chart?}` |
| POST | `/reports/detailed` | `DetailedReportFilterV1` → `{timeEntries:[...], timeentries:[...], totals:[...], page, pageSize, count}` |
| POST | `/reports/weekly` | `WeeklyReportFilterV1` → `{totals, totalsByDay, groupOne[{..., days, children[{..., days}]}], usersWithoutTime?}` |
| POST | `/reports/attendance` | `AttendanceReportFilterV1` → `{entities:[AttendanceDto], count, page, pageSize}` |
| POST | `/reports/expenses/detailed` | `ExpenseReportFilterV1` → `{expenses:[...], totals:{expensesCount,totalAmount,totalAmountBillable}}` |
| GET/POST | `/shared-reports` | list (`{count, reports}`) / create (`SharedReportRequestV1` → `SharedReportV1`) |
| GET/PUT/DELETE | `/shared-reports/:id` | read / `UpdateSharedReportRequestV1` / delete |
| GET | `/api/v1/shared-reports/:id` | runs the saved report (public reports need no token). Query: `dateRangeStart`, `dateRangeEnd` (ignored when `fixedDate`), `sortOrder`, `sortColumn`, `exportType`, `page`, `pageSize`. Response = report result + `{id, name, type, filter, fixedDate, workspaceName, workspaceId, reportAuthor}` |

`exportType`: `JSON` (default), `CSV`, `XLSX` (exceljs) or `PDF` (pdfkit) – file exports answer with `Content-Type` and `Content-Disposition: attachment`.

Common filter: `dateRangeStart`/`dateRangeEnd` (local time in `timeZone`, defaults to the user's time zone) or `dateRangeType`,
`users`/`userGroups`/`clients`/`projects`/`tasks`/`tags` (`{ids, contains: CONTAINS|DOES_NOT_CONTAIN|CONTAINS_ONLY, status}`), `billable`, `description`,
`withoutDescription`, `invoicingState`, `approvalState`, `archived`, `customFields[{id, value, isEmpty, numberCondition}]`, `amountShown`/`amounts`, `rounding`
(uses `workspaceSettings.round`), `sortOrder`, `zoomLevel`, `weekStart`, `dateFormat`, `timeFormat`.

Summary groups (`summaryFilter.groups`, up to 3 levels): `PROJECT, CLIENT, USER, TASK, TAG, DATE, WEEK, MONTH, YEAR, USERGROUP, TIMEENTRY, BILLABILITY` or a custom field id.

## Extra routes for the UI

| Method | Path | Description |
| --- | --- | --- |
| GET | `/workspaces/:id/dashboard?start&end&selection=ME\|TEAM&type=PROJECT\|BILLABILITY` | `{totalTime, billableTime, nonBillableTime, earned, byDay, byProject, topActivities, team}` (`team` only for `TEAM`; restricted by `onlyAdminsSeeDashboard`) |
| GET/POST | `/workspaces/:id/scheduled-reports` | list / create `{name, type, filter, frequency: DAILY\|WEEKLY\|MONTHLY, dayOfWeek, dayOfMonth, hour, recipients, exportType: PDF\|CSV\|XLSX, enabled}` |
| GET/PUT/DELETE | `/workspaces/:id/scheduled-reports/:reportId` | read / update / delete (author or admin) |
| POST | `/workspaces/:id/scheduled-reports/:reportId/send` | sends the report by e-mail right away |

The scheduler job `scheduled-reports` runs hourly and e-mails every enabled report once its `hour` (in the author's time zone) and day have come,
marking `last_sent_at`. Without an explicit date range the report covers the previous day/week/month according to `frequency`.

## Decisions

- Money in report results follows Clockify: rates (`hourlyRate`, `costRate`) are integers in cents, amounts (`earnedAmount`, `amount`, `totalAmount`,
  `amounts[].value`) are decimals in currency units. `earned = hours × hourlyRate`, `cost = hours × costRate`, `profit = earned − cost`.
- `BREAK`, `HOLIDAY` and `TIME_OFF` entries are listed (with `type`) but never count as billable time nor produce amounts. Running timers count until now.
- Visibility: admins see everything; other members see the users returned by `visibleUserIds(ctx)` unless `onlyAdminsSeeAllTimeEntries` is `false`
  (then everyone). `onlyAdminsSeePublicProjectsEntries` limits other users' entries to projects the caller is a member of. With `onlyAdminsSeeBillableRates`
  non-admins only get rates/amounts for their own entries.
- Shared and scheduled reports always run with the permissions of their author.
- The detailed report answers with both `timeEntries` (published schema) and `timeentries` (what the live Clockify API returns).
