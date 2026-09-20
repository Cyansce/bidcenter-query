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
test('会员正文保留多电话、分机、跨行邮箱、单位、附件和进展，业务快照剔除账户字段', () => {
  const value = normalizeDetail('100', { id: 100, title: '服务器采购', isLogin: '1', isAllow: 'true',
    content: '<p>采购人信息名称：测试采购单位</p><p>联系方式：010-12345678-123，13800138000</p><p>采购代理机构信息名称：测试代理公司</p><p>邮箱：</p><p>bid@example.com</p><p>需签订保密协议，设备2*3配置</p><a href="//www.bidcenter.com.cn/link?target=https%3A%2F%2Ffiles.example.com%2Ffile%3FaccessCode%3Dabc">采购需求.docx</a>',
    yezhuLxr: '李工', yezhuTel: '13900139000', xiazailist: [{ filename: '采购文件', userfujianurl: 'https://files.example.com/a.pdf' }],
    jinzhanlist: [{ title: '采购意向', id: 99 }], tagslist: [{ key: '服务器' }], pdf_url: 'https://files.example.com/notice.pdf',
    user_mail: 'private@example.com', yzsecretkey: 'secret', userinfo: { token: 'secret' }, guanggao: [{ phone: '4008109688' }],
    zhaobJine: '1.34百万元', customBusinessField: { value: '应保留', token: 'secret' },
  }, base);
  assert.equal(value.accessLevel, 'FULL'); assert.equal(value.budgetYuan, '1340000');
  assert.equal(value.buyer, '测试采购单位'); assert.equal(value.agency, '测试代理公司');
  const people = JSON.parse(value.contactsJson);
  assert.deepEqual(people.find((x: any) => x.phone === '010-12345678-123').phones, ['010-12345678-123', '13800138000']);
  assert.ok(people.some((x: any) => x.email === 'bid@example.com'));
  assert.ok(people.some((x: any) => x.phone === '13900139000' && x.source !== 'body'));
  assert.equal(JSON.parse(value.attachmentsJson).length, 2);
  assert.equal(JSON.parse(value.timelineJson)[0].id, 99); assert.equal(JSON.parse(value.tagsJson)[0].key, '服务器');
  assert.ok(!value.detailDataJson.includes('secret')); assert.ok(!value.detailDataJson.includes('private@example.com'));
  assert.equal(JSON.parse(value.detailDataJson).customBusinessField.value, '应保留');
});
test('会员公告每日文件领取结束时间及响应文件提交截止可解析', () => {
  const value = detail('<p>三、获取采购文件时间：2026年09月20日至2026年09月28日，每天上午08:30:00至11:30:00，下午14:00:00至17:30:00</p><p>四、响应文件提交截止时间：2026年10月10日 14时30分00秒</p>');
  assert.equal(value.fileDeadline?.toISOString(), '2026-09-28T09:30:00.000Z');
  assert.equal(value.bidDeadline?.toISOString(), '2026-10-10T06:30:00.000Z');
});
test('付费标记不掩盖正文遮盖，部分电话遮盖不丢弃同一行的完整电话', () => {
  const value = normalizeDetail('100', { id: 100, title: '服务器采购', content: '<p>联系电话：010-********，13800138000</p>', isLogin: true, isAllow: true }, base);
  assert.equal(value.accessLevel, 'RESTRICTED'); assert.equal(JSON.parse(value.contactsJson)[0].phone, '13800138000');
});
