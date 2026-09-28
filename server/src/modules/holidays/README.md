# holidays

Feriados do workspace, compatíveis com a API do Clockify (`/api/v1/workspaces/:workspaceId/holidays`).

- `GET /holidays?assigned-to=<userId>` → `[HolidayDtoV1]` (com `assigned-to`, só os que se aplicam ao usuário: `everyoneIncludingNew`, `userIds` ou grupos).
- `POST /holidays` (admin) `CreateHolidayRequestV1` (`users`/`userGroups` no formato `{ids, contains: CONTAINS|DOES_NOT_CONTAIN, status}`; `automaticTimeEntryCreation {enabled, defaultEntities{projectId, taskId}}`).
- `GET /holidays/in-period?assigned-to&start&end` → feriados anuais expandidos para cada ano do período (`assigned-to` opcional aqui).
- `PUT /holidays/:holidayId`, `DELETE /holidays/:holidayId` (admin) → `HolidayDtoV1`. Extra: `GET /holidays/:holidayId`.
- `HolidayDtoV1.automaticTimeEntryCreation` é booleano (como no Clockify); `projectId`/`taskId`/`color` vêm separados.

Job `holiday-time-entries` (diário): para feriados com criação automática ativa cria `time_entries` `type='HOLIDAY'` (origin `AUTO`) nos dias úteis do feriado (janela −7/+31 dias) para os usuários elegíveis; idempotente via `holiday_time_entries`. Também roda ao criar/editar um feriado com a opção ativa. `runHolidayEntries({now, workspaceId})` é exportado para testes.

`service.js` expõe helpers usados por `timeOff` e `scheduling`: `holidaysForUser(workspaceId, userId, startDate, endDate)`, `holidayDatesForUser`, `memberCalendar` (fuso, `weekStart`, dias úteis, capacidade), `workingDates`, `resolveUserFilter`/`resolveGroupFilter`, `notifyWithMail`, `adminContext`/`elevate` e `createAutoEntry`.
