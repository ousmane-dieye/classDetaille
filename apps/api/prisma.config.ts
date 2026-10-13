import { defineConfig } from 'prisma/config';
import { loadConfig } from './src/config/load-config.js';
import { toPrismaCliUrl } from './src/config/database-connection.js';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: toPrismaCliUrl(loadConfig(process.env).db) },
});
