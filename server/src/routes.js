import { Router } from 'express';
import { authenticate } from './middleware/auth.js';
import { loadWorkspace } from './middleware/workspace.js';
import authRouter from './modules/auth/index.js';
import usersRouter from './modules/users/index.js';
import workspacesRouter from './modules/workspaces/index.js';
import clientsRouter from './modules/clients/index.js';
import tagsRouter from './modules/tags/index.js';
import projectsRouter from './modules/projects/index.js';
import tasksRouter from './modules/tasks/index.js';
import customFieldsRouter, { projectRouter as projectCustomFieldsRouter } from './modules/customFields/index.js';
import userGroupsRouter from './modules/userGroups/index.js';
import timeEntriesRouter, { userRouter as userTimeEntriesRouter } from './modules/timeEntries/index.js';
import { extraModules } from './modules/index.js';

export function registerRoutes(app) {
  const api = Router();
  api.use('/auth', authRouter);
  // Public / self-authenticating module routes (shared reports, kiosk...) come before the globally authenticated routers
  for (const m of extraModules) if (m.api) m.api(api);
  api.use('/', usersRouter);          // /user, /workspaces/:workspaceId/users, /file/image, /files/:id
  api.use('/workspaces', workspacesRouter);

  // Workspace-scoped resources
  const ws = Router({ mergeParams: true });
  ws.use(authenticate, loadWorkspace);
  ws.use('/clients', clientsRouter);
  ws.use('/tags', tagsRouter);
  ws.use('/projects/:projectId/tasks', tasksRouter);
  ws.use('/projects/:projectId/custom-fields', projectCustomFieldsRouter);
  ws.use('/projects', projectsRouter);
  ws.use('/custom-fields', customFieldsRouter);
  ws.use('/user-groups', userGroupsRouter);
  ws.use('/time-entries', timeEntriesRouter);
  ws.use('/user/:userId/time-entries', userTimeEntriesRouter);
  for (const m of extraModules) if (m.workspace) m.workspace(ws);
  api.use('/workspaces/:workspaceId', ws);

  app.use('/api/v1', api);
  // Clockify uses separate hosts for reports/PTO APIs; we expose the same routes under these prefixes
  app.use('/reports/v1', api);
  app.use('/pto/v1', api);
  app.use('/api', api);
}
