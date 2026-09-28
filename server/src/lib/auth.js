import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt);
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const candidate = await scrypt(password, salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

export function signToken(payload, opts = {}) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn, ...opts });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

// API keys look like Clockify's: long random strings. We store only a SHA-256 hash.
export function generateApiKey() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 6) };
}

export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function sha256(v) {
  return crypto.createHash('sha256').update(v).digest('hex');
}
