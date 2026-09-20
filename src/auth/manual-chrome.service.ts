import { BadRequestException, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { spawn, ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, BrowserContext, Browser } from 'playwright';
import { config } from '../config';

@Injectable()
export class ManualChromeService implements OnApplicationShutdown {
  private child?: ChildProcess;
  private browser?: Browser;
  private launched = false;
  get isOpen() { return this.launched && !!this.child && this.child.exitCode === null; }
  private async executable() {
    const candidates = [config.chromeExecutable, ...(process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'])].filter(Boolean) as string[];
    for (const file of candidates) { try { await access(file); return file; } catch {} }
    throw new BadRequestException('未找到普通 Chrome，请安装 Chrome 或配置 CHROME_EXECUTABLE；也可选择 Playwright 登录模式');
  }
  async open(url: string) {
    if (this.isOpen) return;
    const executable = await this.executable();
    const port = config.chromeDebugPort;
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new BadRequestException('Chrome 登录专用端口已被占用，请修改 CHROME_DEBUG_PORT')));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
    const profile = join(config.dataDir, 'chrome-login-profile');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    this.child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', url], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      this.child!.once('spawn', resolve);
      this.child!.once('error', () => reject(new BadRequestException('普通 Chrome 启动失败，请检查桌面环境')));
    });
    this.launched = true;
    this.child.once('exit', () => { this.launched = false; });
    // No CDP connection, page automation, injected script, or synthetic click during manual login.
  }
  async attach(): Promise<BrowserContext> {
    if (!this.isOpen) throw new BadRequestException('普通 Chrome 登录窗口已关闭，请重新打开登录');
    this.browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`, { timeout: config.requestTimeout });
    const context = this.browser.contexts()[0];
    if (!context) throw new BadRequestException('Chrome 会话不可用');
    return context;
  }
  async close() {
    await this.browser?.close().catch(() => {}); this.browser = undefined;
    this.child?.kill('SIGTERM'); this.child = undefined; this.launched = false;
  }
  async onApplicationShutdown() { await this.close(); }
}
