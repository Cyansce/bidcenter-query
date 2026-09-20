import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client';
import { config } from '../config';
@Injectable()
export class DbService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(url = config.databaseUrl) {
    super({ adapter: new PrismaBetterSqlite3({ url, timeout: 5000 }) });
  }
  async onModuleInit() {
    await this.$connect();
    await this.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await this.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  }
  async onApplicationShutdown() { await this.$disconnect(); }
}
