// Module "accounts": approval of accounts created through the public sign-up page (system administrators only).
//
//   GET    /api/v1/admin/accounts?status=PENDING_APPROVAL|REJECTED|ACTIVE|ALL&q=&page=&page-size=
//   GET    /api/v1/admin/accounts/summary              { pending, rejected, systemAdmins, registrationApproval }
//   POST   /api/v1/admin/accounts/:id/approve          { workspaceId? | workspaceName? }
//   POST   /api/v1/admin/accounts/:id/reject           { reason?, notify? }
//   DELETE /api/v1/admin/accounts/:id                  (only sign-ups never approved)
//   PUT    /api/v1/admin/accounts/:id/system-admin     { systemAdmin: boolean }
//   GET    /api/v1/admin/workspaces                    workspaces an approved account can be added to
import { Router } from 'express';
import { rows } from '../../lib/db.js';
import { forbidden } from '../../lib/errors.js';
import { parse, z, idSchema } from '../../lib/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { ACCOUNT_STATUSES, accountDto, accountSummary, approveAccount, deleteSignup, listAccounts, rejectAccount, setSystemAdmin } from './service.js';

export const router = Router();

router.use(authenticate, (req, res, next) => (req.user.is_super_admin ? next() : next(forbidden('Somente administradores do sistema podem gerenciar contas', 403))));

router.get('/accounts', async (req, res) => {
  const status = String(req.query.status || 'PENDING_APPROVAL').toUpperCase();
  const size = Math.min(200, Math.max(1, parseInt(req.query['page-size'], 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = await listAccounts({ status: status === 'ALL' || ACCOUNT_STATUSES.includes(status) ? status : 'PENDING_APPROVAL', q: req.query.q, limit: size, offset: (page - 1) * size });
  res.set('Last-Page', String(page * size >= result.total));
  res.json(result);
});

router.get('/accounts/summary', async (req, res) => res.json(await accountSummary()));

router.post('/accounts/:id/approve', async (req, res) => {
  const body = parse(z.object({ workspaceId: idSchema.optional(), workspaceName: z.string().trim().max(250).optional() }), req.body || {});
  const { account, workspace } = await approveAccount({ userId: req.params.id, approver: req.user, ...body });
  res.json({ ...accountDto(account), workspace: workspace ? { id: workspace.id, name: workspace.name } : null });
});

router.post('/accounts/:id/reject', async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().max(1000).optional(), notify: z.boolean().optional() }), req.body || {});
  const account = await rejectAccount({ userId: req.params.id, approver: req.user, reason: body.reason, notifyUser: !!body.notify });
  res.json(accountDto(account));
});

router.delete('/accounts/:id', async (req, res) => {
  await deleteSignup(req.params.id);
  res.status(204).end();
});

router.put('/accounts/:id/system-admin', async (req, res) => {
  const { systemAdmin } = parse(z.object({ systemAdmin: z.boolean() }), req.body || {});
  res.json(accountDto(await setSystemAdmin({ userId: req.params.id, value: systemAdmin, actor: req.user })));
});

router.get('/workspaces', async (req, res) => {
  const list = await rows(`SELECT w.id, w.name, u.name AS owner_name, (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id AND m.status = 'ACTIVE') AS members
                             FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id ORDER BY lower(w.name)`);
  res.json(list.map((w) => ({ id: w.id, name: w.name, ownerName: w.owner_name, members: w.members })));
});

export default {
  name: 'accounts',
  api(api) { api.use('/admin', router); },
};
