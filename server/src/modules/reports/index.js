// Module "reports": Clockify Reports API (summary / detailed / weekly / attendance / expenses),
// shared reports, scheduled (e-mailed) reports and the UI dashboard.
import { Router } from 'express';
import { registerJob } from '../../scheduler.js';
import { runReport } from './run.js';
import { isFileExport, sendExport } from './export.js';
import sharedRouter, { publicRouter } from './sharedReports.js';
import scheduledRouter, { runScheduledReports } from './scheduledReports.js';
import dashboardRouter from './dashboard.js';

export const router = Router({ mergeParams: true }); // /workspaces/:workspaceId/reports

async function respond(type, req, res) {
  const out = await runReport(req.ctx, type, req.body, { forExport: isFileExport(req.body?.exportType) });
  if (isFileExport(out.filter.exportType)) return sendExport(res, out.table(), out.filter.exportType, out.filter);
  res.json(out.result);
}

router.post('/summary', (req, res) => respond('SUMMARY', req, res));
router.post('/detailed', (req, res) => respond('DETAILED', req, res));
router.post('/weekly', (req, res) => respond('WEEKLY', req, res));
router.post('/attendance', (req, res) => respond('ATTENDANCE', req, res));
router.post('/expenses/detailed', (req, res) => respond('EXPENSE_DETAILED', req, res));

// Hourly job: e-mails scheduled reports whose time has come (in the author's time zone)
registerJob('scheduled-reports', 60 * 60 * 1000, () => runScheduledReports());

export { runScheduledReports };

export default {
  name: 'reports',
  workspace(ws) {
    ws.use('/reports', router);
    ws.use('/shared-reports', sharedRouter);
    ws.use('/scheduled-reports', scheduledRouter);
    ws.use('/dashboard', dashboardRouter);
  },
  api(api) {
    api.use('/shared-reports', publicRouter);
  },
};
