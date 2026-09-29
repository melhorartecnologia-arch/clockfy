# Clockfy

Clone completo e auto-hospedado do **Clockify** em **Node.js (JavaScript) + PostgreSQL**, com:

- todas as funcionalidades do Clockify: controle de tempo (timer, manual, pausas, agrupamento), planilha de horas,
  calendário, painel, relatórios (resumo, detalhado, semanal, presença, despesas) com exportação CSV/XLSX/PDF,
  relatórios compartilhados e agendados, projetos (tarefas, membros, taxas, estimativas de tempo/orçamento, modelos,
  favoritos), clientes, etiquetas, campos personalizados, equipe (convites, papéis admin/gerente de equipe/gerente de
  projeto, grupos, perfis), aprovações de planilha, folgas (políticas, solicitações, saldos, acúmulo automático),
  feriados, agenda (assignments recorrentes, capacidade, publicação, marcos), despesas (categorias, recibos), faturas
  (itens, importação de horas/despesas, impostos, pagamentos, PDF, envio por e-mail), quiosque com PIN, alertas de
  estimativa, metas e lembretes, webhooks, log de auditoria, notificações, bloqueio e arredondamento de horas,
  taxas hierárquicas (workspace → membro → projeto → membro do projeto → tarefa) com histórico;
- **API REST 100% compatível com a API pública do Clockify** (`/api/v1`, `/reports/v1`, `/pto/v1`, autenticação por
  `X-Api-Key`), para que integrações de terceiros funcionem apenas trocando a URL base;
- **migração de dados do Clockify** (pela API oficial, com a sua chave, ou por CSV exportado) preservando os IDs
  originais de workspace, projetos, tarefas, clientes, etiquetas, usuários e registros de tempo, para não perder o
  histórico.

Documentação da API (OpenAPI 3 + Redoc): `http://localhost:3000/api/docs`.

## Requisitos

- Node.js 20+ (testado com 22)
- PostgreSQL 13+ (testado com 16)

## Instalação em produção (Ubuntu 24.04, sem Docker e sem build)

A interface já vem compilada no repositório (`web/dist`), então o servidor só precisa de Node.js e PostgreSQL.
O instalador faz tudo (Node 22, PostgreSQL 16, banco, usuário de serviço, `.env`, systemd, Nginx, HTTPS, firewall e backup diário):

```bash
sudo apt-get install -y git
git clone https://github.com/melhorartecnologia-arch/clockfy.git /tmp/clockfy-src
sudo DOMAIN=clockfy.suaempresa.com.br LETSENCRYPT_EMAIL=voce@suaempresa.com.br BRANCH=main \
     bash /tmp/clockfy-src/deploy/install-ubuntu.sh
```

Depois, abra `https://clockfy.suaempresa.com.br`, crie a primeira conta (vira administrador) e configure o SMTP em
`/opt/clockfy/server/.env` se quiser e-mails. Atualização: `sudo /opt/clockfy/deploy/update.sh`.
Guia completo passo a passo (EC2, DNS, SES, backups no S3): [docs/Clockfy-Instalacao-Ubuntu-24-AWS.pdf](docs/Clockfy-Instalacao-Ubuntu-24-AWS.pdf).

Passos manuais equivalentes:

```bash
npm ci --omit=dev --workspace=server    # apenas dependências do servidor
cp .env.example server/.env             # configure DATABASE_URL, JWT_SECRET e APP_URL
npm run migrate                         # cria o schema (também roda automaticamente ao subir)
NODE_ENV=production npm start           # http://localhost:3000 – serve a API e a interface de web/dist
```

Arquivos de implantação em `deploy/`: `clockfy.service` (systemd), `nginx-clockfy.conf`, `backup.sh`, `restore.sh`, `update.sh`.

## Desenvolvimento

```bash
npm install                     # instala server/ e web/ (inclui Vite e React)
npm run dev                     # API em :3000 com recarga automática
npm run dev:web                 # Vite em :5173 com proxy para a API
npm run build                   # recompila web/dist (versione o resultado ao alterar a interface)
```

Também é possível usar Docker (`docker compose up -d --build`), mas não é necessário.

