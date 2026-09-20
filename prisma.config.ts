import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { resolve } from 'node:path';
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: `file:${resolve((process.env.DATABASE_URL || 'file:./data/bidcenter.db').replace(/^file:/, ''))}` },
});
