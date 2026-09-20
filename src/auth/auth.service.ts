import { BadRequestException, ConflictException, HttpException, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ManualChromeService } from './manual-chrome.service';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { config } from '../config';
import { SessionService } from './session.service';
import { BidcenterClient } from '../bidcenter/client.service';
import { NotificationsService } from '../common/notifications.service';
import { SiteError } from '../bidcenter/protocol';

@Injectable()
export class AuthService implements OnApplicationShutdown {
  private browser?: Browser;
  private browserContext?: BrowserContext;
  private page?: Page;
  private busy = false;
  private state = 'UNKNOWN';
  private message = '首次采集前请登录';
  private method: 'sms' | 'password' = config.loginMethod;
  private lastSmsAt = 0;
  private blocked = false;
  constructor(private readonly sessions: SessionService, private readonly client: BidcenterClient, private readonly notifications: NotificationsService, private readonly manual: ManualChromeService) {}
  async status() {
    if (this.state === 'UNKNOWN') {
      const saved = await this.sessions.exists();
      this.state = saved ? 'SESSION_SAVED' : 'LOGIN_REQUIRED';
      if (saved) this.message = '已载入加密会话，采集前会验证有效性';
    }
    return { state: this.state, message: this.message, method: this.method, phone: config.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
      ...await this.sessions.identity(), browserMode: config.loginBrowserMode, browserOpen: this.manual?.isOpen || (!!this.page && !this.page.isClosed()) };
  }
  isBlocked() { return this.blocked; }
  async requireAction(error: SiteError) {
    if (!['LOGIN_REQUIRED', 'HUMAN_REQUIRED'].includes(error.kind)) return;
    this.blocked = true; this.state = error.kind; this.message = error.message;
    await this.notifications.notify(error.kind, `${error.message}。管理页 http://127.0.0.1:${config.port}`);
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) throw new ConflictException('登录操作正在进行，请稍后');
    this.busy = true;
    try { return await fn(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      this.state = 'LOGIN_ACTION_REQUIRED';
      this.message = '浏览器操作未完成，请检查登录窗口；若窗口未打开，请安装 Chromium 并确认桌面环境可用';
      // Playwright errors can include form values. Never forward or log the raw exception.
      throw new BadRequestException(this.message);
    } finally { this.busy = false; }
  }
  private async openBrowser() {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.launch({ headless: config.browserHeadless, channel: config.browserChannel });
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
      if (config.loginBrowserMode === 'chrome-manual') {
        await this.manual.open('https://sso.bidcenter.com.cn/login/');
        this.state = 'MANUAL_LOGIN';
        this.message = '请在普通 Chrome 中选择短信或账号登录，并手动获取验证码和登录；成功后点击验证并保存会话';
        await this.notifications.notify('LOGIN_REQUIRED', this.message);
        return this.status();
      }
      const page = await this.openBrowser();
      await page.goto('https://sso.bidcenter.com.cn/login/', { waitUntil: 'domcontentloaded', timeout: config.requestTimeout });
      if (this.method === 'sms') {
        await page.locator('.login-tab .tab_yzm').click();
        await page.locator('#codeLogin_phone').fill(config.phone);
        this.state = 'READY_TO_SEND_SMS'; this.message = '点击发送验证码，若弹出人机验证，请在登录浏览器中完成';
      } else {
        await page.locator('.login-tab li[type="0"]').click();
        if (config.username) await page.locator('#txtusername').fill(config.username);
        if (config.password) await page.locator('#txtpassword').fill(config.password);
        this.state = 'PASSWORD_READY'; this.message = '账号已按配置填写；点击账号登录，额外验证请在登录浏览器完成';
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
    if (config.loginBrowserMode === 'chrome-manual') throw new BadRequestException('普通 Chrome 人工登录模式：请在 Chrome 窗口发送并输入验证码、提交登录，成功后验证并保存会话');
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
      this.state = 'VERIFYING'; this.message = '验证码已提交；等待网站登录完成后点击验证并保存会话';
      return this.status();
    });
  }
  async submitPassword() {
    return this.exclusive(async () => {
      this.requireAutomatedMode();
      if (!this.page || this.page.isClosed() || this.method !== 'password') throw new BadRequestException('请先打开账号登录');
      await this.checkChallenge();
      await this.page.locator('#login_login_btn').click();
      this.state = 'VERIFYING'; this.message = '已提交账号登录；额外验证请在登录浏览器完成，然后验证并保存会话';
      return this.status();
    });
  }
  async openChallenge() {
    return this.exclusive(async () => {
      this.blocked = true;
      if (config.loginBrowserMode === 'chrome-manual') {
        await this.manual.open('https://search.bidcenter.com.cn/');
        this.state = 'HUMAN_REQUIRED'; this.message = '请在普通 Chrome 中完成网站验证，再验证并保存会话';
        return this.status();
      }
      const page = await this.openBrowser();
      await page.goto('https://search.bidcenter.com.cn/', { waitUntil: 'domcontentloaded', timeout: config.requestTimeout });
      this.state = 'HUMAN_REQUIRED'; this.message = '请在登录浏览器完成验证，再点击验证并保存会话';
      return this.status();
    });
  }
  async complete() {
    return this.exclusive(async () => {
      if (config.loginBrowserMode === 'chrome-manual' && this.manual.isOpen) {
        const context = await this.manual.attach();
        const sourcePage = context.pages().find(page => /bidcenter\.com\.cn/.test(page.url()));
        const userAgent = sourcePage ? await sourcePage.evaluate(() => navigator.userAgent) : undefined;
        await this.sessions.replace(await context.storageState(), userAgent);
      } else if (this.browserContext) {
        const userAgent = this.page && !this.page.isClosed() ? await this.page.evaluate(() => navigator.userAgent) : undefined;
        await this.sessions.replace(await this.browserContext.storageState(), userAgent);
      }
      try {
        await this.client.verifySession();
        this.state = 'AUTHENTICATED'; this.message = '已验证登录并加密保存会话，暂停任务将自动继续'; this.blocked = false;
        await this.manual.close();
        await this.browser?.close(); this.browser = undefined; this.browserContext = undefined; this.page = undefined;
        return this.status();
      } catch (error) {
        await this.sessions.resetFromDisk();
        if (error instanceof SiteError) { await this.requireAction(error); throw new BadRequestException(error.message); }
        throw error;
      }
    });
  }
  async onApplicationShutdown() { await this.browser?.close(); }
}
