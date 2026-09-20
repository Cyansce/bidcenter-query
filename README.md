# 采招网自动采集程序

NestJS 12.0.1 + Prisma 7.10.0 + SQLite。每天 **Asia/Shanghai 08:00** 搜索全国、近一周、招标公告（1）和招标预告（2），保存列表及可访问的详情，提供管理页和查询 API。

搜索、详情和登录有效性检查走采招网真实 HTTP 接口；仅首次登录、短信验证码、人机验证使用普通 Chromium 浏览器。会话使用 AES-256-GCM 加密保存。不会破解会员遮盖、验证码或修改网站权限参数。

## 启动

要求 Node.js 24 LTS（24.14 或更高的 24.x 版本），建议安装最新补丁版本。

```bash
npm ci
npm run setup
npm run browser:install
npm run build
npm start
```

打开 <http://127.0.0.1:3100>，在管理页输入 `.env` 中的 `API_KEY`。密钥仅留在页面内存，刷新后需要重新输入。`.env`、数据库和会话文件已加入 `.gitignore`。

`npm run setup` 只在 `.env` 不存在时生成配置和随机密钥；保留已有数据库，并执行迁移。首次启动若当天已过 08:00，会补建当天任务。没有登录态时任务停在 `WAITING_LOGIN`，不会反复发送短信。

## 首次登录与过期恢复

默认 `LOGIN_BROWSER_MODE=chrome-manual`，用于网站容易识别程序点击的情况：

1. 管理页点击“打开短信登录”或“打开账号登录”，程序启动本机普通 Chrome 的专用登录窗口。
2. 在 Chrome 中手动选择登录方式、输入手机号（默认配置 `17704057367`）或账号密码，点击获取短信验证码并完成人机验证、登录。
3. 登录成功后，在管理页点击“验证并保存会话”。此时程序才连接该 Chrome，读取本站会话，调用 `AuthorityHandler.ashx` 校验有效性并加密保存。等待中的任务自动续采。

登录期间不接入页面自动化，不模拟验证码点击。普通 Chrome 模式仍不能保证通过网站风控；若验证失败，保留错误提示、停止重复尝试，检查网络或联系网站处理。

普通 Chrome 使用 `data/chrome-login-profile` 专用目录，不读取个人 Chrome 的日常配置。配置目录可能保存浏览器会话，应与数据库一并保护。调试端口默认 `127.0.0.1:9227`，只在人工登录期间开启；完成后关闭专用 Chrome。端口被占用时拒绝连接，防止误接其他浏览器。可配置 `CHROME_EXECUTABLE` 和 `CHROME_DEBUG_PORT`。

对于允许程序操作登录表单的环境，可设置 `LOGIN_BROWSER_MODE=playwright`：

1. “打开短信登录”会自动填入 `LOGIN_PHONE`；点击“发送短信验证码”。若出现阿里云验证，请在程序浏览器中人工完成。
2. 收到短信后，在管理页输入验证码并提交。验证码仅用于本次登录，不保存到数据库或日志。网站验证弹层未完成时不会强制点击登录。
3. 登录跳转完成后点击“验证并保存会话”。程序不会自动重发短信，重复发送间隔至少 60 秒。
4. `LOGIN_METHOD=password` 支持 `LOGIN_USERNAME` 和 `LOGIN_PASSWORD` 自动填入，也可在浏览器中手动输入，再点击“提交账号登录”。

上述两种浏览器模式都支持短信或账号密码登录。`LOGIN_METHOD` 指默认登录方式；人工模式由用户在网页选择，配置的凭据不会被自动输入网页。

遇到 `WAITING_HUMAN`，打开人工验证窗口，处理后验证并保存。遇到 `WAITING_LOGIN`，重新登录。若已关闭人工登录窗口，不应直接认为 Cookie 仍有效，应通过管理页重新检查。

登录窗口在**运行服务的电脑**打开。无桌面的 Linux 服务器应提供受控桌面会话并配置显示环境；不要把 `BROWSER_HEADLESS=true` 当作验证码解决方法。已有会话的日常 HTTP 采集不需要保持浏览器开启。

## 搜索方式

默认一次提交用户原始组合表达式：`昇腾、鲲鹏、服务器、工作站`。实测顿号组合有结果，空格组合为零，两者语义不同。表达式原样交给网站，程序不把空格或 `+` 擅自改写为逻辑 OR。

