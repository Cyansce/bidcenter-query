import 'dotenv/config';
import { resolve } from 'node:path';

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`配置 ${name} 必须在 ${min}—${max} 之间`);
  return value;
}
function choice<T extends string>(name: string, fallback: T, choices: readonly T[]): T {
  const value = process.env[name] || fallback;
  if (!choices.includes(value as T)) throw new Error(`配置 ${name} 无效`);
  return value as T;
}
export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: integer('PORT', 3100, 1, 65535),
  apiKey: process.env.API_KEY || '',
  databaseUrl: `file:${resolve((process.env.DATABASE_URL || 'file:./data/bidcenter.db').replace(/^file:/, ''))}`,
  dataDir: resolve(process.env.DATA_DIR || 'data'),
  sessionKey: process.env.SESSION_KEY || '',
  loginMethod: choice('LOGIN_METHOD', 'sms', ['sms', 'password']),
  phone: process.env.LOGIN_PHONE || '17704057367',
  username: process.env.LOGIN_USERNAME || '',
  password: process.env.LOGIN_PASSWORD || '',
  loginBrowserMode: choice('LOGIN_BROWSER_MODE', 'chrome-manual', ['chrome-manual', 'playwright']),
  chromeExecutable: process.env.CHROME_EXECUTABLE || '',
  chromeDebugPort: integer('CHROME_DEBUG_PORT', 9227, 1024, 65535),
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
  browserHeadless: process.env.BROWSER_HEADLESS === 'true',
  searchMode: choice('SEARCH_MODE', 'combined', ['combined', 'separate']),
  keywords: (process.env.SEARCH_KEYWORDS || '昇腾,鲲鹏,服务器,工作站').split(/[,，、]/).map(s => s.trim()).filter(Boolean),
  combinedQuery: process.env.SEARCH_COMBINED_QUERY || '昇腾、鲲鹏、服务器、工作站',
  searchTag: integer('SEARCH_TAG', 0, 0, 2),
  lookbackDays: integer('LOOKBACK_DAYS', 7, 1, 7),
  maxPages: integer('MAX_PAGES_PER_QUERY', 100, 1, 1000),
  requestInterval: integer('REQUEST_MIN_INTERVAL_MS', 3000, 1000, 60000),
  requestTimeout: integer('REQUEST_TIMEOUT_MS', 30000, 1000, 60000),
  detailRefreshHours: integer('DETAIL_REFRESH_HOURS', 24, 1, 168),
  scheduleEnabled: process.env.SCHEDULE_ENABLED !== 'false',
  runOnStartup: process.env.RUN_ON_STARTUP === 'true',
  webhookUrl: process.env.NOTIFICATION_WEBHOOK_URL || '',
};
export function validateConfig() {
  if (config.apiKey.length < 24) throw new Error('请先 npm run setup；API_KEY 至少 24 字符');
  if (Buffer.from(config.sessionKey, 'base64').length !== 32) throw new Error('SESSION_KEY 必须是 32 字节的 Base64 密钥');
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('file:')) throw new Error('只支持 SQLite file: 数据库');
  if (!config.keywords.length) throw new Error('SEARCH_KEYWORDS 不能为空');
}
