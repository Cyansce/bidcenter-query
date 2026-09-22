import { BadRequestException, ConflictException, HttpException, Injectable, OnApplicationShutdown, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ManualChromeService } from './manual-chrome.service';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { config } from '../config';
import { SessionService, sessionCredentials } from './session.service';
import { hasChallenge, isSitePage, observeBrowser, sessionFingerprint } from './browser-state';
import { BidcenterClient } from '../bidcenter/client.service';
import { NotificationsService } from '../common/notifications.service';
import { challengePageUrl, SiteError } from '../bidcenter/protocol';

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private browser?: Browser;
  private browserContext?: BrowserContext;
  private page?: Page;
  private busy = false;
  private state = 'UNKNOWN';
  private message = '首次采集前请登录';
  private method: 'sms' | 'password' = config.loginMethod;
  private lastSmsAt = 0;
  private blocked = false;
  private monitor?: NodeJS.Timeout;
  private monitoring?: Promise<boolean>;
  private stopping = false;
  private lastFingerprint = '';
  private sawChallenge = false;
  private nextCheckAt = 0;
  private challengePrompted = false;
  private promptPending = false;
  private challengeUrl?: string;
  constructor(private readonly sessions: SessionService, private readonly client: BidcenterClient, private readonly notifications: NotificationsService, private readonly manual: ManualChromeService) {}
  onModuleInit() {
    this.monitor = setInterval(() => { void this.syncBrowserSession(); }, 2000);
    this.monitor.unref();
  }
  private browserOpen() { return !!this.manual?.isOpen || (!!this.page && !this.page.isClosed()); }
  async status() {
    if (this.state === 'UNKNOWN') {
      const saved = await this.sessions.exists();
      this.state = saved ? 'SESSION_SAVED' : 'LOGIN_REQUIRED';
      if (saved) this.message = '已载入加密会话，采集前会验证有效性';
    }
    return { state: this.state, message: this.message, method: this.method, phone: config.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
      ...await this.sessions.identity(), browserMode: config.loginBrowserMode, browserOpen: this.browserOpen(), blocked: this.blocked,
      autoDetect: true };
  }
  isBlocked() { return this.blocked; }
  async requireAction(error: SiteError) {
    if (!['LOGIN_REQUIRED', 'HUMAN_REQUIRED'].includes(error.kind)) return;
    this.blocked = true; this.state = error.kind; this.message = error.message;
    if (error.challengeUrl) this.challengeUrl = challengePageUrl(error.challengeUrl);
    await this.notifications.notify(error.kind, `${error.message}。管理页 http://127.0.0.1:${config.port}`);
    if (error.kind === 'HUMAN_REQUIRED' && !this.challengePrompted) {
      this.promptPending = true;
      if (!this.busy) await this.promptChallenge();
    }
  }
  private async promptChallenge() {
    if (!this.promptPending || this.stopping) return;
    this.promptPending = false; this.challengePrompted = true;
    try { await this.openChallenge(); }
    catch {
      this.state = 'HUMAN_REQUIRED';
      this.message = '需要人工验证，但验证窗口未能打开；请检查桌面环境并点击“打开验证页面”重试';
      await this.notifications.notify('BROWSER_REQUIRED', this.message);
    }
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw new ConflictException('登录操作正在进行，请稍后');
    this.busy = true;
    try { return await fn(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof SiteError) {
        this.nextCheckAt = error.retryAt?.getTime() || 0;
        this.state = error.kind; this.message = error.message;
        await this.requireAction(error);
        throw new BadRequestException(error.message);
      }
      this.state = 'LOGIN_ACTION_REQUIRED';
      this.message = '浏览器操作未完成，请检查登录窗口；若窗口未打开，请安装 Chromium 并确认桌面环境可用';
      // Playwright errors can include form values. Never forward or log the raw exception.
      throw new BadRequestException(this.message);
    } finally {
      this.busy = false;
      if (this.promptPending) await this.promptChallenge().catch(() => {});
    }
  }
  private async openBrowser() {
    if (!this.browser?.isConnected()) {
      // Login and challenges are interactive; the operator must be able to see the window.
      this.browser = await chromium.launch({ headless: false, channel: config.browserChannel });
      this.browserContext = await this.browser.newContext({ storageState: await this.sessions.load() });
    }
    if (!this.page || this.page.isClosed()) this.page = await this.browserContext!.newPage();
    this.page.setDefaultTimeout(15000);
    return this.page;
  }
  async start(method?: 'sms' | 'password') {
    return this.exclusive(async () => {
      this.method = method || config.loginMethod;
      this.blocked = true;
      this.lastFingerprint = ''; this.nextCheckAt = 0; this.sawChallenge = false; this.challengePrompted = false;
      if (config.loginBrowserMode === 'chrome-manual') {
        await this.manual.open('https://sso.bidcenter.com.cn/login/');
        this.state = 'MANUAL_LOGIN';
        this.message = '请在打开的 Chrome 中登录；程序会自动识别登录状态并继续采集';
        return this.status();
      }
      const page = await this.openBrowser();
      await page.goto('https://sso.bidcenter.com.cn/login/', { waitUntil: 'domcontentloaded', timeout: config.requestTimeout });
      if (await this.acceptBrowserState()) return this.status();
      if (await hasChallenge(page)) {
        this.sawChallenge = true; this.state = 'HUMAN_REQUIRED';
        this.message = '请在登录窗口完成网站验证；完成后自动继续';
        return this.status();
      }
      if (this.method === 'sms' && await page.locator('.login-tab .tab_yzm').isVisible()) {
        await page.locator('.login-tab .tab_yzm').click();
        if (config.phone) await page.locator('#codeLogin_phone').fill(config.phone);
        this.state = 'READY_TO_SEND_SMS'; this.message = '请在登录窗口完成短信登录；成功后自动继续，无需回到管理页确认';
      } else if (this.method === 'password' && await page.locator('.login-tab li[type="0"]').isVisible()) {
        await page.locator('.login-tab li[type="0"]').click();
        if (config.username) await page.locator('#txtusername').fill(config.username);
        if (config.password) await page.locator('#txtpassword').fill(config.password);
        this.state = 'PASSWORD_READY'; this.message = '请在登录窗口点击登录；程序按实际登录状态自动继续，不要求固定的验证步骤';
      } else {
        this.state = 'MANUAL_LOGIN'; this.message = '请在浏览器中完成登录；程序正在自动检查登录状态';
      }
      await this.notifications.notify('LOGIN_ACTION', this.message);
      return this.status();
    });
  }
  async sendSms() {
    return this.exclusive(async () => {
      this.requireAutomatedMode();
      if (!this.page || this.page.isClosed() || this.method !== 'sms') throw new BadRequestException('请先打开短信登录');
      if (Date.now() - this.lastSmsAt < 60000) throw new ConflictException('60 秒内不能重复发送验证码');
      this.lastSmsAt = Date.now();
      await this.page.locator('#codeLogin_btn').click();
      this.state = 'WAITING_SMS_OR_CAPTCHA';
      this.message = '请在登录浏览器完成网站验证；收到短信后，在管理页输入验证码。程序不会自动重发短信';
      await this.notifications.notify('SMS_REQUIRED', this.message);
      return this.status();
    });
  }
  private requireAutomatedMode() {
    if (config.loginBrowserMode === 'chrome-manual') throw new BadRequestException('请在 Chrome 窗口完成登录，程序会自动识别并继续采集');
  }
  private async checkChallenge() {
    if (this.page && await this.page.locator('#aliyunCaptcha-mask').isVisible()) {
      this.state = 'HUMAN_REQUIRED';
      this.message = '网站验证弹层仍然打开，请先在登录浏览器完成人机验证，再提交登录';
      throw new BadRequestException(this.message);
    }
  }
  async submitCode(code: string) {
    return this.exclusive(async () => {
      this.requireAutomatedMode();
      if (!/^\d{4,6}$/.test(code)) throw new BadRequestException('验证码必须为 4—6 位数字');
      if (!this.page || this.page.isClosed() || this.method !== 'sms') throw new BadRequestException('请先启动短信登录');
      await this.checkChallenge();
      await this.page.locator('#codeLogin_code').fill(code);
      await this.page.locator('a[onclick="codeLogin_Click();"]').click();
      this.state = 'VERIFYING'; this.message = '验证码已提交；正在自动检查登录状态';
      return this.status();
    });
  }
  async submitPassword() {
    return this.exclusive(async () => {
      this.requireAutomatedMode();
      if (!this.page || this.page.isClosed() || this.method !== 'password') throw new BadRequestException('请先打开账号登录');
      await this.checkChallenge();
      await this.page.locator('#login_login_btn').click();
      this.state = 'VERIFYING'; this.message = '已提交账号登录；登录成功后自动继续，网页要求额外验证时再处理即可';
      return this.status();
    });
  }
  async openChallenge() {
    return this.exclusive(async () => {
      this.blocked = true;
      this.challengePrompted = true;
      let context: BrowserContext;
      let page: Page;
      if (config.loginBrowserMode === 'chrome-manual') {
        const wasOpen = this.manual.isOpen;
        if (!wasOpen) await this.manual.open('about:blank');
        context = await this.manual.attach();
        if (!wasOpen) {
          const saved = await this.sessions.load();
          if (saved) await context.addCookies(saved.cookies);
        }
        page = context.pages().find(isSitePage) || context.pages()[0] || await context.newPage();
      } else {
        page = await this.openBrowser(); context = this.browserContext!;
      }
      this.lastFingerprint = sessionFingerprint(await context.storageState());
      this.nextCheckAt = 0;
      // Preserve an existing challenge; navigating again would discard the user's progress.
      if (!await hasChallenge(page)) await page.goto(this.challengeUrl || 'https://search.bidcenter.com.cn/', { waitUntil: 'domcontentloaded', timeout: config.requestTimeout });
      this.sawChallenge = await hasChallenge(page);
      await page.bringToFront();
      this.state = 'HUMAN_REQUIRED'; this.message = '验证页面已打开，请在浏览器完成验证；程序检测通过后会自动续跑';
      return this.status();
    });
  }
  private async browserSession() {
    if (config.loginBrowserMode === 'chrome-manual') return this.manual.isOpen ? this.manual.attach() : undefined;
    return this.browserContext;
  }
  private async acceptBrowserState(force = false): Promise<boolean> {
    const context = await this.browserSession();
    if (!context) return false;
    const observation = await observeBrowser(context);
    if (!observation) return false;
    const { page, state, fingerprint, challengeVisible, loginVisible } = observation;
    if (challengeVisible) {
      this.sawChallenge = true; this.state = 'HUMAN_REQUIRED';
      this.message = '请在已打开的浏览器完成验证，完成后自动继续';
      return false;
    }
    if (loginVisible) return false;
    try { sessionCredentials(state); }
    catch (error) {
      if (error instanceof SiteError) { this.state = error.kind; this.message = error.message; return false; }
      throw error;
    }
    const retryDue = this.nextCheckAt > 0 && Date.now() >= this.nextCheckAt;
    if (Date.now() < this.nextCheckAt || (!force && fingerprint === this.lastFingerprint && !this.sawChallenge && !retryDue)) return false;
    this.lastFingerprint = fingerprint; this.sawChallenge = false; this.nextCheckAt = 0;
    const userAgent = await page.evaluate(() => navigator.userAgent);
    await this.client.verifyBrowserSession(state, userAgent);
    await this.authenticated();
    return true;
  }
  private async authenticated() {
    this.state = 'AUTHENTICATED'; this.message = '已登录，采集可自动执行'; this.blocked = false;
    this.challengePrompted = false; this.promptPending = false; this.nextCheckAt = 0;
    this.challengeUrl = undefined;
    await this.manual.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = undefined; this.browserContext = undefined; this.page = undefined;
  }
  syncBrowserSession(): Promise<boolean> {
    if (this.stopping || this.busy || !this.blocked || !this.browserOpen()) return Promise.resolve(false);
    this.busy = true;
    this.monitoring = (async () => {
      try { return await this.acceptBrowserState(); }
      catch (error) {
        if (error instanceof SiteError) {
          this.nextCheckAt = error.retryAt?.getTime() || 0;
          this.state = error.kind; this.message = error.message;
          await this.requireAction(error);
        } else {
          this.lastFingerprint = '';
          this.message = '自动检查暂未完成，请确认登录窗口仍打开；也可点击“重新检查登录”';
        }
        return false;
      } finally { this.busy = false; }
    })().catch(() => false).finally(async () => {
      this.monitoring = undefined;
      if (this.promptPending) await this.promptChallenge().catch(() => {});
    });
    return this.monitoring;
  }
  async complete() {
    return this.exclusive(async () => {
      try {
        if (this.browserOpen()) await this.acceptBrowserState(true);
        else { await this.client.verifySession(true); await this.authenticated(); }
        return this.status();
      } catch (error) {
        if (error instanceof SiteError) {
          this.nextCheckAt = error.retryAt?.getTime() || 0;
          await this.requireAction(error);
          const resumeAt = error.retryAt?.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
          throw new BadRequestException(`${error.message}${resumeAt ? `；最早可重试：${resumeAt}（北京时间）` : ''}`);
        }
        throw error;
      }
    });
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.monitor) clearInterval(this.monitor);
    await this.monitoring;
  }
  async onApplicationShutdown() { await this.onModuleDestroy(); await this.browser?.close(); }
}
