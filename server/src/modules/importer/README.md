# Módulo `importer` – migração do Clockify

Este módulo traz **todo o histórico** de um workspace do Clockify para o Clockfy sem perder dados e **preservando os
identificadores originais** (os ids do Clockify são hex de 24 caracteres, exatamente o formato usado aqui). Assim,
integrações de terceiros continuam funcionando: basta trocar a URL base da API (`https://api.clockify.me/api/v1` →
`https://<seu-servidor>/api/v1`) e a chave de API.

Há duas formas de importar:

| Forma | Quando usar | O que traz |
|-------|-------------|------------|
| **API do Clockify** (`POST /import/clockify` ou CLI) | migração completa / sincronização incremental | usuários, grupos, clientes, projetos, tarefas, etiquetas, campos personalizados, registros de tempo, despesas (com recibos), feriados, políticas/saldos/solicitações de folga, aprovações, agenda (scheduling), faturas e webhooks |
| **CSV** (`POST /import/csv`) | quando não há chave de API ou para trazer apenas registros de tempo | registros de tempo (criando clientes/projetos/tarefas/etiquetas/usuários ausentes) |

## 1. Gerar a chave de API no Clockify

1. Entre no Clockify com um usuário **administrador (ou dono)** do workspace que será migrado – só administradores
   enxergam os dados de todos os membros.
2. Abra **Profile settings** (menu do avatar, canto superior direito) e role até a seção **API**.
3. Clique em **Generate** em *API key* e copie a chave (ela não é exibida novamente).
4. Se a sua conta estiver em um data center regional, anote também a URL regional
   (ex.: `https://euc1.api.clockify.me/api/v1`) para informar em `baseUrl`/`--base-url`.

> A chave nunca é gravada no banco: ela fica apenas em memória durante a execução do job e não aparece nas respostas.

## 2. Executar pela interface / API

Todos os endpoints abaixo exigem um administrador do workspace local e ficam sob
`/api/v1/workspaces/{workspaceId}/import`.

1. **Descobrir os workspaces da chave**
   `POST /import/clockify/workspaces` `{ "apiKey": "...", "baseUrl": "opcional" }` →
   `[{ id, name, imageUrl, memberships, hourlyRate, currencies, apiUser: { id, email, name } }]`
   (também aceito via `GET ...?apiKey=...`). Chave inválida → `400`.
2. **Iniciar a importação**
   `POST /import/clockify`
   ```json
   {
     "apiKey": "chave gerada no Clockify",
     "sourceWorkspaceId": "5f0c…",         // opcional se a chave só acessa um workspace
     "mode": "INTO_CURRENT",                // ou "NEW_WORKSPACE"
     "since": "2010-01-01",                 // opcional – só registros a partir desta data
     "entities": ["users", "projects"],    // opcional – etapas a executar (padrão: todas)
     "dryRun": false,                        // true = apenas conta, não grava
     "baseUrl": "https://api.clockify.me/api/v1",
     "memberProfiles": true,                 // false = não consulta /member-profile (mais rápido)
     "pageSize": 1000,                       // página dos registros de tempo (1..5000)
     "ratePerSecond": 8                      // requisições/s (Clockify permite ~10; só aumente contra um espelho/mock)
   }
   ```
   Resposta `202 { jobId, status }`. A importação roda em segundo plano.
3. **Acompanhar**
   `GET /import/jobs` (lista) e `GET /import/jobs/{jobId}` → `status` (`PENDING | RUNNING | DONE | FAILED | CANCELLED`),
   `progress` (`stage`, `current`, `total`, `counts`, `details`, `userMap`, `stages`, `requests`) e `log` (últimas 500 linhas).
4. **Cancelar** (cooperativo, entre lotes): `POST /import/jobs/{jobId}/cancel`.

Etapas disponíveis em `entities`: `workspace, users, userGroups, clients, projects, tasks, tags, customFields, timeEntries,
expenses, holidays, timeOff, approvals, scheduling, invoices, webhooks` (`GET /api/v1/import/entities`). A falha de uma
etapa é registrada no log e as demais continuam; apenas erro de autenticação aborta o job.

### Modos

- **`INTO_CURRENT`** (padrão): importa para o workspace local em que o endpoint foi chamado, mantendo o id local do
  workspace. Todas as demais entidades preservam os ids do Clockify. Se já existir localmente um cliente/projeto/etiqueta/
  grupo/campo com o mesmo nome (mas outro id), o registro do Clockify é mapeado para ele (o log informa).
