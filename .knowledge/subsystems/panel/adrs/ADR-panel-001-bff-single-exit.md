---
project: SingChorus
type: adr
id: ADR-panel-001  # ADR-<module_id>-<nnn>
description: SPA 不直连 @chorus/core 与云端，所有运行时数据经自家 Express BFF 的 /api 出入；前端对 core 仅有 type-only 依赖，运行时耦合为零。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "SPA 经 BFF 单出口访问 core 与云端"
date: 2026-09-17
code_refs:
  - packages/panel/src/lib/http.ts:10-22
  - packages/panel/server/app.ts:119-123
  - packages/panel/src/lib/types.ts:1-6
  - packages/panel/server/core-provider.ts:15
---

# ADR-panel-001: SPA 经 BFF 单出口访问 core 与云端

## 状态

accepted

## 1. 背景

**业务背景**：panel 是单管理员 Web 控制台，浏览器需要操作本地配置存储、docker 部署与云端（Cloud Worker）协同。
**技术背景**：core（Node 直连本地资源）、cloud（Workers 上的 HTTP 服务）与 SPA（浏览器）运行环境各异；core 的 API 面向进程内调用而非 HTTP。
**核心问题**：浏览器端如何获得 core 能力与云端数据，同时不把本地文件路径、docker 调用与云端凭证暴露给前端？

**约束条件**：

- 云端 token（core_token）与 JWT secret 必须只存在服务端
- 同源部署为主（生产 app 托管静态文件，app.ts:131-135），开发用 Vite 代理（vite.config.ts:23-28）

## 2. 决策驱动因素

1. **凭证与资源隔离**（高）：docker.sock、config.json、云端 token 都不能进浏览器。
2. **错误语义统一**（高）：core/云端失败形状在 BFF 层翻译为稳定信封，前端不感知 core 内部错误。
3. **认证收敛**（中）：Cookie JWT 验签只在服务端，前端只持状态不持逻辑。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|SPA 直连云端 Worker（token 下发前端）|少一层服务|token 暴露；本地配置/docker 能力无从谈起|凭证泄漏；功能残缺|
|Option B|BFF 包装全部能力（采纳）|凭证不出服务端；错误/认证/日志统一；前端可单测（supertest 打 app）|多一跳转发；需维护两套类型|BFF 成为瓶颈点（单管理员规模可忽略）|
|Option C|core 编译为浏览器可用工件|代码复用|core 依赖 fs/docker，不可行|-|

### Option B：BFF 单出口（采纳）

axios 实例固定 `baseURL: '/api'` + `withCredentials`（http.ts:10-22）；Express 挂载 auth/core/settings/info/init 五组路由（app.ts:119-123）；server 侧 core 访问收敛于 core-provider（core-provider.ts:15）。前端唯一的 core 依赖是 **type-only** 导入（src/lib/types.ts:1-6），构建后为零运行时耦合。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：唯一同时满足凭证隔离、本地资源（fs/docker）可达与错误语义统一约束的方案；代价（一跳转发、类型双份）在单管理员规模下可忽略。

### 4.1 实施要点

- 全部前端请求走共享 axios 实例；401 拦截含 login/setup 循环断路器（http.ts:24-45）
- 前端超时 30s 必须 > core REQUEST_BUDGET_MS 25s，让云不可达以结构化信封呈现而非前端超时（http.ts:18-21；packages/core/src/services/cloud-client.ts:59）
- 未知 /api 路径必须 JSON 404，先于 SPA catch-all（app.ts:126-129）

## 备注

- 与全局 ADR-004（core 零依赖内核）互补：panel 是 core 的 HTTP 适配层之一（ctl 是另一个）。
- 前端类型经 `Omit`/扩展做视图层适配（node_fingerprint 等，types.ts:10-19），不直接复用 core 类型全量面。
