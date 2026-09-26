---
project: SingChorus
type: adr
id: ADR-ctl-001
description: --json 输出契约确立为「单次调用的进程内存态」，不持久化、不跨调用生效；JSON 形态稳定、人读文案不承诺稳定，脚本一律走 --json。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-ctl-001: --json 契约的内存态化与双模式输出边界"
date: 2025-01-01 [待确认: 代码无日期痕迹，以 git blame 补证]
code_refs:
  - packages/ctl/src/config.ts
  - packages/ctl/src/index.ts
  - packages/ctl/src/utils.ts

---

# ADR-ctl-001: --json 契约的内存态化与双模式输出边界

## 状态

accepted（细化全局决策 R-CTL-D4，见 `packages/ctl/src/index.ts:19`、`docs/knowledge/architecture_views/scenario_view.md:81`）

## 1. 背景

**业务背景**：运维脚本与 CI 需要以编程方式调用 chorusctl 并解析结果（场景视图：脚本调用 `chorus ctl <command> --json` 消费 JSON 契约）。
**技术背景**：CLI 同时服务人类操作员（需要彩色文案/表格）与脚本（需要稳定结构）；旧版本实现曾把 json 开关持久化到 `~/.singchorus/ctl/config.json`。
**核心问题**：--json 应该是持久偏好还是单次调用参数？输出稳定性承诺划在哪一侧？

**约束条件**：

- 单一可执行文件、无守护进程：输出模式必须无跨调用副作用
- 人读体验要求随迭代自由调整文案

## 2. 决策驱动因素（Decision Drivers）

1. **无副作用**（重要性：高）：持久化的 json 开关会让「脚本拿 JSON、人拿文案」互相踩踏（上次调用残留状态）。
2. **契约稳定**（重要性：高）：脚本只能依赖结构化输出；文案必须可自由改。
3. **实现简单**（重要性：中）：preAction 钩子 + 进程内布尔即可（`packages/ctl/src/index.ts:22-25`）。

## 3. 候选方案（Considered Options）

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|持久化 json 偏好到 ~/.singchorus/ctl/config.json|人类一次配置长期生效|跨调用副作用；脚本与人互相污染；需处理配置文件读写失败|已发生并被判定为缺陷|
|Option B（采纳）|--json 为单次调用 CLI 参数，进程内存态|零副作用；每次调用显式声明；实现 14 行|人类脚本化场景需每次带 flag|无|
|Option C|环境变量 CHORUS_JSON=1|适合容器场景|两个入口语义重复；优先级规则复杂|低|

### Option A：持久化偏好（被否决）

旧实现把 `jsonOutput` 写入 `~/.singchorus/ctl/config.json`，导致一次 `--json` 调用影响后续人类交互。代码注释记录了结果：「旧版本曾把 jsonOutput 持久化到 ~/.singchorus/ctl/config.json，项目未上线，直接移除该副作用」（`packages/ctl/src/config.ts:1-5`）。

### Option B：单次调用内存态（采纳）

`config.ts` 仅保留 `let jsonOutput = false` + set/is 两个函数（`packages/ctl/src/config.ts:6-14`）；`--json` 经 commander 全局 option 与 preAction 钩子每次调用前置位（`packages/ctl/src/index.ts:21-25`）。

## 4. 决策结果（Decision Outcome）

**选择方案**：**Option B**
**选择理由**：对照驱动因素——消除跨调用副作用（因素1）只能靠内存态；契约稳定（因素2）通过「JSON 形态稳定 + 文案不承诺稳定」的双侧边界实现（`packages/ctl/src/index.ts:19`）；实现成本最低（因素3）。

### 4.1 实施要点

- 全部输出经 `isJson()` 分流：print* 家族（`packages/ctl/src/utils.ts:75-209`）
- 错误出口契约化：`fail()` → `{ok:false, error[, detail]}` + exit 1（`packages/ctl/src/utils.ts:16-24`）
- 契约声明写入程序 description（`packages/ctl/src/index.ts:19`）

## 备注

- 该 ADR 细化全局 R-CTL-D4；全局场景引用见 `docs/knowledge/architecture_views/scenario_view.md:81`。
- 遗留缺口：契约目前无机器校验（仅注释维系），见 `docs/knowledge/subsystems/ctl/risk.md` RISK-CTL-003。
