import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
await mkdir('data', { recursive: true, mode: 0o700 });
try { await access('.env'); console.log('保留现有 .env'); }
catch {
  let env = await readFile('.env.example', 'utf8');
  env = env.replace(/^SESSION_KEY=$/m, `SESSION_KEY=${randomBytes(32).toString('base64')}`)
    .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=file:${resolve('data/bidcenter.db')}`);
  await writeFile('.env', env, { mode: 0o600 });
  console.log('已创建 .env（会话加密密钥已随机生成，请勿提交）');
}
