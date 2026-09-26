---
project: SingChorus
type: development-principle
id: principle-core-001
description: 宿主只经 ChorusCore 门面使用 core 能力；日志与请求追踪等宿主能力经构造注入，core 保持零运行时依赖内核。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 门面唯一入口与宿主能力注入

## 原则详细描述

core 对外仅暴露 `ChorusCore` 门面与少量自包含工具（`packages/core/src/index.ts:1-13`）；门面在构造期组装服务（`core.ts:43-51`），宿主能力（Logger、getRequestId）经 `CoreOptions` 注入（`core.ts:13-22`）。panel 注入 pino child logger 与 AsyncLocalStorage 取请求 ID（`packages/panel/server/core-provider.ts:92-96`），ctl 全部省略注入项退回 console 默认（logger.ts:26-35）。

## 为什么要这样

panel（常驻、有日志/追踪体系）与 ctl（一次性 CLI）依赖风格完全不同；零依赖 + 注入让同一用例层被两宿主共享而不拖入任何运行时依赖（package.json:37-38 dependencies 为空，全局 ADR-004）。门面收敛使「配置变更后触发同步」这类横切语义有唯一挂点。

## 适用范围

- packages/core 全部新增公共能力；panel/ctl 对 core 的消费方式。

## 规则

- 新用例先落服务、再经门面暴露；不在服务层 import 宿主模块。
- 新宿主能力以最小接口注入（现仅 `logger?`、`getRequestId?`，core.ts:13-22）。
- 门面新增导出须进 `index.ts`；新类型进 `schemas/config.ts`。

## 反模式 / 禁止项

- 宿主直接 `new LocalStore()` 等绕门面（现存债务实例：core-provider.ts:50，core.ts:366-372 已承认，勿再新增）。
- core 内 hard-wire 日志库 / HTTP 客户端库。
- 在服务构造里读 panel 自身配置。

## 修改检查清单

- [ ] 新导出已加进 index.ts 且类型齐备
- [ ] 未引入任何运行时依赖（package.json dependencies 仍为空）
- [ ] 宿主注入项保持可选（CLI 可整体省略）
