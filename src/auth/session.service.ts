import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request, APIRequestContext, BrowserContext } from 'playwright';
import { config } from '../config';
import { SiteError } from '../bidcenter/protocol';

type State = Awaited<ReturnType<BrowserContext['storageState']>> & { userAgent?: string };
export function accountIdentity(state: Pick<State, 'cookies'>) {
  const cookie = state.cookies.find(c => c.name === 'aspcn' && /(^|\.)bidcenter\.com\.cn$/.test(c.domain) && (c.expires < 0 || c.expires * 1000 > Date.now()));
  let value = cookie?.value || '';
  if (!value.includes('&') && /%26/i.test(value)) value = decodeURIComponent(value);
  const parts = new URLSearchParams(value);
  return { name: parts.get('name') || '', company: parts.get('company') || '', membership: parts.get('vip') || '' };
}
export function seal(state: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  return Buffer.concat([Buffer.from('BCS1'), iv, cipher.getAuthTag(), encrypted]);
}
export function unseal(bytes: Buffer, key: Buffer): State {
  if (bytes.subarray(0, 4).toString() !== 'BCS1') throw new Error('会话文件格式不受支持');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
  decipher.setAuthTag(bytes.subarray(16, 32));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString());
}
@Injectable()
export class SessionService implements OnApplicationShutdown {
  private api?: APIRequestContext;
  private userAgent?: string;
  private initializing?: Promise<APIRequestContext>;
  private readonly path = join(config.dataDir, 'session.enc');
  private readonly key = Buffer.from(config.sessionKey, 'base64');
  async load(): Promise<State | undefined> {
    try { return unseal(await readFile(this.path), this.key); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('会话文件解密失败；请检查 SESSION_KEY 或备份后移走会话文件'); }
  }
  async save(state: State) {
    // Persist only the site requested by the operator.
    const filtered = { cookies: state.cookies.filter(c => /(^|\.)bidcenter\.com\.cn$/.test(c.domain)),
      origins: state.origins.filter(o => new URL(o.origin).hostname.endsWith('.bidcenter.com.cn')), userAgent: state.userAgent || this.userAgent };
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, seal(filtered, this.key), { mode: 0o600 });
    await rename(tmp, this.path);
  }
  async context(): Promise<APIRequestContext> {
    if (this.api) return this.api;
    this.initializing ??= (async () => {
      const state = await this.load();
      this.userAgent = state?.userAgent;
      this.api = await request.newContext({ storageState: state ? { cookies: state.cookies, origins: state.origins } : undefined, userAgent: this.userAgent, timeout: config.requestTimeout, ignoreHTTPSErrors: false });
      return this.api;
    })();
    try { return await this.initializing; } finally { this.initializing = undefined; }
  }
  async replace(state: State, userAgent?: string) {
    await this.api?.dispose();
    this.userAgent = userAgent;
    // Candidate session is only persisted after the server verifies it successfully.
    this.api = await request.newContext({ storageState: { cookies: state.cookies, origins: state.origins }, userAgent, timeout: config.requestTimeout });
  }
  async resetFromDisk() { await this.api?.dispose(); this.api = undefined; this.userAgent = undefined; }
  async credentials(context?: APIRequestContext) {
    const state = await (context || await this.context()).storageState();
    if (config.expectedAccount && accountIdentity(state).name !== config.expectedAccount) {
      throw new SiteError('LOGIN_REQUIRED', '当前会话不是指定的会员账号，请使用配置的会员账号重新登录');
    }
    const valid = state.cookies.filter(c => (c.expires < 0 || c.expires * 1000 > Date.now()) && /(^|\.)bidcenter\.com\.cn$/.test(c.domain));
    const cookie = valid.find(c => c.name === 'aspcn');
    if (!cookie) throw new SiteError('LOGIN_REQUIRED', '尚未登录采招网，请打开管理页登录');
    let value = cookie.value;
    // ASP.NET compound cookies normally use & separators; decode whole only if separators are encoded.
    if (!value.includes('&') && /%26/i.test(value)) value = decodeURIComponent(value);
    const parts = new URLSearchParams(value);
    const token = parts.get('Token') || parts.get('token');
    if (!token) throw new SiteError('LOGIN_REQUIRED', '会话缺少 Token，请重新登录');
    return { token, guid: valid.find(c => c.name === 'bidguid')?.value || String(Date.now()) };
  }
  async exists() { try { await this.credentials(); return true; } catch (e) { if (e instanceof SiteError) return false; throw e; } }
  async identity() {
    const identity = accountIdentity(await (await this.context()).storageState());
    return { account: identity.name.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'), company: identity.company, membership: identity.membership,
      expectedAccount: config.expectedAccount.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') };
  }
  async persist() { if (this.api) await this.save(await this.api.storageState()); }
  async onApplicationShutdown() { await this.api?.dispose(); }
}
