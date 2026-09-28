import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { registerRoutes } from './routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(cors({ origin: true, credentials: true, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
  registerRoutes(app);

  // Serve the built SPA (web/dist) if present
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api|\/reports|\/pto|\/health).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
