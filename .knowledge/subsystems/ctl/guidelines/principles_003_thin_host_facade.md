---
project: SingChorus
type: development-principle
id: principle-ctl-003
description: ctl 是 core 的轻宿主（thin host）：CLI 层零业务逻辑，所有能力经 ChorusCore 门面进程内复用；core 的宿主能力（logger/getRequestId）对 CLI 均可省略，CLI 不利用这一点之外任何注入。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# CLI 轻宿主：零业务逻辑，全部委托 core 门面

## 原则详细描述

core 运行时零依赖，IO 能力经注入反转：`CoreOptions` 提供 logger 与 getRequestId 两个可选宿主能力，注释明示「Panel wires this to its AsyncLocalStorage; CLI hosts omit it」（`packages/core/src/core.ts:12-22`）。ctl 正是该轻宿主案例：每个命令 action 内 `new ChorusCore()`（不传任何 options，`packages/ctl/src/commands/config.ts:9-11` 等），CLI 层只做参数校验、调门面、双模式输出。全局依赖方向因此保持单向无环：`ctl → core → (HTTP) → cloud`（`docs/knowledge/architecture_views/logical_view.md:59`）。

## 为什么要这样

- 业务规则只在一处（core）实现，panel 与 ctl 两条接入端自动保持语义一致——代码中多处显式对齐注释可证：config update 重渲染「与 panel 的 create/update 语义保持一致」（`packages/ctl/src/commands/config.ts:124-125`）、check-tag 降级「与 panel check-tag 语义一致」（`packages/ctl/src/commands/config.ts:221-222`）、cloud test「与 panel test-candidate 一致」（`packages/ctl/src/commands/cloud.ts:72`）。
- CLI 进程短生命周期、无请求上下文，注入 logger/getRequestId 无收益；省略注入使构造最简。
- 若 ctl 自行实现业务逻辑，双进程将产生规则漂移，且共享数据目录的一致性语义（core 文件锁）会被绕过。

## 适用范围

- packages/ctl/ 全部命令；未来新增 CLI 能力默认适用。

## 规则

- 命令 action 的代码形状固定为：参数校验 → `new ChorusCore()` → 调门面 → print 分流；发现业务分支逻辑（渲染/合并/重试策略）出现在 commands/*.ts 即违规。
- core 缺少所需能力时，先在 core 扩展 API，ctl 只做适配。
- 与 panel 的同名能力保持语义注释互引，改一侧须核对另一侧（config.ts:124-125、cloud.ts:72）。

## 反模式 / 禁止项

- 在 ctl 内直接读/写 `~/.singchorus` 数据文件或实现锁逻辑（写互斥归 core，`packages/core/src/services/store.ts:177-183`）。
- 在 ctl 内复制 core 的校验/渲染算法（如版本正则仅用于输入预检 `packages/ctl/src/commands/config.ts:14`，不得扩展为业务规则）。
- 为 CLI 注入 panel 专属宿主能力（AsyncLocalStorage 等）。

## 修改检查清单

- [ ] 新命令是否零业务逻辑、仅调 core API？
- [ ] 对应能力在 panel 侧的语义是否一致？
- [ ] 是否绕过了 core 的数据访问/锁封装？
