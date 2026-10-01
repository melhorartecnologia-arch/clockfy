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
  // X-Forwarded-For only from a reverse proxy on this host or a private network (Nginx, Docker); a client reaching the
  // app directly cannot forge its address (used in sign-up throttling and records)
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(cors({ origin: true, credentials: true, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // API documentation (OpenAPI 3 + Redoc)
  const docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
  app.get(['/api/docs/openapi.json', '/api/openapi.json'], (req, res) => res.sendFile(path.join(docsDir, 'openapi.json')));
  app.get('/api/docs', (req, res) => {
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Clockfy API</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}</style></head>
<body><redoc spec-url="/api/docs/openapi.json"></redoc><script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
<noscript><a href="/api/docs/openapi.json">openapi.json</a></noscript></body></html>`);
  });

  registerRoutes(app);

  // Serve the built SPA (web/dist) if present
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/|\/api$|\/reports\/v1|\/pto\/v1|\/health).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
