import { Injectable, Logger } from '@nestjs/common';
import { DbService } from './db.service';
import { config } from '../config';
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  constructor(private readonly db: DbService) {}
  async notify(kind: string, message: string) {
    const recent = await this.db.notification.findFirst({ where: { kind, message, createdAt: { gt: new Date(Date.now() - 300000) } } });
    if (recent) return;
    await this.db.notification.create({ data: { kind, message } });
    this.logger.warn(`${kind}: ${message}`);
    if (config.webhookUrl) {
      try {
        const response = await fetch(config.webhookUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, message, managementUrl: `http://127.0.0.1:${config.port}` }),
          signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (!response.ok) this.logger.warn('通知 webhook 返回非成功状态；站内通知已保存');
      } catch { this.logger.warn('通知 webhook 发送失败；站内通知已保存'); }
    }
  }
}
