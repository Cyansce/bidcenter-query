import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const url = process.env.DATABASE_URL || `file:${resolve('data/bidcenter.db')}`;
if (!url.startsWith('file:') || url.includes('?')) throw new Error('DATABASE_URL 必须为 SQLite 文件路径');
const path = resolve(url.slice(5));
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
// Prisma 7.10 migrate deploy needs an existing SQLite file on some platforms.
// Exclusive creation preserves every existing database byte.
try { await writeFile(path, '', { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
