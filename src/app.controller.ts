import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiGuard } from './common/api.guard';
import { AuthService } from './auth/auth.service';
import { CollectorService } from './collector/collector.service';
import { DbService } from './common/db.service';
import { LoginStartDto, ProjectQueryDto, RunDto, SmsDto } from './common/dto';
import { ProjectsService } from './projects/projects.service';
import { config } from './config';

@Controller('api')
@UseGuards(ApiGuard)
export class AppController {
  constructor(private readonly auth: AuthService, private readonly collector: CollectorService, private readonly db: DbService, private readonly projects: ProjectsService) {}
  @Get('status') async status() {
    return { auth: await this.auth.status(), schedule: { cron: '0 0 8 * * *', timeZone: 'Asia/Shanghai', enabled: config.scheduleEnabled },
      search: { mode: config.searchMode, keywords: config.keywords, combinedQuery: config.combinedQuery, lookbackDays: config.lookbackDays, types: [1, 2], region: '全国', tag: config.searchTag, maxPagesPerRun: config.maxPages },
      count: await this.db.project.count() };
  }
  @Get('auth/status') authStatus() { return this.auth.status(); }
  @Post('auth/start') start(@Body() dto: LoginStartDto) { return this.auth.start(dto.method); }
  @Post('auth/sms/send') sendSms() { return this.auth.sendSms(); }
  @Post('auth/sms/verify') verifySms(@Body() dto: SmsDto) { return this.auth.submitCode(dto.code); }
  @Post('auth/password/submit') submitPassword() { return this.auth.submitPassword(); }
  @Post('auth/challenge') challenge() { return this.auth.openChallenge(); }
  @Post('auth/complete') complete() { return this.auth.complete(); }
  @Get('projects') list(@Query() query: ProjectQueryDto) { return this.projects.list(query); }
  @Get('projects/:id') project(@Param('id') id: string) { return this.projects.get(id); }
  @Get('projects/:id/revisions') revisions(@Param('id') id: string) {
    return this.db.projectRevision.findMany({ where: { projectId: id }, orderBy: { capturedAt: 'desc' }, take: 50, omit: { snapshotJson: true } });
  }
  @Post('runs') @HttpCode(202) run(@Body() dto: RunDto) { return this.collector.enqueue('manual', dto.queries); }
  @Get('runs') runs() { return this.db.collectionRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }); }
  @Get('runs/:id') async getRun(@Param('id') id: string) {
    const run = await this.db.collectionRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('任务不存在');
    return run;
  }
  @Post('runs/:id/resume') @HttpCode(202) resume(@Param('id') id: string) { return this.collector.resume(id); }
  @Get('notifications') notifications() { return this.db.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }); }
  @Post('notifications/:id/ack') acknowledge(@Param('id') id: string) {
    return this.db.notification.updateMany({ where: { id }, data: { acknowledgedAt: new Date() } });
  }
}
