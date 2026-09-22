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
  databaseUrl: `file:${resolve((process.env.DATABASE_URL || 'file:./data/bidcenter.db').replace(/^file:/, ''))}`,
  dataDir: resolve(process.env.DATA_DIR || 'data'),
  sessionKey: process.env.SESSION_KEY || '',
  loginMethod: choice('LOGIN_METHOD', 'sms', ['sms', 'password']),
  phone: process.env.LOGIN_PHONE || '',
  username: process.env.LOGIN_USERNAME || '',
  expectedAccount: process.env.BIDCENTER_ACCOUNT || '',
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
  // A run shares this budget across all queries. Legacy settings cannot lift the hard cap.
  maxPages: Math.min(15, integer('MAX_PAGES_PER_RUN', integer('MAX_PAGES_PER_QUERY', 15, 1, 1000), 1, 1000)),
  requestInterval: integer('REQUEST_MIN_INTERVAL_MS', 1500, 0, 120000),
  requestMaxInterval: integer('REQUEST_MAX_INTERVAL_MS', 3000, 0, 300000),
  // Zero disables the optional batch break; requests still share one serial queue.
  requestBatchSize: integer('REQUEST_BATCH_SIZE', 0, 0, 100),
  requestBreakMin: integer('REQUEST_BREAK_MIN_MS', 0, 0, 3600000),
  requestBreakMax: integer('REQUEST_BREAK_MAX_MS', 0, 0, 3600000),
  rateLimitCooldown: integer('RATE_LIMIT_COOLDOWN_MS', 1800000, 60000, 86400000),
  requestRetryBase: integer('REQUEST_RETRY_BASE_MS', 60000, 10000, 3600000),
  requestTimeout: integer('REQUEST_TIMEOUT_MS', 30000, 1000, 60000),
  detailRefreshHours: integer('DETAIL_REFRESH_HOURS', 24, 1, 168),
  scheduleEnabled: process.env.SCHEDULE_ENABLED !== 'false',
  runOnStartup: process.env.RUN_ON_STARTUP === 'true',
  webhookUrl: process.env.NOTIFICATION_WEBHOOK_URL || '',
};
export function validateConfig() {
  if (Buffer.from(config.sessionKey, 'base64').length !== 32) throw new Error('SESSION_KEY 必须是 32 字节的 Base64 密钥');
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('file:')) throw new Error('只支持 SQLite file: 数据库');
  if (!config.keywords.length) throw new Error('SEARCH_KEYWORDS 不能为空');
  if (config.requestMaxInterval < config.requestInterval) throw new Error('REQUEST_MAX_INTERVAL_MS 不能小于 REQUEST_MIN_INTERVAL_MS');
  if (config.requestBreakMax < config.requestBreakMin) throw new Error('REQUEST_BREAK_MAX_MS 不能小于 REQUEST_BREAK_MIN_MS');
}
