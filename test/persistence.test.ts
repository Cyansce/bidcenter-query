import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DbService } from '../src/common/db.service';
import { ProjectsService } from '../src/projects/projects.service';
import { CollectorService } from '../src/collector/collector.service';
import { normalizeSearch } from '../src/bidcenter/parser';
import { SiteError } from '../src/bidcenter/protocol';
import { ProjectQueryDto } from '../src/common/dto';
const require = createRequire(import.meta.url);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bidcenter-test-')); const path = join(dir, 'test.db');
  const SQLite = require('better-sqlite3'); const sqlite = new SQLite(path);
  for (const migration of (await readdir('prisma/migrations')).filter(name => /^\d/.test(name)).sort()) { sqlite.exec(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8')); } sqlite.close();
  const db = new DbService(`file:${path}`); await db.onModuleInit();
  return { db, dir, path, projects: new ProjectsService(db), cleanup: async () => { await db.onApplicationShutdown(); await rm(dir, { recursive: true, force: true }); } };
}
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const item = (id: number) => ({ news_id: id, news_title_show: `服务器采购项目${id}`, news_type: 1, news_star_time_show: today, news_diqustr: '北京' });
const detail = (id: number) => ({ id, title: `服务器采购项目${id}`, content: '<p>预算金额：100万元</p><p>投标截止时间：2099-12-31 10:00</p>', isLogin: true, isAllow: true });
test('SQLite 跨查询去重、修订幂等、重连后仍可查询', async () => {
  const f = await fixture();
  try {
    await f.projects.saveListing(item(1), '服务器'); await f.projects.saveListing(item(1), '昇腾 服务器');
    await f.projects.saveDetail('1', detail(1), normalizeSearch(item(1), '服务器'));
    await f.projects.saveDetail('1', detail(1), normalizeSearch(item(1), '服务器'));
    assert.equal(await f.db.project.count(), 1); assert.equal(await f.db.queryMatch.count(), 2); assert.equal(await f.db.projectRevision.count(), 1);
    await f.projects.saveDetail('1', { ...detail(1), content: '<p>预算金额：200万元</p>' }, normalizeSearch(item(1), '服务器'));
    assert.equal(await f.db.projectRevision.count(), 2);
    await f.db.onApplicationShutdown(); await f.db.onModuleInit();
    const result = await f.projects.list(Object.assign(new ProjectQueryDto(), { keyword: '服务器' }));
    assert.equal(result.total, 1); assert.equal(result.items[0].budgetYuan, '2000000');
  } finally { await f.cleanup(); }
});
test('登录中断保留页断点，恢复时不重复详情，不漏剩余项目', async () => {
  const f = await fixture(); let expired = true; let blocked = false; const calls: string[] = [];
  const client = { verifySession: async () => true, search: async () => ({ items: [item(1), item(2)], total: 2, accessibleTotal: 2, paid: false }),
    detail: async (id: string) => { calls.push(id); if (id === '2' && expired) throw new SiteError('LOGIN_REQUIRED', '过期'); return detail(+id); } };
  const auth = { isBlocked: () => blocked, requireAction: async () => { blocked = true; } };
  const notes = { notify: async () => {} };
  const collector = new CollectorService(f.db, client as any, auth as any, f.projects, notes as any);
  try {
    const run = await collector.enqueue('test', ['服务器']); await collector.pump();
    const paused = await f.db.collectionRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(paused.status, 'WAITING_LOGIN'); assert.equal(paused.page, 1);
    expired = false; blocked = false; await collector.pump();
    assert.equal((await f.db.collectionRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'SUCCEEDED');
    assert.equal(await f.db.project.count(), 2); assert.deepEqual(calls, ['1', '2', '2']);
    assert.equal(await f.db.projectRevision.count(), 2);
  } finally { await collector.onModuleDestroy(); await f.cleanup(); }
});
test('两个 worker 共享 SQLite 时只有一个采集，并自动排除范围外数据', async () => {
  const f = await fixture(); let detailCount = 0;
  const client = { verifySession: async () => new Promise(r => setTimeout(r, 50)), search: async () => ({ items: [item(1), { ...item(2), news_type: 4 }, { ...item(3), news_star_time_show: '2020-01-01' }], total: 3, accessibleTotal: 3, paid: false }), detail: async () => { detailCount++; return detail(1); } };
  const auth = { isBlocked: () => false, requireAction: async () => {} }; const notes = { notify: async () => {} };
  const one = new CollectorService(f.db, client as any, auth as any, f.projects, notes as any);
  const two = new CollectorService(f.db, client as any, auth as any, f.projects, notes as any);
  try { await one.enqueue('test', ['服务器']); await Promise.all([one.pump(), two.pump()]); assert.equal(detailCount, 1); assert.equal(await f.db.project.count(), 1); }
  finally { await one.onModuleDestroy(); await two.onModuleDestroy(); await f.cleanup(); }
});
test('免费账户最多十页，并记录为 PARTIAL', async () => {
  const f = await fixture(); const pages: number[] = [];
  const client = { verifySession: async () => true, search: async (_: string, page: number) => { pages.push(page); return { items: [item(page)], total: 800, accessibleTotal: 800, paid: false }; }, detail: async (id: string) => detail(+id) };
  const auth = { isBlocked: () => false, requireAction: async () => {} }; const notes = { notify: async () => {} };
  const collector = new CollectorService(f.db, client as any, auth as any, f.projects, notes as any);
  try { const run = await collector.enqueue('test', ['服务器']); await collector.pump(); assert.equal(pages.length, 10); assert.equal((await f.db.collectionRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'PARTIAL'); }
  finally { await collector.onModuleDestroy(); await f.cleanup(); }
});

test('会员多查询合计最多15页，服务重启从第15页恢复不会获得新额度', async () => {
  const f = await fixture(); const calls: string[] = []; let interrupt = true; let blocked = false;
  const client = { verifySession: async () => true,
    search: async (query: string, page: number) => { calls.push(`${query}:${page}`); return { items: [item((query === '服务器' ? 0 : 100) + page)], total: query === '服务器' ? 80 : 1600, accessibleTotal: query === '服务器' ? 80 : 1600, paid: true }; },
    detail: async (id: string) => { if (id === '113' && interrupt) throw new SiteError('LOGIN_REQUIRED', '过期'); return detail(+id); } };
  const auth = { isBlocked: () => blocked, requireAction: async () => { blocked = true; } }; const notes = { notify: async () => {} };
  const one = new CollectorService(f.db, client as any, auth as any, f.projects, notes as any);
  let two: CollectorService | undefined;
  try {
    const run = await one.enqueue('test', ['服务器', '工作站', '昇腾']); await one.pump();
    const paused = await f.db.collectionRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(paused.pagesCollected, 14); assert.equal(paused.queryIndex, 1); assert.equal(paused.page, 13); assert.equal(paused.status, 'WAITING_LOGIN');
    await one.onModuleDestroy(); interrupt = false; blocked = false;
    two = new CollectorService(f.db, client as any, auth as any, f.projects, notes as any); await two.pump();
    const done = await f.db.collectionRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(done.pagesCollected, 15); assert.equal(done.maxPages, 15); assert.equal(done.status, 'PARTIAL');
    assert.match(done.warningsJson, /合计 15 页/); assert.equal(new Set(calls).size, 15); assert.ok(!calls.includes('工作站:14')); assert.ok(!calls.some(x => x.startsWith('昇腾')));
    assert.equal(await f.db.project.count(), 15);
  } finally { await one.onModuleDestroy(); await two?.onModuleDestroy(); await f.cleanup(); }
});
test('旧受限详情立即补采会员内容，保存和API返回附件与原始字段，降权不覆盖完整内容', async () => {
  const f = await fixture(); let fetched = 0;
  const richer = { ...detail(1), content: '<p>项目联系人：张工</p><p>电话：010-12345678</p>', xiazailist: [{ filename: '采购文件', userfujianurl: 'https://example.com/a.pdf' }], jinzhanlist: [{ id: 2, title: '进展' }], extraField: '保留' };
  const client = { verifySession: async () => true, search: async () => ({ items: [item(1)], total: 1, accessibleTotal: 1, paid: true }), detail: async () => { fetched++; return richer; } };
  const collector = new CollectorService(f.db, client as any, { isBlocked: () => false } as any, f.projects, { notify: async () => {} } as any);
  try {
    const project = await f.projects.saveListing(item(1), '服务器');
    await f.projects.saveDetail('1', { ...detail(1), isAllow: false }, normalizeSearch(item(1), '服务器'));
    await collector.enqueue('test', ['服务器']); await collector.pump(); assert.equal(fetched, 1);
    const read = await f.projects.get(project.id); assert.equal(read.accessLevel, 'FULL'); assert.equal(read.attachments.length, 1); assert.equal(read.timeline.length, 1); assert.equal(read.detailData.extraField, '保留');
    const list = await f.projects.list(new ProjectQueryDto()); assert.ok(!('detailDataJson' in list.items[0]));
    await f.projects.saveDetail('1', { ...detail(1), isAllow: false, content: '<p>电话：(略)</p>' }, normalizeSearch(item(1), '服务器'));
    const preserved = await f.projects.get(project.id); assert.equal(preserved.bodyHtml, richer.content); assert.equal(preserved.detailStatus, 'RESTRICTED'); assert.equal(preserved.attachments.length, 1);
    assert.equal(await f.db.projectRevision.count(), 3);
  } finally { await collector.onModuleDestroy(); await f.cleanup(); }
});
test('恰好15页且无剩余查询可以完整成功，旧配置无法超过硬上限', async () => {
  const f = await fixture(); const { config } = await import('../src/config'); const old = config.maxPages; config.maxPages = 100;
  const pages: number[] = [];
  const client = { verifySession: async () => true, search: async (_: string, page: number) => { pages.push(page); return { items: [item(page)], total: 600, accessibleTotal: 600, paid: true }; }, detail: async (id: string) => detail(+id) };
  const collector = new CollectorService(f.db, client as any, { isBlocked: () => false } as any, f.projects, { notify: async () => {} } as any);
  try { const run = await collector.enqueue('test', ['服务器']); await collector.pump(); const done = await f.db.collectionRun.findUniqueOrThrow({ where: { id: run.id } }); assert.equal(done.status, 'SUCCEEDED'); assert.equal(done.pagesCollected, 15); assert.equal(run.maxPages, 15); assert.equal(pages.length, 15); }
  finally { config.maxPages = old; await collector.onModuleDestroy(); await f.cleanup(); }
});