Dados de demonstração: `npm run seed` (usuário `admin@clockfy.local` / `admin123`).

Testes (precisam de um PostgreSQL acessível; padrão `postgres://postgres@localhost:5433/postgres`, sobrescreva com
`TEST_PG_ADMIN_URL`): `npm test`.

## Estrutura

Veja [ARCHITECTURE.md](ARCHITECTURE.md). Resumo: `server/` (Express 5, `pg`, migrações SQL, módulos por funcionalidade
em `server/src/modules`) e `web/` (React 19 + Vite, sem dependências de UI externas).

## API para sistemas terceiros

1. Gere uma chave em **Perfil › Chaves de API** (ou `POST /api/v1/auth/api-keys` autenticado com JWT).
2. Envie o header `X-Api-Key: <chave>` em todas as requisições.
3. Troque as URLs base do Clockify pelas do seu servidor:

| Clockify                                  | Clockfy                             |
|-------------------------------------------|-------------------------------------|
| `https://api.clockify.me/api/v1`          | `https://SEU_HOST/api/v1`           |
| `https://reports.api.clockify.me/v1`      | `https://SEU_HOST/reports/v1`       |
| `https://pto.api.clockify.me/v1`          | `https://SEU_HOST/pto/v1`           |

Exemplos:

```bash
curl -H "X-Api-Key: $KEY" https://SEU_HOST/api/v1/user
curl -H "X-Api-Key: $KEY" https://SEU_HOST/api/v1/workspaces/$WS/projects
curl -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"start":"2026-01-05T10:00:00Z","end":"2026-01-05T11:30:00Z","projectId":"...","description":"Trabalho"}' \
  https://SEU_HOST/api/v1/workspaces/$WS/time-entries
curl -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"dateRangeStart":"2026-01-01T00:00:00Z","dateRangeEnd":"2026-01-31T23:59:59Z","summaryFilter":{"groups":["PROJECT","USER"]},"exportType":"JSON"}' \
  https://SEU_HOST/reports/v1/workspaces/$WS/reports/summary
```

Os IDs são strings hexadecimais de 24 caracteres (mesmo formato do Clockify), as durações usam ISO‑8601 (`PT1H30M`),
valores monetários são inteiros em centavos e datas são ISO‑8601 em UTC – exatamente como na API do Clockify.
Webhooks entregam os mesmos eventos (`NEW_TIME_ENTRY`, `TIMER_STOPPED`, `NEW_PROJECT`, …) com os headers
`Clockify-Signature` e `Clockify-Webhook-Event-Type`.

## Migrando do Clockify

Veja o guia completo em [server/src/modules/importer/README.md](server/src/modules/importer/README.md). Em resumo:

1. No Clockify, gere uma chave de API em *Profile settings › API*.
2. No Clockfy, abra **Importar do Clockify**, informe a chave, escolha o workspace de origem, o modo (importar para o
   workspace atual ou criar um novo com o mesmo ID) e execute. O progresso é exibido em tempo real; a importação é
   idempotente e pode ser reexecutada com a opção “desde” para sincronizar registros novos.
3. Alternativa sem chave: exporte o *Relatório detalhado* em CSV no Clockify e importe em **Importar do Clockify › CSV**.

Também há uma CLI: `npm run import:clockify -- --api-key ... --source-workspace ... --owner-email ... --new-workspace`.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/clockfy` | conexão PostgreSQL |
| `JWT_SECRET` | – | segredo dos tokens (obrigatório em produção) |
| `JWT_EXPIRES_IN` | `30d` | validade do token de login |
| `APP_URL` | `http://localhost:3000` | URL pública (links de convite, relatórios compartilhados, quiosque) |
| `SMTP_HOST/PORT/USER/PASS/FROM/SECURE` | – | envio de e-mails (convites, lembretes, relatórios, faturas) |
| `RATE_LIMIT_PER_SECOND` | `50` | limite por usuário/chave |
| `SCHEDULER_ENABLED` | `true` | jobs periódicos (webhooks, lembretes, bloqueio automático, acúmulo de folgas…) |
| `MAX_UPLOAD_BYTES` | `10485760` | tamanho máximo de recibos/imagens |

## Licença

MIT.
