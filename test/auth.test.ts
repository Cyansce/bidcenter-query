import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { AuthService } from '../src/auth/auth.service';

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
