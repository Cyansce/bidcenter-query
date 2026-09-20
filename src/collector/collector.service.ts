import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { DbService } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { AuthService } from '../auth/auth.service';
import { BidcenterClient } from '../bidcenter/client.service';
import { SiteError } from '../bidcenter/protocol';
import { dayWindow, normalizeSearch } from '../bidcenter/parser';
import { ProjectsService } from '../projects/projects.service';

@Injectable()
export class CollectorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CollectorService.name);
  private readonly owner = randomUUID();
  private active?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private leaseLost = false;
  constructor(private readonly db: DbService, private readonly client: BidcenterClient,
    private readonly auth: AuthService, private readonly projects: ProjectsService, private readonly notifications: NotificationsService) {}
  async onApplicationBootstrap() {
    const chinaHour = new Date(Date.now() + 8 * 3600000).getUTCHours();
    // Catch up today's 08:00 task after a restart; scheduleKey prevents duplicate enqueue.
    if (config.scheduleEnabled && chinaHour >= 8) await this.enqueue('daily');
    else if (config.runOnStartup) await this.enqueue('startup');
    this.timer = setInterval(() => { void this.pump().catch(() => this.logger.error('任务调度异常，将在下一个周期恢复')); }, 5000);
    void this.pump().catch(() => this.logger.error('启动调度异常'));
  }
  @Cron('0 0 8 * * *', { name: 'bidcenter-daily', timeZone: 'Asia/Shanghai', waitForCompletion: true })
  async daily() { if (config.scheduleEnabled) { await this.enqueue('daily'); await this.pump(); } }
  async enqueue(trigger: string, override?: string[]) {
    const queries = override || (config.searchMode === 'combined' ? [config.combinedQuery] : config.keywords);
    const unique = [...new Set(queries.map(s => s.trim()).filter(Boolean))];
    if (!unique.length) throw new BadRequestException('查询关键词不能为空');
    const { fromDate, toDate, chinaDay } = dayWindow(new Date(), config.lookbackDays);
    const scheduleKey = trigger === 'daily' ? `daily:${chinaDay}` : undefined;
    if (scheduleKey) return this.db.collectionRun.upsert({ where: { scheduleKey }, create: { scheduleKey, trigger, queriesJson: JSON.stringify(unique), fromDate, toDate }, update: {} });
    return this.db.collectionRun.create({ data: { trigger, queriesJson: JSON.stringify(unique), fromDate, toDate } });
  }
  pump(): Promise<void> {
    if (this.stopping || this.active) return this.active || Promise.resolve();
    this.active = this.work().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async acquire() {
    const changes = await this.db.$executeRawUnsafe(
      'INSERT INTO WorkerLease (name, owner, expiresAt) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expiresAt=excluded.expiresAt WHERE WorkerLease.expiresAt < ? OR WorkerLease.owner = ?',
      'collector', this.owner, new Date(Date.now() + 120000).toISOString(), new Date().toISOString(), this.owner);
    return changes === 1;
  }
  private async work() {
    if (this.auth.isBlocked() || !await this.acquire()) return;
    this.leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.db.workerLease.updateMany({ where: { name: 'collector', owner: this.owner }, data: { expiresAt: new Date(Date.now() + 120000) } })
        .then(result => { if (!result.count) this.leaseLost = true; }).catch(() => { this.leaseLost = true; });
    }, 20000);
    try {
      const run = await this.db.collectionRun.findFirst({
        where: { status: { in: ['QUEUED', 'RUNNING', 'WAITING_LOGIN', 'WAITING_HUMAN', 'RETRY_WAIT'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
        orderBy: { createdAt: 'asc' },
      });
      if (!run) return;
      await this.db.collectionRun.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: run.startedAt || new Date(), nextAttemptAt: null, lastError: null } });
      try {
        await this.client.verifySession();
        const queries = JSON.parse(run.queriesJson) as string[];
        const warnings = new Set<string>(JSON.parse(run.warningsJson));
        let failedDetails = run.failedDetails;
        const workStarted = Date.now();
        for (let index = run.queryIndex; index < queries.length; index++) {
          let previousSignature = '';
          for (let page = index === run.queryIndex ? run.page : 1; page <= config.maxPages; page++) {
            this.checkContinuation(workStarted);
            const results = await this.client.search(queries[index], page);
            const signature = results.items.map(x => x.news_id).join(',');
            if (signature && signature === previousSignature) throw new SiteError('PROTOCOL_CHANGED', '分页返回重复列表，已停止以避免无限采集');
            previousSignature = signature;
            for (const item of results.items) {
              this.checkContinuation(workStarted);
              const summary = normalizeSearch(item, queries[index]);
              if (![1, 2].includes(summary.noticeType) || summary.publishedAt < run.fromDate || summary.publishedAt > run.toDate) continue;
              const project = await this.projects.saveListing(item, queries[index]);
              await this.db.collectionRun.update({ where: { id: run.id }, data: { seen: { increment: 1 } } });
              if (project.detailFetchedAt && project.detailStatus === 'COMPLETE' && Date.now() - project.detailFetchedAt.getTime() < config.detailRefreshHours * 3600000) continue;
              try {
                const detail = await this.client.detail(summary.sourceId);
                const saved = await this.projects.saveDetail(summary.sourceId, detail, summary);
                await this.db.collectionRun.update({ where: { id: run.id }, data: { saved: { increment: 1 }, restricted: { increment: saved.accessLevel === 'RESTRICTED' ? 1 : 0 } } });
              } catch (error) {
                if (!(error instanceof SiteError) || ['LOGIN_REQUIRED', 'HUMAN_REQUIRED', 'TRANSIENT', 'PROTOCOL_CHANGED'].includes(error.kind)) throw error;
                failedDetails++;
                warnings.add('部分详情受账户权限限制；已保留列表信息');
                await this.db.project.update({ where: { id: project.id }, data: { detailStatus: 'RESTRICTED', detailError: error.message } });
              }
            }
            const totalPages = Math.ceil(results.accessibleTotal / 40);
            const permittedPages = results.paid ? totalPages : Math.min(totalPages, 10);
            const finished = page >= Math.max(1, permittedPages) || results.items.length === 0;
            if (finished || page === config.maxPages) {
              if (page < Math.ceil(results.total / 40)) warnings.add(`查询 ${queries[index]} 受分页上限或账户权限限制，仅完成 ${page} 页`);
              if (!results.items.length && page < totalPages) warnings.add(`查询 ${queries[index]} 提前返回空页，请复核网站结果`);
              await this.db.collectionRun.update({ where: { id: run.id }, data: { queryIndex: index + 1, page: 1, failedDetails, warningsJson: JSON.stringify([...warnings]) } });
              break;
            }
            // Page checkpoint only moves after every detail has either been saved or explicitly marked.
            await this.db.collectionRun.update({ where: { id: run.id }, data: { queryIndex: index, page: page + 1, failedDetails, warningsJson: JSON.stringify([...warnings]) } });
          }
        }
        const latest = await this.db.collectionRun.findUniqueOrThrow({ where: { id: run.id } });
        if (latest.restricted > 0) warnings.add('部分正文或字段被网站遮盖，已按原样保存并标记 RESTRICTED');
        await this.db.collectionRun.update({ where: { id: run.id }, data: { status: warnings.size ? 'PARTIAL' : 'SUCCEEDED', warningsJson: JSON.stringify([...warnings]), finishedAt: new Date() } });
        if (warnings.size) await this.notifications.notify('COLLECTION_PARTIAL', `采集任务 ${run.id} 已完成可访问部分；请查看任务中的缺失原因`);
      } catch (error) {
        if (this.stopping || this.leaseLost) return; // Leave RUNNING checkpoint for the next lease holder.
        const siteError = error instanceof SiteError ? error : new SiteError('PROTOCOL_CHANGED', '采集出现内部错误，请检查服务日志及接口兼容性');
        const attempts = run.attempts + 1;
        const retry = siteError.kind === 'TRANSIENT' && attempts <= 5;
        const status = siteError.kind === 'LOGIN_REQUIRED' ? 'WAITING_LOGIN' : siteError.kind === 'HUMAN_REQUIRED' ? 'WAITING_HUMAN' : retry ? 'RETRY_WAIT' : 'FAILED';
        await this.db.collectionRun.update({ where: { id: run.id }, data: { status, attempts, lastError: siteError.message,
          nextAttemptAt: retry ? new Date(Date.now() + Math.min(60, 2 ** attempts) * 60000) : null, finishedAt: status === 'FAILED' ? new Date() : null } });
        await this.auth.requireAction(siteError);
        if (!['LOGIN_REQUIRED', 'HUMAN_REQUIRED'].includes(siteError.kind)) await this.notifications.notify(status, `任务 ${run.id}：${siteError.message}`);
        // Do not log upstream responses, URLs containing credentials, or session data.
        this.logger.warn(`任务 ${run.id}: ${status} (${siteError.kind})`);
      }
    } finally {
      clearInterval(heartbeat);
      await this.db.workerLease.deleteMany({ where: { name: 'collector', owner: this.owner } });
    }
  }
  private checkContinuation(started: number) {
    if (this.stopping || this.leaseLost) throw new SiteError('TRANSIENT', '任务已停止，保留断点');
    if (this.auth.isBlocked()) throw new SiteError('HUMAN_REQUIRED', '登录操作进行中，采集已暂停');
    if (Date.now() - started > 6 * 3600000) throw new SiteError('TRANSIENT', '单轮任务超过六小时，稍后从断点继续');
  }
  async resume(id: string) {
    const run = await this.db.collectionRun.findUnique({ where: { id } });
    if (!run) throw new BadRequestException('任务不存在');
    if (['SUCCEEDED', 'PARTIAL', 'RUNNING'].includes(run.status)) throw new BadRequestException('该状态不能恢复；可新建采集任务');
    return this.db.collectionRun.update({ where: { id }, data: { status: 'QUEUED', nextAttemptAt: null, finishedAt: null, attempts: 0 } });
  }
  async onModuleDestroy() { this.stopping = true; if (this.timer) clearInterval(this.timer); await this.active; }
}
