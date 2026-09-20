import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { SearchItem, SiteError, detailUrl } from './protocol';

export const masked = (value: string) => /\(略\)|（略）|\[略\]|\*|#|权限|会员|保密/.test(value);
export function plain(html: string): string {
  const $ = load(html || '');
  $('script,style,noscript').remove();
  $('br').replaceWith('\n');
  $('p,div,section,tr,h1,h2,h3,h4,h5,li').append('\n');
  $('td,th').append(' ');
  return $.root().text().replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const DATE_SOURCE = '(20\\d{2})[年/.-](\\d{1,2})[月/.-](\\d{1,2})日?(?:[T\\s]*(\\d{1,2})[:：时](\\d{1,2})?(?:[:：分](\\d{1,2}))?秒?)?';
export function parseDate(raw: string | undefined | null, dateOnlyEnd = false): Date | null {
  if (!raw || masked(raw)) return null;
  const match = raw.match(new RegExp(DATE_SOURCE));
  if (!match) return null;
  const [, y, m, d, h, minute, s] = match;
  const hour = h === undefined ? (dateOnlyEnd ? 23 : 0) : Number(h);
  const min = h === undefined ? (dateOnlyEnd ? 59 : 0) : Number(minute || 0);
  const sec = h === undefined ? (dateOnlyEnd ? 59 : 0) : Number(s || 0);
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31 || hour > 23 || min > 59 || sec > 59) return null;
  const local = new Date(Date.UTC(+y, +m - 1, +d, hour, min, sec));
  if (local.getUTCMonth() !== +m - 1 || local.getUTCDate() !== +d) return null;
  return new Date(local.getTime() - 8 * 3600000);
}
export function dayWindow(now: Date, days: number) {
  const chinaDay = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const endOfDay = new Date(`${chinaDay}T23:59:59.999+08:00`);
  const fromDate = new Date(new Date(`${chinaDay}T00:00:00+08:00`).getTime() - (days - 1) * 86400000);
  return { fromDate, toDate: endOfDay, chinaDay };
}
export function budgetYuan(raw: string | undefined): string | null {
  if (!raw || masked(raw)) return null;
  const clean = raw.replace(/[,，\s￥¥]/g, '');
  const match = clean.match(/(?:预算(?:金额)?(?:[（(]元[）)])?[：:]?)?([0-9]+(?:\.[0-9]+)?)(亿元|万元|元|人民币)/);
  if (!match || /[-~至]/.test(clean)) return null;
  const [whole, decimal = ''] = match[1].split('.');
  const places = match[2] === '亿元' ? 8 : match[2] === '万元' ? 4 : 0;
  const digits = whole + decimal;
  const scale = decimal.length - places;
  if (scale <= 0) return BigInt(digits + '0'.repeat(-scale)).toString();
  const padded = digits.padStart(scale + 1, '0');
  return `${BigInt(padded.slice(0, -scale))}.${padded.slice(-scale)}`.replace(/\.?0+$/, '');
}
export interface DeadlineEvidence { raw: string; precision: 'minute' | 'date'; date: Date }
function deadline(body: string, kind: 'file' | 'bid'): DeadlineEvidence | null {
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  const label = kind === 'file'
    ? /获取(?:招标|采购|竞争性磋商|磋商|谈判|询价)?文件(?:的)?(?:时间|期限)|报名(?:截止|结束|时间|期限)|领取(?:文件|标书)(?:时间|期限)|(?:三[、.．])\s*获取(?:招标|采购|磋商)文件/
    : /(?:提交|递交|接收)?(?:投标|响应|报价)文件(?:的)?截止(?:时间)?|(?:投标|响应|报价)截止(?:时间)?/;
  const candidates: DeadlineEvidence[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!label.test(line) || /询问截止|质疑截止/.test(line)) continue;
    const context = [line];
    // A heading may put its date on the next row; never cross into a different deadline.
    if (!new RegExp(DATE_SOURCE).test(line)) {
      for (const next of lines.slice(index + 1, index + 3)) {
        if (/询问|质疑|地点|售价|方式|联系方式/.test(next)) break;
        context.push(next);
        if (new RegExp(DATE_SOURCE).test(next)) break;
      }
    }
    const raw = context.join(' ');
    const matches = [...raw.matchAll(new RegExp(DATE_SOURCE, 'g'))];
    // File acquisition ranges end at the last date. Bid clauses should have exactly one date.
    const last = kind === 'file' ? matches.at(-1) : matches.length === 1 ? matches[0] : null;
    if (!last) continue;
    const date = parseDate(last[0], true);
    if (date) candidates.push({ raw: raw.slice(0, 700), date, precision: last[4] ? 'minute' : 'date' });
  }
  // Prefer a precise value; conflicting precise dates stay unknown for manual review.
  const precise = candidates.filter(x => x.precision === 'minute');
  const choices = precise.length ? precise : candidates;
  return new Set(choices.map(x => x.date.toISOString())).size === 1 ? choices[0] : null;
}
export function contacts(body: string) {
  const lines = body.split('\n');
  const contactStart = lines.findIndex(s => /联系人及联系方式|采购人信息|采购代理机构信息|联系(?:人|方式)|按以下方式联系/.test(s));
  if (contactStart < 0) return [];
  return lines.slice(contactStart).filter(line => /联系人|联\s*系\s*人|联系方式|联系电话|电\s*话|邮箱|电子邮件/.test(line))
    .filter(line => !/政采云|服务热线|CA问题|汇信CA|天谷CA|技术支持|客服/.test(line))
    .map(raw => ({ raw: raw.trim().slice(0, 600), masked: masked(raw),
      phone: masked(raw) ? null : raw.match(/(?:1[3-9]\d{9}|0\d{2,3}[-— ]?\d{7,8})/)?.[0] || null,
      email: masked(raw) ? null : raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] || null,
    })).filter(x => x.raw);
}
export function relevance(title: string, body: string): string {
  const hardware = /服务器|计算机|电脑|GPU|CPU|算力|人工智能|计算工作站|图形工作站|存储设备|信息化|IT设备|处理器|AI应用|芯片/i;
  if (hardware.test(title)) return 'RELATED';
  if (/社工站|人才工作站|专家工作站|院士工作站|村级工作站|社区工作站/.test(title) && !hardware.test(body)) return 'UNRELATED';
  if (/昇腾|鲲鹏|工作站/.test(title) && hardware.test(body)) return 'RELATED';
  return 'REVIEW';
}
export function followUp(noticeType: number, file: Date | null, bid: Date | null, body: string, now = new Date()) {
  if (/本项目(?:已)?(?:终止|取消|废标|流标)/.test(body)) return 'CANCELLED';
  if ((file && file < now) || (bid && bid < now)) return 'EXPIRED';
  if (noticeType === 2) return 'PREVIEW';
  return file || bid ? 'OPEN' : 'UNKNOWN';
}
export function normalizeSearch(item: SearchItem, query: string) {
  const publishedAt = parseDate(item.news_star_time_show);
  if (!publishedAt) throw new SiteError('PROTOCOL_CHANGED', '列表发布时间无法解析');
  return { sourceId: String(item.news_id), sourceUrl: detailUrl(String(item.news_id), query),
    title: plain(item.news_title_show), region: item.news_diqustr || '', noticeType: Number(item.news_type), publishedAt,
    budgetRaw: item.news_zbje_show || null, budgetYuan: budgetYuan(item.news_zbje_show),
    procurementMethod: item.news_cgfs || null,
    listedDeadlineRaw: Number(item.news_type) === 2 ? null : item.news_end_time_show || null,
    expectedPurchaseRaw: Number(item.news_type) === 2 ? item.news_end_time_show || null : null,
  };
}
export function normalizeDetail(id: string, detail: Record<string, any>, fallback: ReturnType<typeof normalizeSearch>, now = new Date()) {
  if (String(detail.id) !== id || !detail.title || typeof detail.content !== 'string') throw new SiteError('PROTOCOL_CHANGED', '详情标识或正文结构不匹配');
  if (detail.isLogin === false || detail.isLogin === 0) throw new SiteError('LOGIN_REQUIRED', '详情需要登录');
  const bodyHtml = detail.content;
  const bodyText = plain(bodyHtml).split(/温馨提示[：:]本招标项目仅供付费会员查阅/)[0].trim();
  const file = deadline(bodyText, 'file');
  const bid = deadline(bodyText, 'bid');
  const budgetLine = bodyText.split('\n').find(s => /预算金额|采购预算|项目预算/.test(s) && /\d/.test(s));
  const title = plain(detail.title);
  const bodyBudget = budgetYuan(budgetLine);
  const raw = bodyBudget ? budgetLine : fallback.budgetRaw || (detail.zhaobJine ? String(detail.zhaobJine) : null) || budgetLine || null;
  const numberMatch = bodyText.match(/项目编号[：:]\s*([^\n]{2,100})/);
  const projectNumber = numberMatch && !masked(numberMatch[1]) ? numberMatch[1].trim() : null;
  const region = [detail.diqu, detail.diqucity].filter(Boolean).join(' | ') || fallback.region;
  const buyer = detail.yezhu || null;
  const type = Number(detail.type || fallback.noticeType);
  const value = { title, region, noticeType: type, publishedAt: parseDate(detail.showTime) || fallback.publishedAt,
    budgetRaw: raw, budgetYuan: bodyBudget || fallback.budgetYuan || budgetYuan(raw || undefined),
    procurementMethod: detail.zhaobFangshi || fallback.procurementMethod,
    fileDeadline: file?.date || null, bidDeadline: bid?.date || null,
    deadlineEvidence: JSON.stringify({ file, bid, listed: fallback.listedDeadlineRaw, budgetSource: bodyBudget ? 'body' : 'list-or-detail', dateOnlyPolicy: '按北京时间当日23:59:59存储，精度为date' }),
    bodyHtml, bodyText, contactsJson: JSON.stringify(contacts(bodyText)), buyer, agency: detail.daili || null, projectNumber,
    relevance: relevance(title, bodyText), followUpStatus: followUp(type, file?.date || null, bid?.date || null, bodyText, now),
    accessLevel: detail.isAllow === true || detail.isAllow === 1 ? 'FULL' : 'RESTRICTED',
    detailStatus: 'COMPLETE', detailError: null,
    duplicateGroup: projectNumber && buyer && !masked(buyer) ? createHash('sha256').update(`${projectNumber}|${buyer}|${region}|${type}`).digest('hex') : null,
  };
  return { ...value, contentHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), detailFetchedAt: now };
}
