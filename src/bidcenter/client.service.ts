import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { APIResponse } from 'playwright';
import { SessionService } from '../auth/session.service';
import { config } from '../config';
import { decodePayload, unwrapPayload, parseSearch, searchForm, interfaceHeaders, SiteError, siteFalse } from './protocol';
import { RequestPacer, retryAfterMs } from './request-pacer';

@Injectable()
export class BidcenterClient implements OnModuleDestroy {
  private chain = Promise.resolve();
  private readonly pacer = new RequestPacer({ path: join(config.dataDir, 'request-pacing.json'),
    minInterval: config.requestInterval, maxInterval: config.requestMaxInterval, batchSize: config.requestBatchSize,
    breakMin: config.requestBreakMin, breakMax: config.requestBreakMax, cooldown: config.rateLimitCooldown, retryBase: config.requestRetryBase });
  constructor(private readonly sessions: SessionService) {}
  private async post(path: string, parameters: Record<string, string | number>, search = false, verify = false, manualVerification = false) {
    // List, detail, login checks and concurrent callers all share the same queue and pacing.
    const before = this.chain;
    let release!: () => void;
    this.chain = new Promise(resolve => { release = resolve; });
    await before;
    try {
      await this.pacer.beforeRequest(manualVerification);
      let response: APIResponse | undefined;
      let serverDelay = 0;
      try {
        const api = await this.sessions.context();
        const credentials = await this.sessions.credentials(api);
        const form = { from: search ? '6137' : '4037', location: search ? '6138' : '7928', ...parameters, ...credentials };
        try {
          response = await api.post(`https://interface.bidcenter.com.cn${path}`, {
            form, maxRedirects: 0, timeout: config.requestTimeout, headers: interfaceHeaders(search),
          });
        } catch { throw new SiteError('TRANSIENT', '采招网网络请求超时或失败，已暂停并延后重试'); }
        serverDelay = retryAfterMs(response.headers()['retry-after']);
        const status = response.status();
        if (status === 401) throw new SiteError('LOGIN_REQUIRED', '采招网会话失效');
        if (status === 403 || (status >= 300 && status < 400)) {
          const location = response.headers().location || '';
          if (/sso\.bidcenter\.com\.cn.*(?:login|validate)/i.test(location)) throw new SiteError('LOGIN_REQUIRED', '采招网要求重新登录');
          throw new SiteError('HUMAN_REQUIRED', '采招网拦截了请求，请在浏览器完成验证');
        }
        if (status === 429) throw new SiteError('COOLDOWN', '采招网限制访问频率，已暂停全部采集，冷却后从断点继续');
        if (status >= 500) throw new SiteError('TRANSIENT', '采招网服务暂时不可用，已暂停并延后重试');
        if (status !== 200) throw new SiteError('PROTOCOL_CHANGED', `接口返回 HTTP ${status}`);
        const text = await response.text();
        if (/HumanMachineVerification|人机验证|aliyunCaptcha|<html/i.test(text.slice(0, 5000))) throw new SiteError('HUMAN_REQUIRED', '接口返回验证页面，需要人工处理');
        const data = unwrapPayload(decodePayload(text));
        if (verify && (siteFalse(data.isLogin) || siteFalse(data.islogin))) throw new SiteError('LOGIN_REQUIRED', '采招网返回未登录状态');
        await this.sessions.persist();
        await this.pacer.succeeded();
        if (manualVerification) await this.pacer.confirmHumanVerification();
        return data;
      } catch (error) {
        if (error instanceof SiteError) throw await this.pacer.failed(error, serverDelay);
        throw error;
      } finally {
        await response?.dispose();
        await this.pacer.afterRequest();
      }
    } finally { release(); }
  }
  async search(query: string, page: number) {
    // Resolve credentials in the queue, after waiting, so a newly saved member session wins.
    return parseSearch(await this.post('/search/GetSearchProHandler.ashx', searchForm(query, page, '', '', config.searchTag), true));
  }
  async detail(id: string) {
    return this.post('/zhaobiao/detail.ashx', { location: 7930, id, getjinzhan: 1, gettags: 1, gettj: 1, limitip: 1, getuserinfo: 1, getzbt: 1, isgethetong: 1 });
  }
  async verifySession(manualVerification = false) {
    await this.post('/public/AuthorityHandler.ashx', {}, false, true, manualVerification);
    return true;
  }
  pacingStatus() { return this.pacer.status(); }
  onModuleDestroy() { this.pacer.stop(); }
}
