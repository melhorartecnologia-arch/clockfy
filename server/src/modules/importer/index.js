// Module "importer": migration of Clockify data (API and CSV) into this application.
//
// Routes (workspace scoped, admin only):
//   POST /api/v1/workspaces/:workspaceId/import/clockify               start an API import (202 {jobId, status})
//   POST|GET /api/v1/workspaces/:workspaceId/import/clockify/workspaces list Clockify workspaces for an API key
//   POST /api/v1/workspaces/:workspaceId/import/csv                    import a Clockify CSV export (multipart "file")
//   GET  /api/v1/workspaces/:workspaceId/import/jobs                   list jobs
//   GET  /api/v1/workspaces/:workspaceId/import/jobs/:id               job status/progress/log
//   POST /api/v1/workspaces/:workspaceId/import/jobs/:id/cancel        cooperative cancel
//   GET  /api/v1/import/entities                                       supported entities/modes/formats
import { Router } from 'express';
import multer from 'multer';
import { parse, z, idSchema, bool } from '../../lib/validate.js';
import { notFound, conflict } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { config } from '../../config.js';
import { ENTITIES, MODES, SOURCE_REGIONS, startClockifyImport, listWorkspacesForKey, listJobs, getJob, jobDto, requestCancel, activeJobsOfWorkspace, recoverInterruptedJobs, assertAllowedSourceUrl } from './service.js';
import { importCsv, CSV_FORMATS } from './csvImporter.js';

export const router = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.max(config.maxUploadBytes, 50 * 1024 * 1024) } });

// Server of the Clockify account: blank/"auto" = detect (global cloud, then the data regions), "global", a data region
// (euc1, use2, euw2, apse2) or, in baseUrl, the address of a subdomain workspace (https://empresa.clockify.me).
const baseUrlSchema = z.string().trim().max(300).optional();
const regionSchema = z.enum(SOURCE_REGIONS).optional();

const startSchema = z.object({
  apiKey: z.string().trim().min(8, 'apiKey is required'),
  sourceWorkspaceId: idSchema.optional(),
  baseUrl: baseUrlSchema,
  reportsUrl: z.string().url().optional(),
  region: regionSchema,
  mode: z.enum(MODES).optional(),
  since: z.string().optional(),
  entities: z.union([z.array(z.string()), z.string()]).optional(),
  dryRun: z.boolean().optional(),
  memberProfiles: z.boolean().optional(),
  reconcile: z.boolean().optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  ratePerSecond: z.number().min(1).max(100).optional(),
});

router.post('/clockify', async (req, res) => {
  req.ctx.requireAdmin();
  const body = parse(startSchema, req.body || {});
  const { apiKey, ...options } = body;
  assertAllowedSourceUrl(options.baseUrl, 'baseUrl');
  assertAllowedSourceUrl(options.reportsUrl, 'reportsUrl');
  const running = await activeJobsOfWorkspace(req.workspace.id);
  if (running.length) throw conflict(`An import is already running in this workspace (job ${running[0]})`, 409);
  const job = await startClockifyImport({ workspace: req.workspace, user: req.user, options, apiKey });
  res.status(202).json({ jobId: job.id, status: job.status, mode: options.mode || 'INTO_CURRENT', dryRun: !!options.dryRun });
});

const keySchema = z.object({ apiKey: z.string().trim().min(8, 'apiKey is required'), baseUrl: baseUrlSchema, region: regionSchema });
async function workspacesForKey(req, res) {
  req.ctx.requireAdmin();
  const src = req.method === 'GET' ? { apiKey: req.query.apiKey || req.get('x-clockify-api-key'), baseUrl: req.query.baseUrl, region: req.query.region } : (req.body || {});
  const body = parse(keySchema, { apiKey: src.apiKey, baseUrl: src.baseUrl || undefined, region: src.region || undefined });
  assertAllowedSourceUrl(body.baseUrl, 'baseUrl');
  const { user, endpoint, workspaces } = await listWorkspacesForKey(body);
  // Plain array (what the UI's picker expects); the key's owner and the API server are attached to each item.
  res.json(workspaces.map((w) => ({ ...w, apiUser: user, apiEndpoint: endpoint })));
}
router.post('/clockify/workspaces', workspacesForKey);
router.get('/clockify/workspaces', workspacesForKey);

router.get('/jobs', async (req, res) => {
  req.ctx.requireAdmin();
  await recoverInterruptedJobs({ workspaceId: req.workspace.id });
  const list = await listJobs(req.workspace.id, { limit: Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50)) });
  res.json(list.map((j) => { const d = jobDto(j); delete d.log; return d; }));
});

router.get('/jobs/:id', async (req, res) => {
  req.ctx.requireAdmin();
  await recoverInterruptedJobs({ workspaceId: req.workspace.id });
  const job = await getJob(req.workspace.id, req.params.id);
  if (!job) throw notFound('Import job not found', 404);
  res.json(jobDto(job));
});

router.post('/jobs/:id/cancel', async (req, res) => {
  req.ctx.requireAdmin();
  const job = await getJob(req.workspace.id, req.params.id);
  if (!job) throw notFound('Import job not found', 404);
  const running = await requestCancel(job.id);
  res.json({ id: job.id, status: job.status, cancelRequested: true, running });
});

router.post('/csv', upload.single('file'), async (req, res) => {
  req.ctx.requireAdmin();
  const b = req.body || {};
  const result = await importCsv({
    workspace: req.workspace, user: req.user, ctx: req.ctx, buffer: req.file?.buffer, fileName: req.file?.originalname,
    options: {
      format: b.format, timeZone: b.timeZone, dateFormat: b.dateFormat, timeFormat: b.timeFormat,
      createMissing: bool(b.createMissing, true), dryRun: bool(b.dryRun, false),
    },
  });
  res.json(result);
});

router.get('/entities', (req, res) => res.json({ entities: ENTITIES, modes: MODES, regions: SOURCE_REGIONS, csvFormats: CSV_FORMATS }));

export default {
  name: 'importer',
  workspace(ws) { ws.use('/import', router); },
  api(api) { api.get('/import/entities', authenticate, (req, res) => res.json({ entities: ENTITIES, modes: MODES, regions: SOURCE_REGIONS, csvFormats: CSV_FORMATS })); },
};
