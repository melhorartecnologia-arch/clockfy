# approvals

Aprovações de timesheet, compatíveis com a API do Clockify (`/api/v1/workspaces/:workspaceId/approval-requests`).

## Endpoints Clockify

| Método | Path | Descrição |
|---|---|---|
| GET | `/approval-requests?status&sort-column&sort-order&page&page-size` | Lista `[ApprovalDetailsDtoV1]`. Admin vê todos; team/project manager vê os usuários que gerencia (`visibleUserIds`); membro vê os próprios. |
| POST | `/approval-requests` `{period?, periodStart}` | Submete o próprio período (`period` default = `workspaceSettings.approvalPeriod`). |
| POST | `/approval-requests/users/:userId` | Submete o período de outro usuário (admin ou team manager do usuário). |
| POST | `/approval-requests/resubmit-entries-for-approval` e `/users/:userId/resubmit-entries-for-approval` | Anexa a um request existente do período os registros/despesas ainda não submetidos, rejeitados ou retirados (reabre o request como PENDING). |
| PATCH | `/approval-requests/:id` `{state, note}` | Transições: PENDING→APPROVED/REJECTED/WITHDRAWN_SUBMISSION; APPROVED→WITHDRAWN_APPROVAL; REJECTED/WITHDRAWN_*→PENDING (resubmissão). |

## Endpoints extras (UI)

| Método | Path | Descrição |
|---|---|---|
| GET | `/approval-requests/:id` | Detalhe (`ApprovalDetailsDtoV1`). |
| GET | `/approval-requests/pending-summary?start&end&users` | Por usuário visível: `trackedTime`, `unsubmittedTime`, `pendingTime`, `approvedTime` (ISO-8601), `status` (`PENDING`/`UNSUBMITTED`/`REJECTED`/`APPROVED`/`NONE`) e os requests que intersectam o período. |
| GET | `/approval-requests?users=&start=&end=` | Filtros adicionais na listagem (donos e intersecção de período). |

## Regras

- Período calculado no fuso do dono: semana começa no `weekStart` do membro; SEMI_MONTHLY = 1–15 e 16–fim; MONTHLY = mês.
- `dateRange.end` é inclusivo (`23:59:59`); no banco `date_end` é exclusivo.
- Não é possível submeter com timer rodando no período nem sem registros/despesas; um request PENDING/APPROVED por período.
- APPROVED → `time_entries`/`expenses` ficam `locked=true`, `approval_status='APPROVED'`. REJECTED mantém `approval_request_id` (para resubmissão). WITHDRAWN_* limpa o vínculo.
- Aprovadores: admins e team managers do dono. O dono só pode `WITHDRAWN_SUBMISSION` e reabrir (`PENDING`).
- Eventos: `approval.created`, `approval.status_updated` (`{workspaceId, actorId, approvalRequestId, userId, state}`). Notificações in-app + e-mail (setting `approval` do usuário).
