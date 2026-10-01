import 'dotenv/config';

const env = process.env;

export const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/clockfy',
  jwtSecret: env.JWT_SECRET || 'change-me-in-production',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '30d',
  appUrl: env.APP_URL || `http://localhost:${env.PORT || 3000}`,
  uploadsDir: env.UPLOADS_DIR || new URL('../../uploads/', import.meta.url).pathname,
  maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'Clockfy <no-reply@clockfy.local>',
  },
  // rate limit for public API (requests per second per key/user)
  rateLimitPerSecond: Number(env.RATE_LIMIT_PER_SECOND || 50),
  schedulerEnabled: env.SCHEDULER_ENABLED !== 'false',
  webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS || 10000),
  logSql: env.LOG_SQL === 'true',
  // Accounts created by the public sign-up page must be approved by a system administrator before signing in.
  registrationApproval: env.REGISTRATION_APPROVAL !== 'false',
  // Sign-up attempts per client address per hour (protects the approval queue and the administrators' inbox)
  signupLimitPerHour: Number(env.SIGNUP_LIMIT_PER_HOUR || 10),
  // Extra hosts (host or host:port) the Clockify importer may call besides https://*.clockify.me – e.g. a mirror.
  clockifyImportAllowedHosts: String(env.CLOCKIFY_IMPORT_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
};

export default config;