- **`NEW_WORKSPACE`**: cria um workspace local com o **mesmo id**, nome, configurações, taxas e moedas do workspace do
  Clockify, tendo como dono o usuário que executa a importação. Se já existir um workspace com esse id pertencente a
  outro usuário, o job falha.

## 3. Executar pela linha de comando

```bash
cd server
# listar workspaces acessíveis pela chave
npm run import:clockify -- --api-key CHAVE --list-workspaces

# importar para um workspace local existente
npm run import:clockify -- --api-key CHAVE --source-workspace 5f0c… --target-workspace 66aa… --owner-email admin@empresa.com

# criar um workspace novo com o mesmo id do Clockify
npm run import:clockify -- --api-key CHAVE --source-workspace 5f0c… --new-workspace --owner-email admin@empresa.com

# opções extras
#   --since 2024-01-01   --entities users,projects,timeEntries   --base-url https://euc1.api.clockify.me/api/v1
#   --dry-run            --page-size 1000                        --no-member-profiles
```

O CLI usa as mesmas funções do serviço (`runClockifyImport`), imprime o log e o progresso no terminal, grava o job em
`import_jobs` e termina com código 0 (`DONE`) ou 1. Variáveis de ambiente: `DATABASE_URL`, `CLOCKIFY_API_KEY`,
`CLOCKIFY_BASE_URL`.

## 4. O que é preservado e como é mapeado

| Clockify | Clockfy | Observações |
|----------|---------|-------------|
| Workspace (`workspaceSettings`, `hourlyRate`, `costRate`, `currencies`) | `workspaces.settings` (mesmas chaves), taxas, `workspace_currencies` | em `INTO_CURRENT` as configurações do Clockify sobrescrevem as locais |
| Usuários (`/users?include-roles=true&status=ALL&memberships=ALL`) | `users`, `workspace_members`, `roles` | relacionados **pelo e-mail**: se já existe conta local (ex.: quem importa) usa-se o id local e o mapeamento fica em `progress.userMap`; caso contrário o usuário é criado com o **mesmo id** do Clockify, status `PENDING_EMAIL_VERIFICATION`, sem senha (entra por “esqueci a senha” ou convite). `membershipStatus` → status do membro; `WORKSPACE_ADMIN`/`TEAM_MANAGER`/`PROJECT_MANAGER` → `roles` |
| Grupos | `user_groups`, `user_group_members`, gerentes de equipe → `roles` | |
| Clientes (arquivados e ativos) | `clients` | moeda mapeada pelo código |
| Projetos (`hydrated=true`, arquivados, templates) | `projects`, `project_members` (com taxas), estimativas de tempo/orçamento, nota, cor, público/privado | |
| Tarefas (`is-active` true/false) | `tasks`, `task_assignees`, `task_user_groups` | |
| Etiquetas | `tags` | |
| Campos personalizados (+ `projectDefaultValues`) | `custom_fields`, `custom_field_project_defaults`, valores de usuário | |
| Registros de tempo (por usuário, janelas de 1 ano, `page-size=1000`) | `time_entries` (`origin='IMPORT'`), `time_entry_tags`, `custom_field_values` | start/end/duração, descrição, projeto/tarefa/etiquetas, faturável, tipo, `isLocked`→`locked`, `kioskId`, taxas (`hourlyRate`/`costRate` do Clockify ou resolvidas pela hierarquia local). Timer em andamento é importado só se não houver timer local rodando |
| Despesas (+ categorias, recibos) | `expenses`, `expense_categories`, `files` | recibos baixados de `/expenses/{id}/files/{fileId}` |
| Feriados | `holidays`, `holiday_users`, `holiday_groups` | |
| Folgas (políticas, saldos, solicitações) | `time_off_policies`, `time_off_balances`, `time_off_requests` | |
| Aprovações (todos os status) | `approval_requests` + `approval_status` nos registros/despesas | |
| Agenda (janelas de 3 meses) | `scheduling_assignments` | |
| Faturas (+ itens, pagamentos) | `invoices`, `invoice_items`, `invoice_payments`; registros marcados como faturados | |
| Webhooks | `webhooks` **desabilitados** | habilite manualmente após validar |

Cada etapa registra uma linha em `audit_log` (`CREATE_TIME_IMPORT` para registros de tempo, `IMPORT_<ETAPA>` para as
demais). **Nenhum evento de domínio é emitido** – nada de webhooks/notificações em massa durante a migração.

A escrita é feita diretamente no banco com `INSERT … ON CONFLICT (id) DO UPDATE`, por lotes em transações; um registro
inválido não descarta o lote (é reprocessado individualmente e o erro vai para o log).

