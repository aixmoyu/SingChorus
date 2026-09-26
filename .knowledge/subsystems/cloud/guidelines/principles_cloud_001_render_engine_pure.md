---
project: SingChorus
type: development-principle
id: principle-cloud-001
description: cloud 渲染引擎是纯逻辑层——除 PluginRegistry 构造函数注入 D1Database 外，engine/ 全目录零 IO、零运行时分支，因此可独立测试并在双运行时行为完全一致。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 渲染引擎纯逻辑零 IO

## 原则详细描述

`src/engine/` 承载模板参数解析、占位符插值、随机值生成、docker YAML 序列化与 semver 兼容判定。这一层不读取 env、不发起 D1 查询、不感知 Workers/Node 差异；唯一例外是 `PluginRegistry` 通过**构造函数**接收 `D1Database`（engine/registry.ts:146-155），模板加载发生在 `loadAll()` 的显式调用点，渲染计算本身仍只操作已载入内存的数据。

## 为什么要这样

- Workers 与 Node 双运行时共享同一 app；纯函数层保证渲染结果与运行时无关（node/d1-sqlite.ts:1-12 的适配器只服务 IO 层）。
- 引擎行为由 tests/plugins/ 全套单测（interpolator/registry/generators/validator/docker_renderer/errors/integration）在无云环境钉死。
- 插值器对「未解析占位符」的告警降级而非抛错（interpolator.ts:61-76），这类策略只有收敛在纯函数层才可能行为统一。

## 适用范围

- packages/cloud/src/engine/ 全部新增文件；任何模板变换逻辑。

## 规则

- engine/ 内禁止 `c.env`、`process.env`、fetch、D1 调用；需要数据由调用方传入。
- 新增模板能力（新占位符/生成器）先在 engine 落纯函数 + 单测，路由层只做编排。
- 唯一允许的 IO 入口是 `PluginRegistry` 构造注入与 `loadAll()`（registry.ts:153-170）。

## 反模式 / 禁止项

- 在 interpolator/validator/generators/compat/docker_renderer 内直接查库或读环境变量。
- 为图方便把路由层的 zod schema 校验塞进引擎（边界校验属路由层职责）。

## 修改检查清单

- [ ] 新代码是否引入了任何 IO/运行时分支？
- [ ] 对应 tests/plugins/ 用例是否覆盖？
- [ ] PluginError 语义是否保持（index.ts:83-86 统一映射 400）？
