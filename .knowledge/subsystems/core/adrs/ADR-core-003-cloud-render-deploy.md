---
project: "SingChorus"
type: adr
id: ADR-core-003
description: 部署与协议渲染的事实源在云端；core 部署链路只做「落盘制品 + 驱动 compose + 健康检查回滚」，失败响亮、不本地回退。模块内细化全局 ADR-003。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "部署链路职责切分：云端渲染、core 落盘驱动、无本地回退"
date: 2026-09-24
code_refs:
  - packages/core/src/core.ts:421-454
  - packages/core/src/services/cloud-client.ts:352-388
  - packages/core/src/services/docker-manager.ts:68-72,249-302
  - docs/knowledge/architecture_views/adrs/ADR-003-cloud-single-source-render.md

---

# ADR-core-003: 部署链路职责切分（细化全局 ADR-003）

## 状态

accepted

## 1. 背景

**业务背景**：部署 = 渲染 sing-box 服务端配置 + compose 编排 + entry 启停脚本；订阅端读的客户端配置必须与节点实际运行的一致。
**技术背景**：core 历史上曾有本地模板装配能力（merger.ts 仍在，作为 generateServerConfig/Subscription 的显式回退 API）。
**核心问题**：部署制品在哪渲染——本地模板、云端单点，还是双源降级？

**约束条件**：

- 订阅与部署必须同源，否则「订阅到的 ≠ 运行中的」
- cloud 可能先于 core/旧版本部署（端点可能缺失）
- 前端 30s 超时下用户可能重复点击

## 2. 决策驱动因素

1. **一致性**（高）：订阅与部署同一渲染源。
2. **可解释性**（高）：失败必须响亮可诊断。
3. **core 简单性**（中）：不维护模板副本。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|core 内嵌模板本地渲染|离线可部署|模板双份漂移；订阅与部署不一致|静默服务旧配置|
|Option B|云端单点渲染 + 失败响亮（采纳）|单一事实源；core 零模板|cloud 不可用则部署不可用|SPOF（由退避与告警缓解）|
|Option C|云端优先本地降级|可用性最高|降级不可见，漂移不可知|违背 fail-loudly|

### Option B 详述

core.deploy 流程（core.ts:428-454）：校验 enabled 非空 → 注入版本 pin 调 `renderDeploy`（POST /api/render/deploy，cloud-client.ts:357-388）→ `deployRendered` 落盘（备份→原子写三制品→chmod→compose up→30s 健康窗口→过则写 deploy-meta，败则 down+恢复备份+抛错，docker-manager.ts:249-302）。DockerManager 类注释明示「No local templates」（:68-72）；空制品直接抛（:255-256）；端点 404 报 `CLOUD_ENDPOINT_MISSING` 提示升级 cloud（cloud-client.ts:372-375）。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：一致性（因素 1）只有单源可保证；响亮失败（因素 2）排除 Option C；零模板（因素 3）排除 Option A。cloud SPOF 为接受的设计代价（全局 ADR-003 同结论）。

### 4.1 实施要点

- 备份（≤5 份）→ 原子写 → 健康检查（3s 轮询 ≤30s）→ 元信息落盘顺序不可调换。
- 部署成功后 `markDeployed(enabled 名单)` 交 panel 触发同步上报 deployed（core.ts:451-453）。
- 版本 pin 由 core 从 AppConfig 注入（core.ts:434-445）。

## 备注

- merger.ts 本地装配保留但被注释定位为 fallback API（merger.ts:11-13），部署链路零引用。
