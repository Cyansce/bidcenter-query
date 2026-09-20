import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { AuthService } from '../src/auth/auth.service';
import { SessionService, accountIdentity } from '../src/auth/session.service';

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
    await assert.rejects(sessions.credentials({ storageState: async () => otherDomain } as any), /不是指定的会员账号/);
  } finally { config.expectedAccount = previous; await sessions.onApplicationShutdown(); }
});
