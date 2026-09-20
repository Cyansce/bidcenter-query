import { createDecipheriv } from 'node:crypto';

export type FailureKind = 'LOGIN_REQUIRED' | 'HUMAN_REQUIRED' | 'PERMISSION_REQUIRED' | 'TRANSIENT' | 'PROTOCOL_CHANGED';
export class SiteError extends Error {
  constructor(public readonly kind: FailureKind, message: string) { super(message); }
}
export const siteTrue = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
export const siteFalse = (value: unknown) => value === false || value === 0 || value === '0' || value === 'false';
// Public frontend transport encoding, observed in searchv17.js and app.707527bf.js.
// This only decodes the response delivered to the authenticated account.
export function decodePayload(text: string): Record<string, any> {
  try {
    const input = text.trim();
    if (/^[{[]/.test(input)) return JSON.parse(input);
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(input)) throw new Error();
    const bytes = Buffer.from(input, 'base64');
    if (!bytes.length || bytes.length % 16) throw new Error();
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from('3zKzyf6eEfuDjAG3'), Buffer.from('fyUANZ0qSNZhhNCV'));
    decipher.setAutoPadding(false);
    const decoded = Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8').replace(/\0+$/, '');
    return JSON.parse(decoded);
  } catch { throw new SiteError('PROTOCOL_CHANGED', '响应格式或编码已变化，请检查网站接口'); }
}
export function unwrapPayload(envelope: Record<string, any>): Record<string, any> {
  if (Number(envelope.other) === -100 || [-1, -100, 400].includes(Number(envelope.retbs))) {
    throw new SiteError('LOGIN_REQUIRED', '采招网登录态已过期，请重新登录');
  }
  if ([999, 998].includes(Number(envelope.retbs))) throw new SiteError('HUMAN_REQUIRED', '采招网要求人工验证，请在登录浏览器中处理');
  if (!siteTrue(envelope.ret)) {
    const msg = String(envelope.msg || '');
    if (/登录|登陆/.test(msg)) throw new SiteError('LOGIN_REQUIRED', '采招网要求重新登录');
    if (/验证|频繁|风险|访问异常/.test(msg)) throw new SiteError('HUMAN_REQUIRED', '采招网要求人工验证');
    if (/权限|会员|付费|次数|额度/.test(msg)) throw new SiteError('PERMISSION_REQUIRED', '当前账户权限或访问额度不足');
    throw new SiteError('PROTOCOL_CHANGED', `采招网返回未识别业务状态 ${Number(envelope.retbs) || 0}`);
  }
  const result = envelope.other2;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SiteError('PROTOCOL_CHANGED', '接口 other2 数据结构变化');
  return result;
}
export function searchForm(query: string, page: number, token: string, guid: string, tag = 0) {
  return {
    from: '6137', location: '6138', guid, token, next_token: '',
    // The original jQuery code encodeURIComponent()s keywords before form serialization.
    keywords: encodeURIComponent(query), time: '7', type: '1,2',
    tag: String(tag), mod: '0', page: String(page), vtime: String(Date.now()),
  };
}
export interface SearchItem {
  [field: string]: unknown;
  news_id: string | number; news_title_show: string; news_type: number;
  news_star_time_show: string; news_diqustr?: string; news_url?: string;
  news_zbje_show?: string; news_cgfs?: string; news_end_time_show?: string;
}
export function parseSearch(result: Record<string, any>) {
  if (siteFalse(result.isLogin) || siteFalse(result.islogin)) throw new SiteError('LOGIN_REQUIRED', '查询接口要求登录');
  const list = result.listData;
  const total = Number(result.realInfoCount ?? result.showInfoCount);
  if (!Number.isFinite(total) || total < 0) throw new SiteError('PROTOCOL_CHANGED', '搜索结果缺少可靠的总数');
  if (list === undefined || list === null) {
    if (total === 0) return { items: [] as SearchItem[], total, accessibleTotal: 0, paid: false };
    throw new SiteError('PERMISSION_REQUIRED', '有检索结果但服务器没有返回可访问列表');
  }
  if (!Array.isArray(list) || list.some(x => !x.news_id || !x.news_title_show || !x.news_star_time_show || !x.news_type)) {
    throw new SiteError('PROTOCOL_CHANGED', '搜索列表字段变化');
  }
  const paid = siteTrue(result.isFufei);
  const showCount = Number(result.showInfoCount ?? total);
  return { items: list as SearchItem[], total, accessibleTotal: Math.min(total, Number.isFinite(showCount) ? showCount : total), paid };
}
export function detailUrl(id: string, query = '') {
  return `https://user.bidcenter.com.cn/v2023/#/des/customDesSearch/${encodeURIComponent(id)}?mod=0&type=1,2&tag=0&keywords=${encodeURIComponent(query)}`;
}

// The original cross-origin jQuery/axios requests authenticate with form Token,
// and do not opt into credentials. Omit browser cookies (some include Unicode).
export function interfaceHeaders(search: boolean) {
  return { Cookie: '', Origin: search ? 'https://search.bidcenter.com.cn' : 'https://user.bidcenter.com.cn',
    Referer: search ? 'https://search.bidcenter.com.cn/' : 'https://user.bidcenter.com.cn/v2023/' };
}
