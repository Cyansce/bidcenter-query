import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePayload, parseSearch, searchForm, unwrapPayload, SiteError, interfaceHeaders } from '../src/bidcenter/protocol';
import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../src/auth/session.service';

test('公开前端 AES-CBC / ZeroPadding 协议向量', () => {
  const result = decodePayload('cS8N79l0xou843TYZD9FqwTZxam3rGjI4qAOADudN8ZMsycgjO5BOtTlmYhLhK9gSDVcxqM23a6HotY7GK0TgQ==');
  assert.equal(unwrapPayload(result).title, '昇腾服务器');
  assert.throws(() => decodePayload('<html>challenge</html>'), SiteError);
});
test('组合查询保留原表达式、全国、近一周、类型和双层表单编码', () => {
  const raw = '昇腾 鲲鹏 服务器 工作站';
  const form = searchForm(raw, 3, 'test-token', 'test-guid');
  const submitted = new URLSearchParams(form).toString();
  assert.ok(submitted.includes('keywords=%25E6'));
  assert.equal(decodeURIComponent(new URLSearchParams(submitted).get('keywords')!), raw);
  assert.equal(form.type, '1,2'); assert.equal(form.time, '7'); assert.equal(form.page, '3');
  assert.ok(!('diqu' in form));
});
test('过期、风控、权限、空结果分别处理，不采推荐列表', () => {
  for (const [retbs, kind] of [[-100, 'LOGIN_REQUIRED'], [999, 'HUMAN_REQUIRED'], [998, 'HUMAN_REQUIRED']] as const) {
    assert.throws(() => unwrapPayload({ ret: false, retbs }), (e: any) => e.kind === kind);
  }
  assert.throws(() => unwrapPayload({ ret: false, msg: '会员权限不足' }), (e: any) => e.kind === 'PERMISSION_REQUIRED');
  assert.equal(parseSearch({ realInfoCount: 0, recommendList: [{ news_id: 1 }] }).items.length, 0);
  assert.throws(() => parseSearch({ realInfoCount: 10 }), (e: any) => e.kind === 'PERMISSION_REQUIRED');
  assert.throws(() => parseSearch({ listData: [] }), SiteError);
});
test('会话加密可恢复，密文篡改和错误密钥均失败', () => {
  const key = randomBytes(32); const state = { cookies: [{ name: 'test', value: 'sensitive-session' }], origins: [] };
  const bytes = seal(state, key);
  assert.ok(!bytes.includes(Buffer.from('sensitive-session')));
  assert.deepEqual(unseal(bytes, key), state);
  assert.throws(() => unseal(bytes, randomBytes(32)));
  bytes[bytes.length - 1] ^= 1; assert.throws(() => unseal(bytes, key));
});

test('跨域接口不携带浏览器 Cookie，避免 Unicode Cookie 使请求失败', () => {
  assert.equal(interfaceHeaders(false).Cookie, '');
  assert.equal(interfaceHeaders(true).Origin, 'https://search.bidcenter.com.cn');
});
test('会员与登录标识兼容字符串，字符串 false 不能被当作成功', () => {
  assert.equal(parseSearch({ listData: [], realInfoCount: 0, isFufei: 'true' }).paid, true);
  assert.equal(parseSearch({ listData: [], realInfoCount: 0, isFufei: '1' }).paid, true);
  assert.throws(() => parseSearch({ listData: [], realInfoCount: 0, isLogin: 'false' }), (e: any) => e.kind === 'LOGIN_REQUIRED');
  assert.throws(() => unwrapPayload({ ret: '0', other2: {} }), SiteError);
});