## 5. Reexecução e sincronização incremental

- A importação é **idempotente**: rodar de novo atualiza os registros existentes (mesmo id) e cria só os novos – as
  contagens não duplicam.
- Para trazer apenas o que mudou desde a última execução use `since` (`--since`): registros de tempo, solicitações de
  folga e agenda são buscados a partir dessa data (as demais entidades são pequenas e sempre reconciliadas). No fim de
  cada job o log sugere o `since` a usar na próxima execução (`progress.syncedAt`).
- `dryRun: true` (`--dry-run`) percorre a API e conta o que seria criado/atualizado sem gravar nada.

## 6. Limitações

- Registros excluídos no Clockify depois de uma importação **não** são excluídos localmente.
- Senhas não são migradas (a API do Clockify não as expõe); cada usuário define a sua por “esqueci a senha” ou convite.
- Fotos de perfil ficam apenas como URL (`profilePicture`), não são baixadas.
- Relatórios compartilhados/agendados, alertas, lembretes, quiosques e histórico de taxas não estão na API pública do
  Clockify e não são importados.
- A API do Clockify limita ~10 requisições/s por chave: o cliente usa 8 req/s com retentativas (429/5xx/rede, até 5x,
  respeitando `Retry-After`). Workspaces grandes podem levar dezenas de minutos (≈ 1 requisição por usuário × ano de
  registros, mais 2 por projeto para tarefas). Use `--no-member-profiles` para acelerar.
- Em `INTO_CURRENT`, se um id do Clockify já existir em **outro** workspace local, o registro é ignorado (log).
- Faturas cujo número já exista localmente com outro id não são importadas (restrição de unicidade).

## 7. Importar CSV exportado do Clockify

### Exportar no Clockify

1. **Relatório detalhado**: *Reports → Detailed*, escolha o período (cada exportação traz no máximo o período exibido; para
   todo o histórico exporte ano a ano), filtre se desejar e clique em **Export → CSV**. Os cabeçalhos podem estar em
   inglês (`Project, Client, Description, Task, User, Group, Email, Tags, Billable, Start Date, Start Time, End Date,
   End Time, Duration (h), Duration (decimal), Billable Rate (USD), Billable Amount (USD)`) ou em português
   (`Projeto, Cliente, Descrição, Tarefa, Usuário, Grupo, E-mail, Etiquetas, Faturável, Data de início, Hora de início,
   Data de término, Hora de término, Duração (h), Duração (decimal), Taxa faturável (BRL), Valor faturável (BRL)`).
2. **Template de importação** do Clockify (*Workspace settings → Import*): `Email, Project, Task, Client, Description,
   Tags, Billable, Start date, Start time, End date, End time, Duration`.

### Importar

`POST /api/v1/workspaces/{workspaceId}/import/csv` (multipart/form-data):

| Campo | Descrição |
|-------|-----------|
| `file` | o arquivo CSV (delimitador `,` ou `;` e codificação UTF-8/BOM/UTF-16/Windows-1252 detectados automaticamente) |
| `format` | `AUTO` (padrão), `DETAILED_REPORT` ou `TIMESHEET_TEMPLATE` |
| `timeZone` | fuso das datas/horas do arquivo (padrão: fuso do usuário) |
| `dateFormat` | `DD/MM/YYYY`, `MM/DD/YYYY` ou `YYYY-MM-DD` (padrão: `DD/MM/YYYY` para cabeçalhos em português, `MM/DD/YYYY` em inglês; ISO é reconhecido sempre) |
| `timeFormat` | `12h` ou `24h` (ambos são reconhecidos automaticamente) |
| `createMissing` | `true` (padrão) cria clientes/projetos/tarefas/etiquetas e usuários (pelo e-mail) ausentes |
| `dryRun` | `true` apenas valida e conta |

Regras: `Billable` aceita `Yes/No/Sim/Não/true/false`; sem `End` usa-se `Duration`; registros idênticos já existentes
(mesmo usuário, início, fim, descrição e projeto) são ignorados (dedupe). Resposta:
`{ jobId, created, skipped, errors: [{line, message}], counts: {rows, created, skipped, errors, users, clients, projects, tasks, tags} }`.
O job fica registrado em `import_jobs` com `source = 'CLOCKIFY_CSV'`.

## 8. Testes

`node --test test/importer.test.js` sobe um servidor HTTP local que simula a API do Clockify e valida importação por API
(ids preservados, mapeamento por e-mail, dryRun, reexecução idempotente, modo `NEW_WORKSPACE`) e por CSV (inglês e
português).
