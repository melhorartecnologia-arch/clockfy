import crypto from 'node:crypto';

// Generates 24-char hex identifiers in the same format as Clockify (MongoDB ObjectId):
// 4 bytes timestamp + 5 bytes random + 3 bytes counter. This lets imported Clockify IDs
// coexist with locally generated ones and keeps third-party integrations working.
const processRandom = crypto.randomBytes(5);
let counter = crypto.randomInt(0, 0xffffff);

export function newId(date = new Date()) {
  const ts = Math.floor(date.getTime() / 1000);
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(ts >>> 0, 0);
  processRandom.copy(buf, 4);
  counter = (counter + 1) % 0xffffff;
  buf.writeUIntBE(counter, 9, 3);
  return buf.toString('hex');
}

export function isValidId(id) {
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
}

export function idCreationDate(id) {
  if (!isValidId(id)) return null;
  return new Date(parseInt(id.slice(0, 8), 16) * 1000);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
