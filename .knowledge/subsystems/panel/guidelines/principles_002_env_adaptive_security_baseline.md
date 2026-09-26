---
project: SingChorus
type: development-principle
id: principle-panel-002  # scope=module (panel)
description: panel 的安全基线必须按「实际运行环境」而非构建期常量（NODE_ENV）分支：Cookie secure 取 req.secure、CORS 生产强制白名单、生产 5xx 响应脱敏但服务端全量留痕、日志一律 redact 密钥。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 工程
---

# 按运行环境自适应的安全基线

## 原则详细描述

panel 面向「127.0.0.1 本地直连」与「反向代理终结 HTTPS」「0.0.0.0 明文 HTTP」三种真实部署形态。安全相关分支（Cookie 属性、CORS、trust proxy、错误脱敏）必须依据**每个请求的实际信号**（req.secure、Origin、X-Forwarded-*）或显式环境变量，而不是 NODE_ENV 一个构建期常量。标志性教训：cookie secure 曾按 NODE_ENV 设置，导致纯 HTTP 生产部署中浏览器静默丢弃 Secure Cookie，每次登录都陷入不可见的 401 死循环；修复为按 `req.secure`（直连 TLS 与受信代理终结 HTTPS 均为真）后问题消失（server/auth.ts:110-116，修复提交 2026-09-20）。

## 为什么要这样

- 自托管用户的部署形态无法在构建期枚举；NODE_ENV=production 既可能是 HTTPS 反代，也可能是明文 HTTP 直曝。
- Cookie 标志错误是**静默**失败：浏览器丢弃 Cookie 不报错，用户只见「登录成功→又跳回登录」。
- 反向追踪同一事故的另一环：前端 401 拦截在 login/setup 页上必须有循环断路器，否则坏 Cookie 会无限弹跳（src/lib/http.ts:32-42）。

## 适用范围

- packages/panel/server/（auth.ts、env.ts、app.ts）与 src/lib/http.ts 的认证相关分支。

## 规则

- Cookie `secure` 只取 `req.secure`；`issueToken` 与 `clearToken` 的 Cookie 属性必须镜像一致（auth.ts:106-132）。
- 同站策略：生产 strict、开发 lax（auth.ts:110）；CSRF 由 originCheck 中间件补强——非幂等请求要求 Origin 同源或命中白名单，无 Origin（curl/服务间）放行（app.ts:22-56）。
- CORS：开发反射、生产白名单（CHORUS_PANEL_CORS_ORIGIN 未设时生产直接拒绝，env.ts:24-31）。
- 反代后必须设 CHORUS_PANEL_TRUST_PROXY，限流才按真实客户端 IP 计数；未前置代理时保持 false 防 X-Forwarded-For 伪造（env.ts:33-50）。
- 生产 5xx 响应统一 "Internal server error"，但服务端**必须**记录完整 err+stack——省略该日志曾使 VPS 故障不可排查（app.ts:137-151）。
- 日志 redact password/token/authorization/cookie，任何级别不泄漏（logger.ts:17-29）。

## 反模式 / 禁止项

- 以 NODE_ENV 推断请求是否走 HTTPS。
- 新增 Cookie 时 issue/clear 两处属性不一致。
- 生产 5xx 把内部错误消息（路径、fs 错误）透传给客户端。
- 为调试临时移除 redact 或 originCheck。

## 修改检查清单

- [ ] 安全分支是否由请求信号或显式 env 驱动，而非 NODE_ENV？
- [ ] issueToken/clearToken 属性是否同步？
- [ ] 前端 401 处理是否豁免 /auth/* 端点与 login/setup 页？
- [ ] 新增敏感字段是否需要加入 logger redact 路径？
- [ ] 部署文档/compose 注释是否同步了 TRUST_PROXY/CORS 提示？
