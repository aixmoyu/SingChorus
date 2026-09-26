---
project: "SingChorus"
type: development-principle
id: principle-global-001
principle_scope: 模块级（core）
description: "core 作为内核保持零运行时依赖，一切 IO 能力（日志、请求 ID、存储宿主）经构造注入，使 panel/ctl/cloud 等宿主可替换实现。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构-内核设计
---

# 零依赖内核与宿主能力注入

## 原则详细描述

`@chorus/core` 的 package.json 无任何 `dependencies`（`packages/core/package.json:37-38`），ChorusCore 门面所需的 Logger、getRequestId 等宿主能力全部经构造参数注入（`packages/core/src/core.ts:13-22`）。内核只含用例编排与领域逻辑，文件系统、HTTP、容器驱动等副作用由宿主（panel-server / ctl / 测试）提供实现。相关决策记录见 ADR-004（零依赖内核选型）。

## 为什么要这样

- core 被 panel、ctl 两个形态截然不同的宿主消费（长驻 Express 进程 vs CLI 短进程），硬编码宿主能力会强制二者携带无用依赖。
- 零依赖使 core 可被任意运行时（Node、测试、未来 CLI 之外的分发形态）直接加载，发布包体积与供应链面最小。
- 注入反转让测试可用内存实现替换文件存储，无需 mock 文件系统。

## 适用范围

- 模块级：`packages/core/`。panel/ctl/cloud 不受「零依赖」约束，但消费 core 时必须以注入方身份提供宿主能力。

## 规则

- core 新增能力需求时，先定义最小接口并由宿主注入，禁止在 core 内直接 import node:io/fs 以外的重依赖或第三方 SDK。
- 新增第三方需求必须先论证无法以注入接口抽象。

## 反模式 / 禁止项

- 在 core 中引入 express、axios 等具体宿主实现。
- 为图省事在 core 内直接读取 `process.env` 作为配置通道（应由宿主注入配置）。

## 修改检查清单

- [ ] 修改后 `packages/core/package.json` 仍无 dependencies（或新增项经过论证）？
- [ ] 新能力是否以接口注入、宿主可替换？
- [ ] panel/ctl 消费路径（dist 构建，见 principles_009）是否同步更新？
