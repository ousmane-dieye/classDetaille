import { defineConfig } from 'prisma/config';
import { loadDbConfig } from './src/config/load-config.js';
import { toPrismaCliUrl } from './src/config/database-connection.js';

// L'URL n'est construite que si une base est configurée : `prisma generate` n'en a pas besoin (CI).
const datasource = process.env.DB_HOST ? { url: toPrismaCliUrl(loadDbConfig(process.env)) } : undefined;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(datasource ? { datasource } : {}),
});