```dotenv
SEARCH_MODE=combined
SEARCH_COMBINED_QUERY=昇腾、鲲鹏、服务器、工作站
SEARCH_KEYWORDS=昇腾,鲲鹏,服务器,工作站
SEARCH_TAG=0
```

- `SEARCH_MODE=separate`：每个关键词独立请求，统一入库去重。
- `SEARCH_TAG=0`：全文和附件；`1`：标题；`2`：全文不含附件。附件关键词命中不代表程序已下载附件。
- 管理页“本次查询”支持每行一个查询，也可调用 `POST /api/runs` 指定 `queries`，不修改定时任务配置。
- “近一周”默认定义为北京时间今天及前六个自然日。接口固定请求 `time=7`，本地再次校验发布时间；不使用付费自定义日期功能。
- 搜索接口可能夹带采购信息等其他类型，程序再次过滤，只接收 1、2。无结果时不跟随推荐项目。

## 保存内容与有效性

保存标题、地区、发布时间、预算原文与人民币元数值字符串、采购方式、文件/报名截止、响应/投标截止、正文 HTML/纯文本、联系人、来源链接和命中查询。预告的预计采购时间单独保存，列表泛化“截止时间”也单独保存。

正文中的明确截止标签优先；询问/质疑截止不会冒充投标截止。只有日期时按北京时间当日 23:59:59 存储，同时在 `deadlineEvidence` 标明 `precision=date`，供人工复核；明确 `00:00` 原样保留。存在冲突或无法识别时填 `null`。附件中的期限目前不解析。

金额有单位且完整时精确换算，缺失填 `null`；如果正文预算被遮盖而列表公开预算完整，保留列表值并记录来源。会员遮盖 `(略)`、`*` 等原样保留，`accessLevel=RESTRICTED`。联系人只从项目正文抽取，剔除会员推广客服。

- 同一 `sourceId` 跨关键词、跨天只保存一条；内容变化另存修订。
- 只有“项目编号 + 采购人 + 地区 + 公告类型”均可靠时生成 `duplicateGroup`，用于识别不同公告 ID 的潜在重复项目。不会凭通用标题直接合并采购项目。
- `relevance` 为 `RELATED / UNRELATED / REVIEW`。行业判断使用可解释规则，无法确定时保留待复核。
- `validOnly=true` 返回与算力/IT 相关、详情已采集、未取消、尚未到报名或投标截止的项目，以及近期预告。未披露截止的普通公告保留但不纳入已确认有效结果。
- 查询时重新判断日期是否过期。不同 ID 的疑似重复、掩码信息、附件内容仍需人工核实。

## API

除 `/health` 和管理页面外，所有接口需要：

```http
Authorization: Bearer <.env 中的 API_KEY>
```

默认只监听 `127.0.0.1:3100`。远程访问建议 SSH 转发；需要改 HOST 时请使用 HTTPS 反向代理并保持 API 鉴权。

| 方法与路径 | 用途 |
|---|---|
| `GET /health` | 进程/数据库健康检查，不代表会话有效或当天采集完成 |
| `GET /api/status` | 配置摘要、会话状态、已存总数 |
| `POST /api/auth/start` | `{"method":"sms"}` 或 `{"method":"password"}` |
| `POST /api/auth/sms/send` | 人工触发验证码发送，不自动重试 |
| `POST /api/auth/sms/verify` | `{"code":"短信验证码"}` |
| `POST /api/auth/password/submit` | 提交配置或在浏览器输入的账号密码 |
| `POST /api/auth/challenge` | 打开正常网页处理人工验证 |
| `POST /api/auth/complete` | 校验登录并保存会话 |
| `POST /api/runs` | `{}` 使用配置；`{"queries":["昇腾、鲲鹏、服务器、工作站"]}` 单次组合查询；返回 202 |
| `GET /api/runs` | 最近 50 个任务和断点、告警、状态 |
| `GET /api/runs/:id` | 单个任务状态 |
| `POST /api/runs/:id/resume` | 人工恢复失败/等待任务；已成功或部分成功可新建任务 |
| `GET /api/projects` | 分页查询保存数据 |
| `GET /api/projects/:id` | 完整记录、正文、联系人及字段依据 |
| `GET /api/projects/:id/revisions` | 最近 50 条修订元数据 |
| `GET /api/notifications` | 最近 50 条提醒 |
| `POST /api/notifications/:id/ack` | 标记提醒已读 |

