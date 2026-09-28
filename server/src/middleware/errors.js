import { HttpError } from '../lib/errors.js';
import { ZodError } from 'zod';

export function notFoundHandler(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}`, code: 404 });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError || (err && err.status && err.status < 500)) {
    const status = err.status || 400;
    return res.status(status).json({ message: err.message, code: err.code || status, details: err.details });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), code: 400 });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body', code: 400 });
  if (err && err.code === '23505') return res.status(400).json({ message: 'Duplicate value: ' + (err.detail || err.message), code: 400 });
  if (err && err.code === '23503') return res.status(400).json({ message: 'Referenced entity does not exist: ' + (err.detail || err.message), code: 400 });
  if (err && err.code === '22P02') return res.status(400).json({ message: 'Invalid value: ' + err.message, code: 400 });
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ message: 'Internal server error', code: 500 });
}
