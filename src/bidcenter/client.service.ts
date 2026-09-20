import { Injectable } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionService } from '../auth/session.service';
import { config } from '../config';
import { decodePayload, unwrapPayload, parseSearch, searchForm, interfaceHeaders, SiteError, siteFalse } from './protocol';

@Injectable()
export class BidcenterClient {
  private chain = Promise.resolve();
  private nextRequest = 0;
  constructor(private readonly sessions: SessionService) {}
  private async post(path: string, parameters: Record<string, string | number>, search = false, persist = true) {
    // All API calls (including login verification) share this queue and rate limit.
    const before = this.chain;
    let release!: () => void;
    this.chain = new Promise(resolve => { release = resolve; });
    await before;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await delay(Math.max(0, this.nextRequest - Date.now()));
        this.nextRequest = Date.now() + config.requestInterval;
        const api = await this.sessions.context();
        const credentials = await this.sessions.credentials(api);
        const form = { from: search ? '6137' : '4037', location: search ? '6138' : '7928', ...credentials, ...parameters };
        let response;
        try {
          response = await api.post(`https://interface.bidcenter.com.cn${path}`, {
            form, maxRedirects: 0, timeout: config.requestTimeout,
            headers: interfaceHeaders(search),
          });
        } catch {
          if (attempt < 2) { await delay(2000 * 2 ** attempt); continue; }
          throw new SiteError('TRANSIENT', '采招网网络请求超时或失败');
        }
        try {
          const status = response.status();
          if (status === 401) throw new SiteError('LOGIN_REQUIRED', '采招网会话失效');
          if (status === 403 || (status >= 300 && status < 400)) {
            const location = response.headers().location || '';
            if (/sso\.bidcenter\.com\.cn.*(?:login|validate)/i.test(location)) throw new SiteError('LOGIN_REQUIRED', '采招网要求重新登录');
            throw new SiteError('HUMAN_REQUIRED', '采招网拦截了请求，请在浏览器完成验证');
          }
          if (status === 429) throw new SiteError('HUMAN_REQUIRED', '采招网限制访问频率，采集已暂停，请稍后人工恢复');
          if (status >= 500) {
            if (attempt < 2) { await delay(2000 * 2 ** attempt); continue; }
            throw new SiteError('TRANSIENT', '采招网服务暂时不可用');
          }
          if (status !== 200) throw new SiteError('PROTOCOL_CHANGED', `接口返回 HTTP ${status}`);
          const text = await response.text();
          if (/HumanMachineVerification|人机验证|aliyunCaptcha|<html/i.test(text.slice(0, 5000))) throw new SiteError('HUMAN_REQUIRED', '接口返回验证页面，需要人工处理');
          const data = unwrapPayload(decodePayload(text));
          if (persist) await this.sessions.persist();
          return data;
        } finally { await response.dispose(); }
      }
      throw new SiteError('TRANSIENT', '请求重试已耗尽');
    } finally { release(); }
  }
  async search(query: string, page: number) {
    const credentials = await this.sessions.credentials();
    return parseSearch(await this.post('/search/GetSearchProHandler.ashx', searchForm(query, page, credentials.token, credentials.guid, config.searchTag), true));
  }
  async detail(id: string) {
    return this.post('/zhaobiao/detail.ashx', { location: 7930, id, getjinzhan: 1, gettags: 1, gettj: 1, limitip: 1, getuserinfo: 1, getzbt: 1, isgethetong: 1 });
  }
  async verifySession() {
    const result = await this.post('/public/AuthorityHandler.ashx', {}, false, false);
    if (siteFalse(result.isLogin) || siteFalse(result.islogin)) throw new SiteError('LOGIN_REQUIRED', '采招网返回未登录状态');
    await this.sessions.persist();
    return true;
  }
}
