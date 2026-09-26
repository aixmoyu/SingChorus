---
project: SingChorus
type: development-principle
id: principle-core-004
description: 云端调用统一走 request 通道：25s 总预算截断一切尝试与退避；5xx 指数退避；401 换 token 仅重试一次；尽力而为调用显式 noRetry。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 工程
---

# 云端调用的预算与退避纪律

## 原则详细描述

`REQUEST_BUDGET_MS = 25_000` 是单个逻辑请求（全部尝试+退避睡眠）的总预算，逐次尝试超时取 `min(10s, 剩余预算)`（cloud-client.ts:34-35,49-59,156-166）。5xx 与网络错误按 `[1,4,16,64]s` 退避，睡眠被剩余预算截断（:34,206-228）；401 清缓存令牌仅首试重试一次（:182-204）；预算耗尽抛 `CLOUD_UNREACHABLE` 503 信封，消息含末次状态与指引（:231-238）。`noRetry` 供标签预检等「任何失败都视为可用」的尽力而为调用快速失败（:14-18,511-522）。

## 为什么要这样

预算必须低于 panel 前端 30s axios 超时，否则不可达云端以 opaque timeout 呈现而非结构化错误信封（cloud-client.ts:49-53 注释，core-D2；panel/src/lib/http.ts:18-25 锚定同一常量）。拉取侧复用同一常量做整轮并行预算（core.ts:273-282，core-P3），两处不各自维护。

## 适用范围

- cloud-client.ts 全部端点方法；任何新增云端调用；同步拉取的整轮预算。

## 规则

- 新端点必须经 `request()`，禁止裸 fetch 绕过预算/重试/追踪（X-Request-ID 注入在 :128-134）。
- 按语义设置 noRetry：调用方已把失败当「可用/放行」的预检必须 noRetry。
- 错误码遵守 `CLOUD_*` 家族 + HTTP 502/503 信封。

## 反模式 / 禁止项

- 在 request 之外自行重试（双重退避放大）。
- 把 getClients 等列表失败当空数组（会触发全量重传，:390-399 专设抛错）。
- 调大 REQUEST_BUDGET_MS 而不同步核对前端 30s 锚点。

## 修改检查清单

- [ ] 走 request() 通道且错误码入 ERRORS/信封
- [ ] 预算改动已核对 panel 前端 http.ts 30s 与 core 拉取预算两锚点
- [ ] 尽力而为调用已标 noRetry
