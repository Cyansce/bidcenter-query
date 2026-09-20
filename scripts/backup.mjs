import 'dotenv/config';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
process.umask(0o077);
const require = createRequire(import.meta.url);
const SQLite = require('better-sqlite3');
const source = resolve((process.env.DATABASE_URL || 'file:./data/bidcenter.db').replace(/^file:/, ''));
const destination = resolve(process.argv[2] || `data/backups/bidcenter-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
const db = new SQLite(source, { readonly: true, fileMustExist: true });
try { await db.backup(destination); console.log(`数据库一致性备份已保存：${destination}`); } finally { db.close(); }
