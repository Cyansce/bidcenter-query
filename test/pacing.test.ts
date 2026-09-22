import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestPacer, retryAfterMs } from '../src/bidcenter/request-pacer';
import { BidcenterClient } from '../src/bidcenter/client.service';
import { challengePageUrl, SiteError } from '../src/bidcenter/protocol';

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
test('关闭批次休息后连续40次请求只等待配置的短间隔，重启不恢复长休息', async () => {
  const f = await fixture();
  Object.assign(f.options, { minInterval: 1500, maxInterval: 3000, batchSize: 0 });
  try {
    let pacer = f.makePacer();
    const start = f.clock.now();
    for (let i = 0; i < 40; i++) {
      if (i === 20) pacer = f.makePacer();
      await pacer.beforeRequest(); await pacer.afterRequest();
    }
    assert.equal(f.clock.now() - start, 39 * 1500);
    f.clock.random = () => 0.999999;
    await pacer.beforeRequest(); await pacer.afterRequest();
    assert.equal(Date.parse((await pacer.status()).nextRequestAt!) - f.clock.now(), 3000);
  } finally { await f.cleanup(); }
});
test('零额外等待仍串行，零时长批次不产生休息', async () => {
  const f = await fixture();
  Object.assign(f.options, { minInterval: 0, maxInterval: 0, batchSize: 2, breakMin: 0, breakMax: 0 });
  try {
    let active = 0; let maxActive = 0; const starts: number[] = [];
    const pacer = f.makePacer();
    const client = clientWith(pacer, async () => {
      active++; maxActive = Math.max(maxActive, active); starts.push(f.clock.now());
      await Promise.resolve(); f.advance(500); active--;
      return response();
    });
    await Promise.all([client.verifySession(), client.detail('1'), client.detail('2'), client.detail('3')]);
    assert.equal(maxActive, 1);
    assert.deepEqual(starts.map(at => at - starts[0]), [0, 500, 1000, 1500]);
    assert.equal((await pacer.status()).nextRequestAt, null);
  } finally { await f.cleanup(); }
});
test('429服从更长Retry-After，新任务/人工验证/重启均不能提前访问', async () => {
  const f = await fixture(); let calls = 0;
  Object.assign(f.options, { minInterval: 0, maxInterval: 0, batchSize: 0 });
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
test('验证码持久化暂停但不强加冷却，人工验证成功才恢复', async () => {
  const f = await fixture(); let calls = 0; let challenge = true;
  try {
    const client = clientWith(f.makePacer(), async () => {
      calls++;
      return challenge ? { ...response(), text: async () => JSON.stringify({ ret: false, retbs: 999 }) } : response();
    });
    await assert.rejects(client.detail('1'), (e: SiteError) => e.kind === 'HUMAN_REQUIRED' && e.retryAt === undefined);
    assert.equal((await client.pacingStatus()).pausedUntil, null);
    (client as any).pacer = f.makePacer();
    await assert.rejects(client.verifySession(), (e: SiteError) => e.kind === 'HUMAN_REQUIRED');
    await assert.rejects(client.detail('2'), (e: SiteError) => e.kind === 'HUMAN_REQUIRED'); assert.equal(calls, 1);
    await assert.rejects(client.verifySession(true), (e: SiteError) => e.kind === 'HUMAN_REQUIRED');
    assert.equal((await client.pacingStatus()).humanRequired, true);
    challenge = false; await client.verifySession(true); assert.equal((await client.pacingStatus()).humanRequired, false);
    await client.detail('2'); assert.equal(calls, 4);
  } finally { await f.cleanup(); }
});
test('验证码响应指定Retry-After时，人工验证也必须等到服务器允许的时间', async () => {
  const f = await fixture(); let challenge = true; let calls = 0;
  try {
    const start = f.clock.now();
    const client = clientWith(f.makePacer(), async () => {
      calls++;
      return challenge ? response(403, {}, { 'retry-after': '120' }) : response();
    });
    await assert.rejects(client.detail('1'), (e: SiteError) => e.kind === 'HUMAN_REQUIRED' && e.retryAt?.getTime() === start + 120000);
    (client as any).pacer = f.makePacer(); challenge = false;
    await assert.rejects(client.verifySession(true), (e: SiteError) => e.kind === 'COOLDOWN');
    assert.equal(calls, 1);
    f.advance(120000);
    await assert.rejects(client.detail('2'), (e: SiteError) => e.kind === 'HUMAN_REQUIRED');
    await client.verifySession(true);
    assert.equal((await client.pacingStatus()).humanRequired, false);
    assert.equal(calls, 2);
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
test('自动导入浏览器会话等待在途请求完成，验证失败回滚候选会话', async () => {
  const f = await fixture(); Object.assign(f.options, { minInterval: 0, maxInterval: 0, batchSize: 0 });
  const events: string[] = []; let calls = 0; let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const sessions = {
    context: async () => ({ post: async () => {
      calls++;
      if (calls === 1) { events.push('detail-start'); started(); await pending; events.push('detail-end'); return response(); }
      return response(401);
    } }),
    credentials: async () => ({ token: 'test', guid: 'test' }), persist: async () => {},
    replace: async () => { events.push('replace'); }, resetFromDisk: async () => { events.push('rollback'); },
  };
  const client = new BidcenterClient(sessions as any); (client as any).pacer = f.makePacer();
  try {
    const detail = client.detail('1'); await entered;
    const verify = client.verifyBrowserSession({ cookies: [], origins: [] });
    assert.deepEqual(events, ['detail-start']); release();
    await detail; await assert.rejects(verify, (error: SiteError) => error.kind === 'LOGIN_REQUIRED');
    assert.deepEqual(events, ['detail-start', 'detail-end', 'replace', 'rollback']);
  } finally { release?.(); await f.cleanup(); }
});
test('网站给出的验证跳转保留到人工处理，不打开其他域名或非HTTPS链接', async () => {
  const f = await fixture();
  const location = 'https://search.bidcenter.com.cn/HumanMachineVerification.shtml';
  try {
    const client = clientWith(f.makePacer(), async () => response(303, {}, { location }));
    await assert.rejects(client.search('服务器', 1), (error: SiteError) => error.kind === 'HUMAN_REQUIRED' && error.challengeUrl === location);
    assert.equal(challengePageUrl('https://bidcenter.com.cn.example.com/challenge'), undefined);
    assert.equal(challengePageUrl('javascript:alert(1)'), undefined);
    assert.equal(challengePageUrl('https://user:pass@search.bidcenter.com.cn/'), undefined);
  } finally { await f.cleanup(); }
});
