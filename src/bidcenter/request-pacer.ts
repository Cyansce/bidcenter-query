import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SiteError } from './protocol';

export interface PacingOptions {
  path: string;
  minInterval: number;
  maxInterval: number;
  batchSize: number;
  breakMin: number;
  breakMax: number;
  cooldown: number;
  retryBase: number;
}
interface PacingState {
  version: 1;
  nextRequestAt: number;
  pausedUntil: number;
  requests: number;
  failures: number;
  humanRequired: boolean;
}
interface Clock {
  now(): number;
  random(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
const realClock: Clock = { now: Date.now, random: Math.random, sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } };

export function retryAfterMs(value: string | undefined, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.max(0, Math.min(duration, 8640000000000000 - now)) : 0;
}

// The client's single request queue owns mutations. Persisted state also protects restarts.
export class RequestPacer {
  private state: PacingState = { version: 1, nextRequestAt: 0, pausedUntil: 0, requests: 0, failures: 0, humanRequired: false };
  private loading?: Promise<void>;
  private readonly abort = new AbortController();
  private gap = 0;
  constructor(private readonly options: PacingOptions, private readonly clock: Clock = realClock) {}
  private load() {
    this.loading ??= (async () => {
      try {
        const saved = JSON.parse(await readFile(this.options.path, 'utf8'));
        if (saved.version !== 1 || typeof saved.humanRequired !== 'boolean' ||
          !['nextRequestAt', 'pausedUntil', 'requests', 'failures'].every(key => Number.isSafeInteger(saved[key]) && saved[key] >= 0)) throw new Error('Invalid pacing state');
        this.state = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('请求节奏状态读取失败；请检查 data/request-pacing.json，修复前停止请求');
      }
    })();
    return this.loading;
  }
  private async save() {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const temp = `${this.options.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.options.path);
  }
  private random(min: number, max: number) { return Math.floor(min + this.clock.random() * (max - min + 1)); }
  async beforeRequest(manualVerification = false) {
    await this.load();
    if (this.abort.signal.aborted) throw new SiteError('TRANSIENT', '服务正在关闭，已取消等待中的请求');
    if (this.state.pausedUntil > this.clock.now()) throw new SiteError('COOLDOWN', '访问冷却中，请等待管理页显示的恢复时间', new Date(this.state.pausedUntil));
    if (this.state.humanRequired && !manualVerification) throw new SiteError('HUMAN_REQUIRED', '此前已触发网站验证，请先人工验证并点击“验证并保存会话”');
    while (this.state.nextRequestAt > this.clock.now()) {
      try { await this.clock.sleep(Math.min(1000, this.state.nextRequestAt - this.clock.now()), this.abort.signal); }
      catch { throw new SiteError('TRANSIENT', '服务正在关闭，已取消等待中的请求'); }
    }
    this.state.requests++;
    this.gap = this.random(this.options.minInterval, this.options.maxInterval);
    if (this.state.requests % this.options.batchSize === 0) this.gap += this.random(this.options.breakMin, this.options.breakMax);
    // Reserve before dispatch so a crash during a request cannot cause a restart burst.
    this.state.nextRequestAt = this.clock.now() + this.gap;
    await this.save();
  }
  async afterRequest() {
    // Measure idle time from completion; a slow response must not erase the next pause.
    this.state.nextRequestAt = Math.max(this.state.nextRequestAt, this.clock.now() + this.gap);
    await this.save();
  }
  async succeeded() { this.state.failures = 0; await this.save(); }
  async failed(error: SiteError, serverDelay = 0): Promise<SiteError> {
    if (!['TRANSIENT', 'COOLDOWN', 'HUMAN_REQUIRED'].includes(error.kind)) return error;
    this.state.failures++;
    const transientWait = Math.min(1800000, this.options.retryBase * 2 ** Math.min(10, this.state.failures - 1));
    const wait = Math.max(serverDelay, error.kind === 'TRANSIENT' ? transientWait : this.options.cooldown);
    this.state.pausedUntil = Math.max(this.state.pausedUntil, this.clock.now() + wait);
    if (error.kind === 'HUMAN_REQUIRED') this.state.humanRequired = true;
    await this.save();
    return new SiteError(error.kind, error.message, new Date(this.state.pausedUntil));
  }
  async confirmHumanVerification() { this.state.humanRequired = false; await this.save(); }
  async status() {
    await this.load();
    return { minIntervalMs: this.options.minInterval, maxIntervalMs: this.options.maxInterval, batchSize: this.options.batchSize,
      breakMinMs: this.options.breakMin, breakMaxMs: this.options.breakMax, humanRequired: this.state.humanRequired,
      pausedUntil: this.state.pausedUntil > this.clock.now() ? new Date(this.state.pausedUntil).toISOString() : null,
      nextRequestAt: this.state.nextRequestAt > this.clock.now() ? new Date(this.state.nextRequestAt).toISOString() : null };
  }
  stop() { this.abort.abort(); }
}
