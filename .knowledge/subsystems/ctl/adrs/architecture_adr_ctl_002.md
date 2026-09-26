---
project: SingChorus
type: adr
id: ADR-ctl-002
description: panel start 采用「已安装包优先 → monorepo 按需构建回退 → npx 提示兜底」的三级入口解析，并把缺失 node/pnpm 的裸 ENOENT 前置为带恢复命令的友好错误。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-ctl-002: panel start 的入口解析顺序与构建前置检查"
date: 2025-01-01 [待确认: 代码无日期痕迹，以 git blame 补证]
code_refs:
  - packages/ctl/src/commands/panel.ts

---

# ADR-ctl-002: panel start 的入口解析顺序与构建前置检查

## 状态

accepted（决策痕迹以代码注释 R-CTL-D2/R-CTL-D3 留存，`packages/ctl/src/commands/panel.ts:13-17,69-70`）

## 1. 背景

**业务背景**：VPS 操作员经 `chorusctl panel start` 启动 Web 管理台；panel 可能以 npm 已安装包（发布 tarball）或 monorepo dev checkout 两种形态存在。
**技术背景**：npm 发布包内含预编译 dist-server，无需构建；monorepo 源码形态必须按需 pnpm 构建；两种形态缺失时的原始报错是 ENOENT/npm 堆栈。
**核心问题**：panel server 入口如何解析，才能同时覆盖「已发布安装」与「源码开发」两种部署形态，并让失败可自助恢复？

**约束条件**：

- 发布 tarball 不应要求用户装 pnpm
- dev checkout 的按需构建依赖 pnpm（monorepo 工具链）

## 2. 决策驱动因素（Decision Drivers）

1. **零构建优先**（重要性：高）：已安装包自带 dist-server，任何构建步骤都是浪费（`packages/ctl/src/commands/panel.ts:30-36`）。
2. **可自助恢复**（重要性：高）：错误信息必须给出等效手动命令而非内部堆栈（R-CTL-D2，`packages/ctl/src/commands/panel.ts:13-17,22-25`）。
3. **前置失败**（重要性：中）：pnpm/node 缺失应在构建开始前检查，而非中途 ENOENT（R-CTL-D3，`packages/ctl/src/commands/panel.ts:69-77`）。

## 3. 候选方案（Considered Options）

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|仅支持已安装包，源码场景提示自行启动|实现最简|开发体验差|无|
|Option B（采纳）|已装包 → monorepo 按需构建 → npx 提示，三级解析|两种形态全覆盖；每级失败给出恢复命令|解析逻辑较长（~55 行）|构建依赖宿主 pnpm（已前置检查缓解）|
|Option C|ctl 内嵌 panel server 打包|单文件交付|耦合两包发布节奏；包体积膨胀|高|

### Option B：三级解析详述

1. `require.resolve('@chorus/panel/package.json')` 定位已装包，检查 `dist-server/index.js` 存在即用；缺预编译产物则报「重新安装」并退出（`packages/ctl/src/commands/panel.ts:40-53`）。
2. 回退到 monorepo 同级 `packages/panel`：先检查 node 与 pnpm（缺失给安装指引），再按需 `pnpm --filter @chorus/panel build:server` / `build`（`packages/ctl/src/commands/panel.ts:55-89`）。
3. 两者皆无：报「包未找到」并提示 `npx @chorus/panel start`（`packages/ctl/src/commands/panel.ts:100-105`）。

## 4. 决策结果（Decision Outcome）

**选择方案**：**Option B**
**选择理由**：零构建优先（因素1）决定已装包分支在前；可自助恢复（因素2）决定每级失败的文案都附手动命令；前置失败（因素3）决定 pnpm 检查先于任何构建。

### 4.1 实施要点

- 构建步骤统一经 `runBuildStep`，失败文案给出「在仓库根目录手动执行: <命令>」（`packages/ctl/src/commands/panel.ts:18-27`）
- 启动为 spawn 子进程，注入 `CHORUS_PANEL_PORT/HOST`，退出码透传（`packages/ctl/src/commands/panel.ts:107-114`）

## 备注

- panel 运行时与 ctl 构成共享 `~/.singchorus/data` 的双进程，互斥归 core 文件锁（`docs/knowledge/architecture_views/process_view.md:16`、`packages/core/src/services/store.ts:17,177-183`）。
