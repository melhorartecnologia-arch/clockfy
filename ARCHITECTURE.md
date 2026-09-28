# Clockfy – Arquitetura e convenções

Clone do Clockify em **Node.js (JavaScript, ESM) + Express 5 + PostgreSQL**. A API pública espelha a API oficial do Clockify
(`/api/v1/...`, `/reports/v1/...`, `/pto/v1/...`) para que integrações de terceiros funcionem apenas trocando a URL base.

```
server/
  src/
    config.js            # variáveis de ambiente
    app.js               # createApp() – express, rotas, SPA estática
    index.js             # entrypoint (migra o banco, sobe HTTP, inicia scheduler)
    routes.js            # registra rotas core + módulos extras (src/modules/index.js)
    scheduler.js         # registerJob(name, intervalMs, fn) – jobs periódicos em processo
    subscribers.js       # imports com efeito colateral (assinantes de eventos de domínio)
    lib/
      db.js              # pool pg: query/rows/one/value/insert/update/transaction (AsyncLocalStorage)
      ids.js             # newId() → ids hex de 24 chars (formato ObjectId, compatível com Clockify)
      errors.js          # HttpError, badRequest/unauthorized/forbidden/notFound/conflict
      validate.js        # zod + parse(schema, data) + helpers bool/int/list/paging/sort
      dto.js             # mapeadores row → DTO no formato do Clockify (userDto, projectDto, timeEntryDto...)
      duration.js        # ISO-8601 (PT1H30M) ↔ segundos, formatação, arredondamento
      dates.js           # fusos horários via Intl, semana/mês, dateRangeType
      rates.js           # resolveRates() hierarquia de taxas; reapplyRates(); recordRateHistory()
      events.js          # events.emitAsync('time_entry.created', {...}) – barramento de eventos de domínio
      audit.js           # audit({workspaceId,userId,action,entityType,entityId,content,previous})
      notify.js          # notify(userIds, {workspaceId,type,title,body,payload}) – notificações in-app
      mailer.js          # sendMail() (SMTP opcional; sem SMTP loga no console e guarda em outbox[])
      settings.js        # defaults de workspaceSettings / user settings
    middleware/
      auth.js            # authenticate (JWT Bearer ou X-Api-Key), rate limit
      workspace.js       # loadWorkspace → req.workspace, req.ctx (permissões), visibleUserIds(ctx), userGroupIds()
      errors.js
    migrations/*.sql     # aplicadas em ordem alfabética (001_init.sql = schema completo)
    modules/<nome>/      # um diretório por módulo (index.js exporta router(s) e/ou o objeto de módulo)
  test/                  # node:test; helpers.js cria um banco por arquivo de teste
web/                     # SPA React (Vite) – build vai para web/dist e é servida pelo Express
```

## Módulos

Módulos core (montados em `routes.js`): auth, users, workspaces, clients, tags, projects, tasks, customFields,
userGroups, timeEntries.

Módulos de feature (registrados em `src/modules/index.js`) exportam **default**:

```js
export default {
  name: 'expenses',
  workspace(router) { router.use('/expenses', expensesRouter); },   // prefixo /api/v1/workspaces/:workspaceId
  api(router) { router.use('/shared-reports', publicRouter); },     // prefixo /api/v1 (e /reports/v1, /pto/v1)
};
```

Dentro de `workspace(router)` já existem `req.user`, `req.workspace`, `req.ctx` (ver abaixo). Rotas em `api(router)` precisam
aplicar `authenticate` (e `loadWorkspace` se tiverem `:workspaceId`) explicitamente.

## req.ctx (middleware/workspace.js)

- `ctx.isAdmin`, `ctx.isOwner`, `ctx.managedProjects: Set<projectId>`, `ctx.managedTargets: Set<userId|groupId>` (team manager)
- `ctx.requireAdmin()`, `ctx.requireProjectManager(projectId)`, `ctx.requireManager()`, `ctx.managesProject(id)`,
  `ctx.managesUser(userId, groupIds)`, `ctx.canCreate('project'|'client'|'tag'|'task')`
- `ctx.settings` = workspaceSettings mesclado com defaults; `ctx.user` = row de users; `ctx.member` = row de workspace_members
- `visibleUserIds(ctx)` → `null` (todos) para admins ou lista de ids de usuários que o chamador gerencia.
- Em módulos, para checar quem pode editar registros de tempo de outro usuário use `canManageEntriesOf(ctx, userId, projectId)`
  (`modules/timeEntries/service.js`).

## Convenções

- IDs: `newId()`; aceitar `id` no body em POST quando válido (24 hex) para permitir importação preservando ids do Clockify.
- Dinheiro: inteiros em **centavos** (`amount`), moeda ISO em `currency`. Durações na API: ISO-8601 (`PT1H30M`).
- Datas: `TIMESTAMPTZ`; DTOs usam `toIso()` (ex.: `2026-01-05T10:00:00Z`). Datas sem hora usam `YYYY-MM-DD`.
- Erros: lançar `badRequest('msg')`, `forbidden()`, `notFound()`; o handler devolve `{message, code}` como o Clockify.
- Listas JSONB: passe arrays/objetos JS ao `insert()`/`update()` (são serializados). Em SQL manual use `JSON.stringify`.
- Paginação: `paging(req.query)` lê `page`/`page-size` (ou `pageSize`); ordenação `sort(req.query, [...cols])`.
- Eventos de domínio (`events.emitAsync(nome, payload)`): `time_entry.created|updated|deleted|restored|split`, `timer.started|stopped`,
  `project.created|updated|deleted`, `task.*`, `client.*`, `tag.*`, `user.joined_workspace|activated|deactivated|removed|updated|email_changed`,
  `user_group.*`, `rate.updated`. Novos módulos emitem: `approval.created|status_updated`, `time_off.requested|updated|approved|rejected|withdrawn|started`,
  `balance.updated`, `assignment.created|updated|deleted|published`, `expense.created|updated|deleted|restored`, `invoice.created|updated`.
  Payload sempre inclui `workspaceId`, `actorId` e o id da entidade (`entryId`, `projectId`, `expenseId`...).
- Auditoria: `audit({...})` nas operações de escrita relevantes (ações no padrão Clockify: CREATE_TIME_PERSONAL_MANUAL, UPDATE_PROJECT...).
- Todas as rotas devem ser compatíveis com a API pública do Clockify (paths, query params, formato JSON). Rotas extras para a UI
  são permitidas (documente-as no README do módulo).
- Testes: `node --test test/` – use `setupTestApp('<nome>')` de `test/helpers.js` (cria banco `clockfy_test_<nome>` no Postgres
  de teste `TEST_PG_ADMIN_URL`, padrão `postgres://postgres@localhost:5433/postgres`).
- Não instale dependências novas sem necessidade. Já disponíveis: express, pg, zod, jsonwebtoken, multer, exceljs, pdfkit,
  nodemailer, cors, csv-parse, dotenv.

## Frontend (web/)

React 19 + Vite + react-router. Cliente HTTP em `web/src/api.js`; estado global (usuário, workspace) em `web/src/store.jsx`.
Strings da interface em português (pt-BR).
