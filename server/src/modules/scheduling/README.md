# scheduling

Agenda (Schedule) compatível com a API do Clockify (`/api/v1/workspaces/:workspaceId/scheduling/...`).

## Endpoints Clockify

- `GET /scheduling/assignments/all?name&start&end&sort-column(PROJECT|USER|ID)&sort-order&page&page-size` → `[AssignmentHydratedDtoV1]` (superconjunto de `AssignmentDtoV1` com dados de projeto/cliente/tarefa/usuário).
- `POST /scheduling/assignments/projects/totals` (`ProjectTotalsRequestV1`) → `[SchedulingProjectsTotalsDtoV1]`; `GET /scheduling/assignments/projects/totals/:projectId?start&end`.
- `POST /scheduling/assignments/user-filter/totals` (`GetUserTotalsRequestV1`) → `[SchedulingUsersTotalsDtoV1]`; `GET /scheduling/assignments/users/:userId/totals?start&end&page&page-size`.
- `PUT /scheduling/assignments/publish` (`PublishAssignmentsRequestV1`) → `{published, assignmentIds, userIds}`; `notifyUsers` envia notificação in-app + e-mail (setting `scheduling`).
- `POST /scheduling/assignments/recurring` (`AssignmentCreateRequestV1`; `recurringAssignment {weeks, repeat}` cria uma assignment por semana com `series_id` comum) → `[AssignmentDtoV1]`.
- `PATCH /scheduling/assignments/recurring/:assignmentId` (`seriesUpdateOption THIS_ONE|THIS_AND_FOLLOWING|ALL`; datas das demais da série são deslocadas pelo mesmo delta), `DELETE /scheduling/assignments/recurring/:assignmentId?seriesUpdateOption`, `PUT /scheduling/assignments/series/:assignmentId {weeks, repeat}` (redimensiona a série), `POST /scheduling/assignments/:assignmentId/copy {userId, seriesUpdateOption}`.

## Endpoints extras (UI)

- `POST /scheduling/assignments` (assignment simples), `GET/PUT/PATCH/DELETE /scheduling/assignments/:id`.
- Milestones: `GET /scheduling/milestones?project-id&start&end`, `POST {projectId, name, date}`, `PUT/DELETE /scheduling/milestones/:id` → `{id, name, date, projectId, workspaceId}`.
- `GET /scheduling/assignments/all` aceita também `users`, `project` e `published`.

## Regras

- Datas de entrada aceitam `YYYY-MM-DD` ou date-time (é usada a data informada); `period.start/end` saem como `YYYY-MM-DDT00:00:00Z`.
- Capacidade: `work_capacity` do membro ou `workspaceSettings.workCapacity`; dias úteis: `working_days` do membro ou `workspaceSettings.workingDays`.
- `excludeDays`: `TIME_OFF` (folga aprovada), `HOLIDAY` (`holidaysForUser`) e `WEEKEND` (dia não útil, salvo `includeNonWorkingDays`). Totais só contam dias não excluídos.
- Permissões: admins e project managers do projeto escrevem/publicam; membros veem apenas assignments publicadas próprias (team managers também as publicadas das equipes; PMs veem tudo dos seus projetos).
- Eventos: `assignment.created|updated|deleted|published`, `milestone.created|updated|deleted`.