查询参数：`keyword`（标题或正文包含）、`query`（命中的完整搜索表达式）、`region`、`type=1|2`、`from`/`to`（ISO8601，建议带时区）、`validOnly=true`、`relevance`、`accessLevel`、`page`（默认 1）、`pageSize`（默认 20，最大 100）。查询 API 始终读取 SQLite，不触发网站搜索。返回列表中的 `id` 是本地记录 ID，`sourceId` 是网站公告 ID。

无需在命令行展开密钥的本地调用示例：

```bash
node scripts/api.mjs status
node scripts/api.mjs 'projects?keyword=%E6%9C%8D%E5%8A%A1%E5%99%A8&validOnly=true'
node scripts/api.mjs runs '{"queries":["昇腾、鲲鹏、服务器、工作站"]}'
```

## 长期运行与恢复

- Cron 时区固定为 `Asia/Shanghai`，不依赖操作系统时区。每天任务使用唯一日期键，重启补采不会重复创建当天任务。
- 手动与定时任务统一排队。SQLite 租约防止多个 worker 同时采集；实际部署仍建议单实例，因为浏览器登录状态由本机进程管理。
- 列表分页完成后才推进断点。进程中断后重放未完成页；项目与修订幂等保存。`seen/saved/restricted` 是处理计数，页重放可能使 `seen` 增加；数据库项目总数是准确去重数。
- 请求默认间隔 3 秒、单请求 30 秒超时、串行执行；网络/5xx 最多三次请求尝试，再以任务级指数退避恢复，五轮后停在 FAILED。429、人机验证、登录过期立即暂停，等待人工操作。
- 免费账户最多访问网站允许的前十页；付费账户受 `MAX_PAGES_PER_QUERY`（默认 100）和服务返回的可访问数量限制。触及上限或详情受限时状态为 `PARTIAL`，不会报告完整成功。
- 页面/协议字段变化会停在 FAILED，保存断点供修复后重试。程序不会自动执行下载的 JS 代码。
- SQLite 启用 WAL 与 busy timeout。通知和采集任务持久化，项目不会自动清理。磁盘容量与备份保留周期由部署方管理。

提供 `deploy/ecosystem.config.cjs`（PM2）和 `deploy/bidcenter.service`（systemd）示例。按机器实际安装路径、服务用户和桌面环境调整后使用；本仓库不会自动安装常驻系统服务。PM2 可使用：

```bash
npm run db:migrate
npm run build
pm2 start deploy/ecosystem.config.cjs
pm2 save
```

更新配置后重启服务。应把日志交给 systemd journal 或配置 PM2 日志轮转。收到终止信号后最多等待当前请求结束，保留断点；systemd/PM2 示例预留 90 秒关闭时间。

提醒默认写入管理页和进程日志。可配置 `NOTIFICATION_WEBHOOK_URL` 接入自己的提醒服务，只发送状态说明和管理地址，不发送验证码、账号密码、Cookie 或 Token。实际接收服务需自行处理该 JSON，不假定兼容某个聊天机器人格式。

## 备份

```bash
node scripts/backup.mjs
# 或指定一个新的备份文件名
node scripts/backup.mjs /your/backup/location/bidcenter.db
```

通过 SQLite 在线 backup API 生成一致性备份，不直接复制处于 WAL 写入中的主文件。还应在安全位置备份 `.env`（包含 SESSION_KEY）和 `data/session.enc`；丢失密钥则需重新登录。恢复数据库前先停服务，将现有数据库和 WAL/SHM 整体备份后再更换。

## 验证与当前限制

```bash
npm test
npm run build
npm run test:http  # 服务启动后执行
npm audit
```

测试覆盖公开协议解码、组合表单编码、掩码数据、时间标签、SQLite 去重修订、登录中断恢复、多 worker 互斥、免费分页上限。HTTP 校验覆盖 Bearer 鉴权、参数范围、非法验证码和空查询。前端详情只以纯文本展示，不执行采集正文 HTML。

网站接口属于未公开承诺稳定的内部接口，观察依据见 [docs/site-protocol.md](docs/site-protocol.md)。第三方页面变动时可能需要更新参数/字段或登录选择器。已完成真实登录、组合查询、详情解析与 SQLite 入库联调，正式采集可在管理页追踪；完整验证记录见 [docs/verification.md](docs/verification.md)。自动化测试不保证网站今后不变更。
