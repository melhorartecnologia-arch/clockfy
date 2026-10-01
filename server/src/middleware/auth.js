import { one, query } from '../lib/db.js';
import { verifyToken, hashApiKey } from '../lib/auth.js';
import { unauthorized } from '../lib/errors.js';
import { config } from '../config.js';

const buckets = new Map();
function rateLimit(key) {
  const now = Date.now();
  const b = buckets.get(key) || { ts: now, count: 0 };
  if (now - b.ts >= 1000) { b.ts = now; b.count = 0; }
  b.count += 1;
  buckets.set(key, b);
  if (buckets.size > 10000) buckets.clear();
  return b.count <= config.rateLimitPerSecond;
}

export async function resolveUser(req) {
  const apiKey = req.get('x-api-key') || req.get('x-addon-token');
  const auth = req.get('authorization');
  let user = null;
  if (apiKey) {
    const row = await one(
      `SELECT u.*, k.id AS api_key_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
      [hashApiKey(apiKey)],
    );
    if (!row) throw unauthorized('Invalid API key', 1000);
    query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.api_key_id]).catch(() => {});
    user = row;
    req.authType = 'API_KEY';
  } else if (auth && /^Bearer /i.test(auth)) {
    let payload;
    try { payload = verifyToken(auth.slice(7).trim()); } catch { throw unauthorized('Invalid or expired token', 1000); }
    user = await one('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!user) throw unauthorized('User not found', 1000);
    req.authType = 'JWT';
  } else {
    return null;
  }
  if (user.status === 'DELETED') throw unauthorized('Account deleted', 1000);
  // sign-ups waiting for approval (or rejected) have no access, even with a token issued before
  if (user.status === 'PENDING_APPROVAL') throw unauthorized('Account waiting for administrator approval', 1011);
  if (user.status === 'REJECTED') throw unauthorized('Account not approved', 1012);
  return user;
}

export async function authenticate(req, res, next) {
  try {
    const user = await resolveUser(req);
    if (!user) throw unauthorized('Authentication required: use Authorization: Bearer <token> or X-Api-Key', 1000);
    // Rate limit applies to third-party API-key traffic (like Clockify); the web app uses JWT and bursts freely
    if (req.authType === 'API_KEY' && !rateLimit(user.id)) {
      res.set('Retry-After', '1');
      return res.status(429).json({ message: 'Too many requests', code: 429 });
    }
    req.user = user;
    next();
  } catch (err) { next(err); }
}

export async function optionalAuth(req, res, next) {
  try { req.user = await resolveUser(req); next(); } catch (err) { next(err); }
}
