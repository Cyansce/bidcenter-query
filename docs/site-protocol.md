# 采招网接口观察记录

观察日期：2026-09-13。以下来自网站正常加载的公开前端代码与可见页面，不包含用户 Cookie、Token 或验证码。

## 依据

- 搜索入口：<https://search.bidcenter.com.cn/>
- 搜索实现：[searchv17.js](https://static.bidcenter.com.cn/js/search/search/js/v3/searchv17.js)
- 搜索公共变量：[baseVariate.js](https://static.bidcenter.com.cn/js/search/search/js/v3/baseVariate.js?v=20241225)
- 搜索配置：[config.js](https://static.bidcenter.com.cn/js/search/js/config.js)
- 详情/登录统一请求封装：[app.707527bf.js](https://user.bidcenter.com.cn/v2023/static/js/app.707527bf.js)
- 详情组件：[chunk-31db1b9e.79e8bfec.js](https://user.bidcenter.com.cn/v2023/static/js/chunk-31db1b9e.79e8bfec.js)
- 登录页面：<https://sso.bidcenter.com.cn/login/>

## 搜索

`POST https://interface.bidcenter.com.cn/search/GetSearchProHandler.ashx`

表单字段 `from=6137, location=6138, guid, token, next_token, keywords, time=7, type=1,2, tag=0, mod=0, page, vtime`。全国不传地区限制。`keywords` 先 encodeURIComponent 再进行表单序列化，与原站 jQuery 一致。

服务器数据解码后主要结构：`ret`、`retbs`、`other`、`other2`。搜索 `other2` 中有 `listData`、`realInfoCount`、`showInfoCount`、`isFufei`。每页 40 条。原站对免费账户第十页后的结果限制访问。

列表字段由搜索页面 DOM 中 `#searchResult` 模板核对：`news_id`、`news_title_show`、`news_type`、`news_type_des`、`news_star_time_show`、`news_diqustr`、`news_url`、`news_zbje_show`、`news_cgfs`、`news_end_time_show`。

## 详情与会话检查

`POST https://interface.bidcenter.com.cn/zhaobiao/detail.ashx`

表单公共字段 `from=4037, guid, token`，详情 `location=7930, id, getjinzhan=1, gettags=1, gettj=1, limitip=1, getuserinfo=1, getzbt=1, isgethetong=1`。保留原站 limitip 等限制参数。

字段：`id, title, showTime, diqu, diqucity, diqucode, type, content, enddate, zhaobFangshi, zhaobJine, yezhu, daili, isLogin, isAllow`。

`POST /public/AuthorityHandler.ashx` 为原站初始化账户权限信息请求，用于校验会话，`from=4037, location=7928, guid, token`。

## 响应编码与状态

原站使用 AES-128-CBC / ZeroPadding，公开前端常量 `3zKzyf6eEfuDjAG3` / `fyUANZ0qSNZhhNCV`。解码限于当前账户服务器返回的数据；不会恢复会员遮盖或调用绕权接口。JSON 直接解析，不 eval。

`other=-100` 或 `retbs=-1/-100/400` 表示登录问题。详情 `retbs=999/998` 进入验证/访问限制流程；程序暂停人工处理。HTTP 303 也可能跳转 `HumanMachineVerificationTest4.shtml`，直接请求曾实际遇到此拦截，因此不自动跟随或无限重试。

## 登录

使用原站页面和 SSO 跳转建立会话。短信：`.login-tab .tab_yzm`、`#codeLogin_phone`、`#codeLogin_btn`、`#codeLogin_code`、`a[onclick="codeLogin_Click();"]`。密码：`#txtusername`、`#txtpassword`、`#login_login_btn`。

短信发送前调用 Aliyun 验证流程，获取服务要求的校验信息；程序通过正常按钮操作，验证码挑战由人完成。未直接重放缺少校验信息的发送短信接口。登录后从程序自己的 BrowserContext 导出 storageState，再用 APIRequestContext 调接口；不会读取或接管用户原有浏览器 Cookie。

## 版本依据

- [NestJS 12 迁移指南](https://docs.nestjs.com/migration-guide)
- [NestJS 定时任务](https://docs.nestjs.com/techniques/task-scheduling)
- [NestJS core registry](https://registry.npmjs.org/@nestjs/core/latest)
- [Prisma registry](https://registry.npmjs.org/prisma)
- [Prisma SQLite adapter 7.10.0](https://registry.npmjs.org/@prisma/adapter-better-sqlite3/7.10.0)

观察时 NestJS 稳定版为 12.0.1。Prisma CLI 的 latest tag 指向 8.0.0-rc.14，因此本项目统一固定已发布稳定版 7.10.0。间接依赖 multer、deepmerge-ts、mysql2 使用已修复版本 overrides；兼容性通过构建、迁移和测试验证。

## 人工 Chrome 回退

真实测试中 Playwright 登录窗口出现安全验证失败，页面错误字符串 `KqVFSkD21V`，没有明确说明成因。[阿里云官方 FAQ](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/captcha-2-0-client-access-faq) 指出模拟点击可能被识别并拦截；仅凭该页面不能确认具体触发规则。

因此默认增加普通 Chrome 人工登录：用专用配置目录启动系统 Chrome，用户自行完成表单/验证码，点击管理页“验证并保存会话”后才连接本地 CDP 并导出本站 session。没有修改验证码、注入指纹伪装脚本或移除验证弹层。自动表单方式保留为可配置选项。

真实登录后确认：浏览器存储的某些 Cookie 含 Node 请求头不接受的字符；APIRequestContext 默认携带这些 Cookie 时请求在本地失败。原站跨域请求通过表单 Token 认证，未启用跨域 Cookie，因此采集器显式发送空 Cookie 头，并保留 Token 校验。修正后 AuthorityHandler 返回 HTTP 200、ret=true。

查询语义实测：四词空格连接在全文近一周条件下返回零；用户原始顿号表达式返回 realInfoCount=12940、showInfoCount=1000（免费账号实际最多前10页）。因此默认使用用户原始顿号表达式，不宣称空格是逻辑 OR。接口自动扩展 time=7 的日期范围，本地再次按七个自然日过滤。
