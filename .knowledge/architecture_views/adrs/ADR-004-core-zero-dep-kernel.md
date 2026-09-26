---
project: "SingChorus"
type: adr
id: ADR-global-004
description: "@chorus/core 定位为零运行时依赖的可注入内核，panel/ctl/测试以宿主身份注入 Logger、getRequestId、存储实现，保证内核可被任意宿主加载。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "core 设计为零运行时依赖内核 + 宿主能力注入"
date: 2026-09-17
code_refs:
  - packages/core/package.json:37-38
  - packages/core/src/core.ts:13-22
---

# ADR-004: core 零运行时依赖内核 + 注入

## 状态

accepted

## 1. 背景

**业务背景**：同一套节点管理用例需要跑在常驻管理台（panel-server）与一次性 CLI（ctl）两种宿主中，二者依赖风格完全不同。
**技术背景**：项目初始化（commit 5b27269，2026-09-17）即确立 pnpm monorepo 与包边界。
**核心问题**：core 直接依赖具体实现库（HTTP 客户端、日志库），还是保持零依赖、由宿主注入能力？

**约束条件**：

- ctl 追求小体积、快速启动，不适合拖入 Web 框架级依赖
- panel 有成熟的日志/HTTP 上下文（Express 中间件）
- core 需要可测试（无文件系统/网络的单元测试）

## 2. 决策驱动因素

1. **多宿主复用**（高）：panel、ctl、未来分发形态共享同一用例层。
2. **测试与可移植**（中）：注入使测试用内存实现替换 IO。
3. **供应链面**（低）：内核依赖树最小化。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|core 直接依赖具体库|开发省事|ctl 被迫携带重依赖；测试需 mock 重|宿主行为不一致|
|Option B|零依赖 + 注入（采纳）|宿主可替换；API 边界即 dist 导出|接口样板代码；能力升级需动宿主|接口设计不当导致抽象泄漏|

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：core 的 `dependencies` 为空（`packages/core/package.json:37-38`），Logger/getRequestId 经构造注入（`core.ts:13-22`），CLI 宿主可整体省略注入项。配套纪律：panel/ctl 消费 dist，改 core 先 build（principles_009）。

### 4.1 实施要点

- 新能力以最小接口注入，禁止引入重依赖（principles_001 规则）
- 门面 ChorusCore 组装 6 服务（`core.ts:35-51`），对外仅暴露用例

## 备注

- 已知演进中债务：panel 的 core-provider 直接 `new LocalStore()` 绕过门面（`packages/panel/server/core-provider.ts:50`；`packages/core/src/core.ts:366-370` 注释承认）。
