import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config';
@Injectable()
export class ApiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
    const input = Buffer.from(token); const expected = Buffer.from(config.apiKey);
    if (!token || input.length !== expected.length || !timingSafeEqual(input, expected)) throw new UnauthorizedException('请提供有效的管理 API_KEY');
    return true;
  }
}
