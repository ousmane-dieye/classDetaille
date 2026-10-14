import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);

/** Variables de la base seules : la CLI Prisma (prisma.config.ts) n'a besoin que de celles-ci. */
export const dbEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    DB_HOST: z.string().min(1),
    DB_PORT: port,
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_AUTH_MODE: z.enum(['password', 'cert']),
    DB_PASSWORD_FILE: z.string().min(1).optional(),
    DB_SSL_CA_FILE: z.string().min(1).optional(),
    DB_SSL_CERT_FILE: z.string().min(1).optional(),
    DB_SSL_KEY_FILE: z.string().min(1).optional(),
    DB_SSL_P12_FILE: z.string().min(1).optional(),
    DB_SSL_P12_PASSWORD_FILE: z.string().min(1).optional(),
  })
  .passthrough();

/** Origine seule (schéma, hôte, port) : ni chemin, ni chaîne de requête, ni fragment. */
const origin = z.url({ protocol: /^https?$/ }).refine((u) => {
  const p = new URL(u);
  return p.pathname === '/' && !p.search && !p.hash;
});

export const envSchema = dbEnvSchema.extend({
  HTTP_PORT: port,
  READY_PORT: port,
  READY_HOST: z.string().min(1).default('127.0.0.1'),
  APP_ORIGIN: origin,
  TRUST_PROXY: z.coerce.number().int().min(0).max(3).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  RATE_LIMIT_HMAC_KEY_FILE: z.string().min(1),
  TURNSTILE_SECRET_FILE: z.string().min(1),
  OTP_PEPPER_FILE: z.string().min(1),
  OUTBOX_PAYLOAD_KEY_FILE: z.string().min(1),
  TURNSTILE_VERIFY_URL: z.url().default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
  LOGIN_LIMIT_PER_IP: z.coerce.number().int().min(1).default(100),
  THROTTLE_PER_IP: z.coerce.number().int().min(1).default(600),
  THROTTLE_PER_SESSION: z.coerce.number().int().min(1).default(300),
});

export type Env = z.infer<typeof envSchema>;

export const workerEnvSchema = dbEnvSchema.extend({
  APP_ORIGIN: origin,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  OUTBOX_PAYLOAD_KEY_FILE: z.string().min(1),
  MAIL_FROM: z.email(),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: port,
  SMTP_SECURITY: z.enum(['none', 'starttls', 'tls']),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD_FILE: z.string().min(1).optional(),
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(30_000),
});

export const opsEnvSchema = dbEnvSchema.extend({ OTP_PEPPER_FILE: z.string().min(1) });
