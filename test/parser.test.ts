import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetYuan, dayWindow, normalizeDetail, normalizeSearch, parseDate, followUp } from '../src/bidcenter/parser';
const base = normalizeSearch({ news_id: 100, news_title_show: '服务器采购', news_type: 1, news_star_time_show: '2026-09-12', news_zbje_show: '95万元', news_end_time_show: '2026-09-22' }, '服务器');
const detail = (content: string) => normalizeDetail('100', { id: 100, title: '服务器采购', content, isLogin: true, isAllow: false }, base, new Date('2026-09-13T00:00:00Z'));
test('日期使用北京时间，日期精度和明确零点不混淆', () => {
  assert.equal(parseDate('2026年09月17日 00:00', true)?.toISOString(), '2026-09-16T16:00:00.000Z');
  assert.equal(parseDate('2026-09-17', true)?.toISOString(), '2026-09-17T15:59:59.000Z');
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('1900-01-01'), null);
  const window = dayWindow(new Date('2026-09-12T20:00:00Z'), 7);
  assert.equal(window.chinaDay, '2026-09-13');
  assert.equal(window.fromDate.toISOString(), '2026-09-06T16:00:00.000Z');
});
test('分别识别报名范围、询问和投标截止，不能把列表日期当投标截止', () => {
  const value = detail('<p>报名时间：2026年09月11日 17:30 至 2026年09月18日 17:30</p><p>询问截止时间：2026年09月22日 17:30</p><p>响应文件截止时间：2026年09月29日 10:00</p>');
  assert.equal(value.fileDeadline?.toISOString(), '2026-09-18T09:30:00.000Z');
  assert.equal(value.bidDeadline?.toISOString(), '2026-09-29T02:00:00.000Z');
  assert.equal(detail('<p>详情见附件</p>').bidDeadline, null);
});
test('正文跨行日期及互相矛盾的日期需要保守处理', () => {
  const value = detail('<h3>三、获取招标文件</h3><p>时间：2026年09月14日至2026年09月18日</p><p>响应文件截止时间：2026年10月10日 09:00</p>');
  assert.equal(value.fileDeadline?.toISOString(), '2026-09-18T15:59:59.000Z');
  assert.equal(detail('<p>投标截止时间：2026-09-18 10:00</p><p>投标截止时间：2026-09-19 10:00</p>').bidDeadline, null);
});
test('金额精确换算且不推测掩码，项目联系人排除网站会员客服', () => {
  assert.equal(budgetYuan('采购预算：95.123456万元'), '951234.56');
  assert.equal(budgetYuan('95.(略)万元'), null);
  assert.equal(budgetYuan('1-2万元'), null);
  const value = detail('<p>预算金额：95.(略)万元</p><p>项目联系人：张工</p><p>联系电话：010-(略)</p><p>温馨提示：本招标项目仅供付费会员查阅</p><p>联系人：郝工</p><p>电话：010-68960698</p>');
  assert.equal(value.budgetYuan, '950000'); // publicly visible list value, marked as list evidence
  assert.equal(value.accessLevel, 'RESTRICTED');
  assert.ok(!value.contactsJson.includes('郝工'));
  assert.ok(!value.contactsJson.includes('68960698'));
  assert.ok(value.contactsJson.includes('张工'));
});
test('报名已截止即不可新跟进，预告无截止不伪造日期', () => {
  assert.equal(followUp(1, new Date('2026-09-10'), new Date('2026-09-30'), '', new Date('2026-09-13')), 'EXPIRED');
  assert.equal(followUp(2, null, null, ''), 'PREVIEW');
  assert.equal(followUp(1, null, null, ''), 'UNKNOWN');
});
