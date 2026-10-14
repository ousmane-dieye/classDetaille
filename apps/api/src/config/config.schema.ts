import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    HTTP_PORT: port,
    READY_PORT: port,
    READY_HOST: z.string().min(1).default('127.0.0.1'),
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

export type Env = z.infer<typeof envSchema>;
