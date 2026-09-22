import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { AuthService } from '../src/auth/auth.service';
import { SessionService, accountIdentity } from '../src/auth/session.service';
import { SiteError } from '../src/bidcenter/protocol';

test('验证码弹层未完成时不点击提交，也不强制穿过遮挡', async () => {
  config.loginBrowserMode = 'playwright';
  let clicked = false; let filled = false;
  const auth = new AuthService({} as any, {} as any, { notify: async () => {} } as any, {} as any);
  (auth as any).method = 'sms';
  (auth as any).page = { isClosed: () => false, locator: () => ({ isVisible: async () => true, fill: async () => { filled = true; }, click: async () => { clicked = true; } }) };
  await assert.rejects(auth.submitCode('123456'), /验证弹层/);
  assert.equal(clicked, false); assert.equal(filled, false);
});
test('浏览器异常不向 API 或日志转发凭据内容', async () => {
  config.loginBrowserMode = 'playwright';
  const auth = new AuthService({} as any, {} as any, { notify: async () => {} } as any, {} as any);
  (auth as any).method = 'password';
  (auth as any).page = { isClosed: () => false, locator: () => ({ isVisible: async () => false, click: async () => { throw new Error('value=secret-password'); } }) };
  await assert.rejects(auth.submitPassword(), (error: any) => !error.message.includes('secret-password') && error.getStatus() === 400);
});
test('查询只接受指定会员账号的本站有效会话', async () => {
  const previous = config.expectedAccount; config.expectedAccount = 'member';
  const sessions = new SessionService();
  const state = (name: string) => ({ cookies: [{ name: 'aspcn', domain: '.bidcenter.com.cn', value: `name=${name}&Token=test-token&vip=2`, expires: -1 }], origins: [] });
  try {
    assert.equal(accountIdentity(state('member') as any).name, 'member');
    assert.equal((await sessions.credentials({ storageState: async () => state('member') } as any)).token, 'test-token');
    await assert.rejects(sessions.credentials({ storageState: async () => state('wrong') } as any), /不是指定的会员账号/);
    const otherDomain = state('member'); otherDomain.cookies[0].domain = 'other.example';
    await assert.rejects(sessions.credentials({ storageState: async () => otherDomain } as any), /尚未登录/);
  } finally { config.expectedAccount = previous; await sessions.onApplicationShutdown(); }
});

