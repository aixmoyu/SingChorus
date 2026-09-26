---
project: "SingChorus"
type: adr
id: ADR-core-001
description: core 保持零运行时依赖，日志与请求追踪经 CoreOptions 注入；panel 注入 pino+请求上下文，ctl 全省略。本 ADR 在模块内细化全局 ADR-004。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "core 零依赖内核在模块内的落地形态：CoreOptions 注入面"
date: 2026-09-24
code_refs:
  - packages/core/package.json:37-38
  - packages/core/src/core.ts:13-22
  - packages/core/src/logger.ts:1-13
  - packages/panel/server/core-provider.ts:92-96

---

# ADR-core-001: 零依赖内核的注入面（细化全局 ADR-004）

## 状态

accepted（细化全局 ADR-004，不改变其决策）

## 1. 背景

**业务背景**：同一套节点管理用例被 panel（常驻服务，有 pino 日志与 AsyncLocalStorage 请求追踪）与 ctl（一次性 CLI）两个宿主复用。
**技术背景**：core 需要日志与出站请求的 X-Request-ID 透传能力，但不得因此引入具体实现库。
**核心问题**：core 以何种形态获得宿主能力——直接依赖具体库，还是定义最小注入接口？

**约束条件**：

- ctl 追求小体积快启动（全局 ADR-004 驱动因素）
- 测试需静默运行（tests/ 全套 spec 均以 noop/默认 logger 运行）
- 注入面必须足够小，避免宿主升级被迫连锁改 core

## 2. 决策驱动因素

1. **多宿主复用**（高）：panel/ctl 同一用例层。
2. **测试与供应链**（中）：依赖树最小化、IO 可替换。
3. **演进成本**（低）：注入项越少越稳。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|core 直接依赖 pino/undici 等|功能即得|ctl 被迫携带重依赖；测试 mock 重|宿主行为不一致|
|Option B|最小注入接口 CoreOptions{logger?, getRequestId?}（采纳）|零依赖；CLI 可整体省略；测试注入 noop|接口样板；能力升级需动两宿主|接口设计不当致抽象泄漏|
|Option C|事件发射器（EventEmitter）解耦|极松耦合|宿主需自行接线，成本最高|时序难推理|

### Option B 详述

`CoreOptions` 仅两个字段（core.ts:13-22）：`logger`（四级别结构化接口，logger.ts:14-19）与 `getRequestId`（返回当前请求 ID 供出站 `X-Request-ID`，cloud-client.ts:128-134）。未注入时 consoleLogger 保留历史 console.warn/error 行为（logger.ts:26-35），noopLogger 供 SyncService 默认静默（sync-service.ts:34）。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：package.json `dependencies: {}`（:37-38）与注入面直接对应全局 ADR-004；panel 注入 pino child + currentRequestId（core-provider.ts:92-96），ctl 零注入可用，驱动因素 1/2/3 全部满足。

### 4.1 实施要点

- 新宿主能力先问「能否并入现有两个字段」；确需新增保持可选。
- 门面构造期一次性组装服务并把注入物下传（core.ts:43-51）。

## 备注

- 已知债务：panel 绕门面直读 store（core-provider.ts:50），属消费侧违规而非本决策缺陷（见 risk.md RISK-CORE-D3）。
