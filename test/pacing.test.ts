import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestPacer, retryAfterMs } from '../src/bidcenter/request-pacer';
import { BidcenterClient } from '../src/bidcenter/client.service';
import { SiteError } from '../src/bidcenter/protocol';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bidcenter-pacing-'));
  let now = Date.parse('2026-09-20T00:00:00Z');
  const clock = { now: () => now, random: () => 0,
    sleep: async (ms: number, signal: AbortSignal) => { assert.ok(!signal.aborted); now += ms; } };
  const options = { path: join(dir, 'request-pacing.json'), minInterval: 10000, maxInterval: 20000, batchSize: 20,
    breakMin: 90000, breakMax: 150000, cooldown: 1800000, retryBase: 60000 };
  const makePacer = () => new RequestPacer(options, clock);
  return { options, clock, makePacer, advance: (ms: number) => { now += ms; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function clientWith(pacer: RequestPacer, post: (url: string, options: any) => Promise<any>) {
  const client = new BidcenterClient({ context: async () => ({ post }), credentials: async () => ({ token: 'current-member-token', guid: 'test-guid' }), persist: async () => {} } as any);
  (client as any).pacer = pacer;
  return client;
}
const response = (status = 200, data: any = { isLogin: true }, headers: Record<string, string> = {}) => ({ status: () => status,
  headers: () => headers, text: async () => JSON.stringify({ ret: true, other2: data }), dispose: async () => {} });

test('随机间隔包含上下界、响应耗时后仍休息、20次批次与重启状态连续', async () => {
  const f = await fixture();
  try {
    let pacer = f.makePacer();
    for (let i = 0; i < 20; i++) { await pacer.beforeRequest(); f.advance(5000); await pacer.afterRequest(); }
    const before = f.clock.now();
    assert.equal(Date.parse((await pacer.status()).nextRequestAt!) - before, 100000);
    pacer = f.makePacer(); await pacer.beforeRequest(); assert.equal(f.clock.now() - before, 100000);
    f.clock.random = () => 0.999999;
    await pacer.afterRequest(); await pacer.beforeRequest(); await pacer.afterRequest();
    assert.equal(Date.parse((await pacer.status()).nextRequestAt!) - f.clock.now(), 20000);
    const state = JSON.parse(await readFile(f.options.path, 'utf8')); assert.equal(state.requests, 22);
    assert.ok(!JSON.stringify(state).includes('token'));
  } finally { await f.cleanup(); }
});
test('搜索、详情、登录校验共用串行间隔，慢响应不会导致后续突发', async () => {
  const f = await fixture(); f.options.batchSize = 2;
  try {
    const starts: number[] = []; let active = 0; let maxActive = 0;
    const client = clientWith(f.makePacer(), async (url, options) => {
      active++; maxActive = Math.max(maxActive, active); starts.push(f.clock.now());
      assert.equal(options.form.token, 'current-member-token');
      await Promise.resolve(); f.advance(5000); active--;
      return response(200, url.includes('GetSearch') ? { realInfoCount: 0, listData: [], isFufei: true } : { isLogin: true, id: 1 });
    });
    await Promise.all([client.verifySession(), client.search('服务器', 1), client.detail('1')]);
    assert.equal(maxActive, 1); assert.equal(starts.length, 3);
    assert.equal(starts[1] - starts[0], 15000); assert.equal(starts[2] - starts[1], 105000);
  } finally { await f.cleanup(); }
});
test('429服从更长Retry-After，新任务/人工验证/重启均不能提前访问', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const start = f.clock.now(); let pacer = f.makePacer();
    const client = clientWith(pacer, async () => { calls++; return response(429, {}, { 'retry-after': '3600' }); });
    await assert.rejects(client.detail('1'), (e: SiteError) => e.kind === 'COOLDOWN' && e.retryAt?.getTime() === start + 3600000);
    await assert.rejects(client.search('new query', 1), (e: SiteError) => e.kind === 'COOLDOWN');
    pacer = f.makePacer(); (client as any).pacer = pacer;
    await assert.rejects(client.verifySession(true), (e: SiteError) => e.kind === 'COOLDOWN');
    assert.equal(calls, 1); assert.equal((await pacer.status()).humanRequired, false);
    f.advance(3600000); await pacer.beforeRequest();
  } finally { await f.cleanup(); }
});
test('验证码持久化熔断，冷却结束也不自动探测，仅人工完成验证可解除', async () => {
  const f = await fixture(); let calls = 0; let challenge = true;
  try {
    const client = clientWith(f.makePacer(), async () => {
      calls++;
      return challenge ? { ...response(), text: async () => JSON.stringify({ ret: false, retbs: 999 }) } : response();
    });
    await assert.rejects(client.detail('1'), (e: SiteError) => e.kind === 'HUMAN_REQUIRED');
    f.advance(1800000); (client as any).pacer = f.makePacer();
    await assert.rejects(client.verifySession(), (e: SiteError) => e.kind === 'HUMAN_REQUIRED');
    await assert.rejects(client.detail('2'), (e: SiteError) => e.kind === 'HUMAN_REQUIRED'); assert.equal(calls, 1);
    challenge = false; await client.verifySession(true); assert.equal((await client.pacingStatus()).humanRequired, false);
    await client.detail('2'); assert.equal(calls, 3);
  } finally { await f.cleanup(); }
});
test('网络失败和5xx不立即重试，退避保存在磁盘并随连续失败增加', async () => {
  const f = await fixture(); let calls = 0;
  try {
    let pacer = f.makePacer();
    const client = clientWith(pacer, async () => { calls++; if (calls === 1) throw new Error('network'); return response(503); });
    let at = f.clock.now();
    await assert.rejects(client.detail('1'), (e: SiteError) => e.kind === 'TRANSIENT' && e.retryAt?.getTime() === at + 60000);
    assert.equal(calls, 1); f.advance(60000); pacer = f.makePacer(); (client as any).pacer = pacer; at = f.clock.now();
    await assert.rejects(client.detail('1'), (e: SiteError) => e.kind === 'TRANSIENT' && e.retryAt?.getTime() === at + 120000);
    assert.equal(calls, 2);
  } finally { await f.cleanup(); }
});
test('停止服务可立即取消批次休息', async () => {
  const f = await fixture();
  try {
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.clock.sleep = (_ms: number, signal: AbortSignal) => new Promise((_resolve, reject) => { entered(); signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); });
    const pacer = f.makePacer(); await pacer.beforeRequest(); await pacer.afterRequest();
    const pending = pacer.beforeRequest(); await waiting; pacer.stop();
    await assert.rejects(pending, /取消等待/);
  } finally { await f.cleanup(); }
});
test('Retry-After解析秒数和HTTP日期，过期及无效值不延迟', () => {
  const now = Date.parse('2026-09-20T00:00:00Z');
  assert.equal(retryAfterMs('120', now), 120000);
  assert.equal(retryAfterMs('Sun, 20 Sep 2026 01:00:00 GMT', now), 3600000);
  assert.equal(retryAfterMs('Sun, 20 Sep 2026 00:00:00 GMT', now), 0);
  assert.equal(retryAfterMs('invalid', now), 0); assert.equal(retryAfterMs(undefined, now), 0);
});
