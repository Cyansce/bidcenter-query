import { HealthController } from './health.controller';
import { ManualChromeService } from './auth/manual-chrome.service';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { DbService } from './common/db.service';
import { NotificationsService } from './common/notifications.service';
import { SessionService } from './auth/session.service';
import { AuthService } from './auth/auth.service';
import { BidcenterClient } from './bidcenter/client.service';
import { ProjectsService } from './projects/projects.service';
import { CollectorService } from './collector/collector.service';
@Module({
  imports: [ScheduleModule.forRoot()], controllers: [AppController, HealthController],
  providers: [{ provide: DbService, useFactory: () => new DbService() }, NotificationsService, SessionService, ManualChromeService, AuthService, BidcenterClient, ProjectsService, CollectorService],
})
export class AppModule {}
