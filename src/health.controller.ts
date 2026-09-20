import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DbService } from './common/db.service';
@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}
  @Get() async health() {
    try { await this.db.$queryRawUnsafe('SELECT 1'); return { status: 'ok' }; }
    catch { throw new ServiceUnavailableException('数据库不可用'); }
  }
}