function browserFixture() {
  const previous = { browserMode: config.loginBrowserMode, expected: config.expectedAccount };
  config.loginBrowserMode = 'playwright'; config.expectedAccount = 'member';
  let challenge = false; let login = false; let token = 'one'; let account = 'member'; let calls = 0; let closed = 0;
  let verify: () => Promise<void> = async () => {};
  const page = { isClosed: () => false, url: () => 'https://search.bidcenter.com.cn/', evaluate: async () => 'test-agent',
    locator: (selector: string) => { const locator = { first: () => locator, isVisible: async () => selector.includes('captcha') || selector.includes('Captcha') || selector.includes('nc_1') ? challenge : login }; return locator; } };
  const context = { pages: () => [page], storageState: async () => ({ cookies: [{ name: 'aspcn', value: `name=${account}&Token=${token}`, domain: '.bidcenter.com.cn', path: '/', expires: -1 }], origins: [] }) };
  const client = { verifyBrowserSession: async () => { calls++; await verify(); } };
  const auth = new AuthService({ identity: async () => ({}) } as any, client as any, { notify: async () => {} } as any, { isOpen: false, close: async () => {} } as any);
  Object.assign(auth, { page, browserContext: context, browser: { close: async () => { closed++; } }, blocked: true, state: 'PASSWORD_READY' });
  return { auth, context, page, client, calls: () => calls, closed: () => closed,
    challenge: (value: boolean) => { challenge = value; }, login: (value: boolean) => { login = value; },
    token: (value: string) => { token = value; }, account: (value: string) => { account = value; }, verify: (fn: () => Promise<void>) => { verify = fn; },
    cleanup: async () => { await auth.onApplicationShutdown(); config.loginBrowserMode = previous.browserMode; config.expectedAccount = previous.expected; } };
}
test('浏览器直接账号登录后自动同步会话，无需验证码或手动确认', async () => {
  const f = browserFixture();
  try {
    f.login(true); assert.equal(await f.auth.syncBrowserSession(), false); assert.equal(f.calls(), 0);
    f.login(false); assert.equal(await f.auth.syncBrowserSession(), true);
    assert.equal(f.calls(), 1); assert.equal(f.closed(), 1); assert.equal(f.auth.isBlocked(), false);
    assert.equal((await f.auth.status()).state, 'AUTHENTICATED');
  } finally { await f.cleanup(); }
});
test('人工验证未完成时只观察，完成后自动续跑；账号不匹配时保持暂停', async () => {
  const f = browserFixture();
  try {
    f.challenge(true); assert.equal(await f.auth.syncBrowserSession(), false); assert.equal(f.calls(), 0);
    f.challenge(false); f.account('wrong'); assert.equal(await f.auth.syncBrowserSession(), false); assert.equal(f.calls(), 0);
    assert.equal(f.auth.isBlocked(), true);
    f.account('member'); assert.equal(await f.auth.syncBrowserSession(), true); assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});
test('无效登录态不反复请求，浏览器会话变化后才重新检查', async () => {
  const f = browserFixture();
  try {
    f.verify(async () => { throw new SiteError('LOGIN_REQUIRED', '登录已过期'); });
    assert.equal(await f.auth.syncBrowserSession(), false);
    assert.equal(await f.auth.syncBrowserSession(), false); assert.equal(f.calls(), 1);
    f.token('two'); f.verify(async () => {});
    assert.equal(await f.auth.syncBrowserSession(), true); assert.equal(f.calls(), 2);
  } finally { await f.cleanup(); }
});
test('会话同步串行执行，冷却结束前不重复校验', async () => {
  const f = browserFixture(); let release!: () => void;
  try {
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.verify(async () => { await pending; throw new SiteError('COOLDOWN', '冷却中', new Date(Date.now() + 60000)); });
    const first = f.auth.syncBrowserSession();
    assert.equal(await f.auth.syncBrowserSession(), false);
    release(); assert.equal(await first, false); assert.equal(f.calls(), 1);
    f.token('two'); assert.equal(await f.auth.syncBrowserSession(), false); assert.equal(f.calls(), 1);
    (f.auth as any).nextCheckAt = Date.now() - 1; f.verify(async () => {});
    assert.equal(await f.auth.syncBrowserSession(), true); assert.equal(f.calls(), 2);
  } finally { release?.(); await f.cleanup(); }
});
test('查询要求人工验证时自动弹窗，同一事件不重复打开，失败保留人工处理入口', async () => {
  const auth = new AuthService({} as any, {} as any, { notify: async () => {} } as any, {} as any);
  let opens = 0;
  auth.openChallenge = async () => { opens++; throw new Error('browser unavailable'); };
  await auth.requireAction(new SiteError('HUMAN_REQUIRED', '需要验证'));
  await auth.requireAction(new SiteError('HUMAN_REQUIRED', '需要验证'));
  assert.equal(opens, 1); assert.equal(auth.isBlocked(), true);
  assert.equal((auth as any).state, 'HUMAN_REQUIRED');
});
test('普通 Chrome 模式也能从浏览器当前登录态自动继续', async () => {
  const f = browserFixture();
  try {
    config.loginBrowserMode = 'chrome-manual';
    (f.auth as any).manual = { isOpen: true, attach: async () => f.context, close: async () => {} };
    assert.equal(await f.auth.syncBrowserSession(), true); assert.equal(f.calls(), 1); assert.equal(f.auth.isBlocked(), false);
  } finally { await f.cleanup(); }
});
test('人工验证自动打开网站给出的页面并置前，不覆盖已经打开的验证弹层', async () => {
  const f = browserFixture(); const navigations: string[] = []; let focused = 0;
  Object.assign(f.page, { goto: async (url: string) => { navigations.push(url); }, bringToFront: async () => { focused++; } });
  (f.auth as any).openBrowser = async () => f.page;
  try {
    const location = 'https://search.bidcenter.com.cn/HumanMachineVerification.shtml';
    await f.auth.requireAction(new SiteError('HUMAN_REQUIRED', '需要验证', undefined, location));
    assert.deepEqual(navigations, [location]); assert.equal(focused, 1);
    f.challenge(true); await f.auth.openChallenge();
    assert.deepEqual(navigations, [location]); assert.equal(focused, 2);
  } finally { await f.cleanup(); }
});
