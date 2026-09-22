# 项目技术说明

基于 TypeScript、NestJS、Prisma 和 SQLite 的 Node.js 服务，前端使用原生 HTML、CSS 和 JavaScript。

## 技术栈

- Node.js 24.x（最低 24.14.0），使用 npm 管理依赖。
- TypeScript 严格模式，编译输出为 CommonJS。
- NestJS 提供服务端模块与 HTTP 接口。
- Prisma 管理数据模型及迁移，SQLite 作为本地数据库。
- `node:test`、`node:assert/strict` 和 `tsx` 用于自动化测试。

## 目录结构

```text
src/        服务端源码
public/     前端静态资源
prisma/     数据模型与数据库迁移
scripts/    初始化、验证及维护脚本
test/       自动化测试
deploy/     进程管理与服务配置示例
dist/       编译产物（自动生成）
data/       本地运行数据（不纳入版本控制）
```

## 本地运行

```bash
nvm install
nvm use
npm ci
npm run setup
npm run build
npm start
```

默认访问地址：<http://127.0.0.1:3100>。

`npm run setup` 在 `.env` 不存在时创建配置，并生成 Prisma 客户端、应用数据库迁移；已有配置和数据库会保留。需要 Chromium 运行依赖时，执行 `npm run browser:install`。

依赖安装、构建和运行应使用同一 Node.js 主版本。当前没有开发热重载命令，修改服务端代码后需重新构建并重启。

## 开发与验证

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 生成 Prisma 客户端并编译 TypeScript |
| `npm run typecheck` | 检查 TypeScript 类型，不生成文件 |
| `npm test` | 执行 `test/*.test.ts` 测试 |
| `npm run test:http` | 验证已启动的本地服务及参数校验 |
| `npm run db:migrate` | 应用已提交的数据库迁移 |
| `npm run backup` | 创建 SQLite 一致性备份 |

遵循现有代码的两空格缩进、单引号和分号风格。数据库结构变更应同步提交迁移文件，不直接修改 `src/generated/` 下的生成代码。

提交代码前执行类型检查、测试和构建；HTTP 冒烟检查需要先启动服务。健康检查入口为 `GET /health`。

## 配置与维护

- 配置通过 `.env` 加载，参考 `.env.example`；调整后需重启服务。
- 不提交 `.env`、密钥、数据库、日志或其他本地状态文件。
- 服务默认监听本机回环地址。远程接入应通过带访问控制的 HTTPS 反向代理或 SSH 转发。
- 使用 `npm run backup` 备份数据库，避免直接复制写入中的 SQLite 主文件；恢复前先停止服务并备份现有数据。
- `deploy/` 提供 PM2 和 systemd 配置示例，使用前按环境调整路径、用户及运行参数。
- 出现 `NODE_MODULE_VERSION` 不匹配时，先切换至要求的 Node.js 版本，再执行 `npm ci` 和 `npm run build`。无需删除配置或数据库。
