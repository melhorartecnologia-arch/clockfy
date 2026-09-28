# timeOff

Políticas de folga, requests e saldos, compatíveis com a API do Clockify (`/api/v1/workspaces/:workspaceId/time-off/...`, também servido em `/pto/v1`).

## Endpoints Clockify

- Policies: `GET /time-off/policies?page&page-size&name&status(ACTIVE|ARCHIVED|ALL)&sort-column&sort-order`, `POST`, `GET/PUT/PATCH({status})/DELETE /time-off/policies/:id` → `PolicyDtoV1` (escrita: admin). `userIds` são os efetivos (`everyoneIncludingNew` = todos os membros ativos).
- Requests: `POST /time-off/policies/:policyId/requests` (próprio), `POST /time-off/policies/:policyId/users/:userId/requests` (admin/team manager), `PATCH .../requests/:requestId {status: APPROVED|REJECTED, note}`, `DELETE .../requests/:requestId` (dono retira → `WITHDRAWN`; admin apaga), `POST /time-off/requests` (`{start,end,statuses,users,userGroups,page,pageSize}` → `{count, requests}`).
- Balances: `GET /time-off/balance/policy/:policyId?page&page-size&sort(USER|POLICY|USED|BALANCE|TOTAL)&sort-order`, `GET /time-off/balance/user/:userId`, `PATCH /time-off/balance/policy/:policyId {userIds, value, note}` (admin, soma `value` ao `total`, grava `time_off_balance_history`) → 204.

## Endpoints extras (UI)

- `GET /time-off/requests/:requestId` → `TimeOffRequestFullV1Dto`.
- `PUT /time-off/policies/:policyId/requests/:requestId {timeOffPeriod?, note?}` edita um request PENDING (dono/admin) e emite `time_off.updated`.
- `POST /time-off/requests` também aceita `policies: [id]`.

## Regras

- `balanceDiff` = dias úteis do membro (`workingDays` do membro ou do workspace, feriados do usuário excluídos); meio dia = 0.5 (`allowHalfDay`); em políticas `HOURS` multiplica pela capacidade diária (`workCapacity`, default `PT8H`).
- Saldo validado na criação e na aprovação: negativo só com `allowNegativeBalance`, até `negativeBalance.amount` quando definido.
- `approve.requiresApproval=false` → request nasce APPROVED. Aprovadores: admins, team managers do usuário (`approve.teamManagers`) e `approve.userIds` (`approve.specificMembers`).
- Aprovar: `used += balanceDiff`; com `automaticTimeEntryCreation.enabled` cria `time_entries` `type='TIME_OFF'` (origin `AUTO`, início no `myStartOfDay` do usuário, duração = capacidade; vínculo em `time_off_request_entries`). Rejeitar/retirar/apagar devolve o saldo e remove (soft delete) os registros.
- Requests do mesmo usuário não podem se sobrepor (PENDING/APPROVED).
- Job `time-off-accrual` (hora em hora): credita `automaticAccrual.amount` uma vez por `MONTH`/`YEAR` (controle por `last_accrual_at`, definido na criação da política). `runAccrual({now})` é exportado para testes.
- Eventos: `time_off.requested|approved|rejected|withdrawn|updated`, `balance.updated`, `time_off_policy.created|updated|deleted`. Notificações in-app + e-mail (setting `pto`).
