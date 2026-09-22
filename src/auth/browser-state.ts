import { createHash } from 'node:crypto';
import { BrowserContext, Page } from 'playwright';
import { State } from './session.service';

export function isSitePage(page: Page) {
  try { return /(^|\.)bidcenter\.com\.cn$/.test(new URL(page.url()).hostname); }
  catch { return false; }
}
export async function hasChallenge(page: Page) {
  for (const selector of ['#aliyunCaptcha-mask', '#aliyunCaptcha-window', '#nc_1_wrapper', 'iframe[src*="captcha"]']) {
    if (await page.locator(selector).first().isVisible()) return true;
  }
  return false;
}
export function sessionFingerprint(state: State) {
  const cookies = state.cookies.filter(cookie => /(^|\.)bidcenter\.com\.cn$/.test(cookie.domain))
    .map(({ name, domain, path, value }) => [domain, path, name, value]).sort();
  // Only an in-memory digest is kept; never log browser cookies or tokens.
  return createHash('sha256').update(JSON.stringify(cookies)).digest('hex');
}
export async function observeBrowser(context: BrowserContext) {
  const pages = context.pages().filter(page => !page.isClosed() && isSitePage(page));
  if (!pages.length) return;
  const page = pages[pages.length - 1];
  let challengeVisible = false;
  for (const item of pages) { if (await hasChallenge(item)) challengeVisible = true; }
  const loginVisible = await page.locator('#txtpassword').isVisible() || await page.locator('#codeLogin_phone').isVisible();
  const state = await context.storageState();
  return { page, state, challengeVisible, loginVisible, fingerprint: sessionFingerprint(state) };
}
