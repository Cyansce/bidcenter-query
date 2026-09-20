import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { config, validateConfig } from './config';
async function bootstrap() {
  validateConfig();
  process.umask(0o077);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  app.disable('x-powered-by');
  app.use((req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  app.useStaticAssets(resolve('public'));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  console.log(`管理页 http://${config.host}:${config.port}；API_KEY 位于 .env，日志不输出密钥`);
}
bootstrap().catch(() => { console.error('服务启动失败，请检查配置、数据库迁移及浏览器依赖'); process.exitCode = 1; });
