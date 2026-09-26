---
project: SingChorus
type: adr
id: ADR-panel-002  # ADR-<module_id>-<nnn>
description: npm 包直接内置预编译产物（dist-server + dist-web），bin 入口不编译只加载；容器场景则在镜像内从源码构建。双通道共用同一构建命令，npx 用户零构建工具依赖。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "npm 包预编译产物交付（bin 只加载不编译）"
date: 2026-09-17
code_refs:
  - packages/panel/bin/chorus-panel.mjs:4-9,46-51
  - packages/panel/package.json:12-19
  - packages/panel/Dockerfile:22-26
---

# ADR-panel-002: npm 包预编译产物交付（bin 只加载不编译）

## 状态

accepted

## 1. 背景

**业务背景**：panel 面向 VPS 自托管用户，理想路径是 `npx @chorus/panel start` 一条命令可用；同时 CI 要产出 docker 镜像。
**技术背景**：panel 是 TypeScript + Vue SaaS 源码（tsx/vite/vue-tsc），core 以 dist 产物被引用（Dockerfile:24 注释）；用户机器未必有构建工具链。
**核心问题**：如何让 npx 用户零构建工具可用，又不维护两套构建流程？

**约束条件**：

- node>=20（package.json:20-22）；npm tarball 只含 bin/dist-server/dist-web（package.json:15-19）
- monorepo 内开发仍需源码级 HMR（tsx watch + vite，package.json:27-29）

## 2. 决策驱动因素

1. **用户启动延迟**（高）：npx 现场编译 TS/Vue 需要工具链且慢，失败面大。
2. **单一构建事实**（高）：`pnpm build`（vue-tsc + vite build + tsc server）是唯一构建入口，npm 包与 Docker 镜像消费同一产物。
3. **发布可重复**（中）：预编译产物随版本冻结，安装即所得。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|发布 TS 源码，安装时/启动时编译|包体积小|要求用户机器有完整工具链；启动慢|tsx/vue-tsc 版本漂移致安装失败|
|Option B|tarball 内置 dist-server+dist-web，bin 仅校验存在后 import 加载（采纳）|零构建依赖、秒级启动；Docker 内仍从源码构建同一产物|tarball 体积大（含静态资源）；产物必须先构建才能发版|忘构建即发版→bin 显式报错兜底（bin:46-49）|
|Option C|发布独立二进制（pkg/bun compile）|单文件分发|跨平台矩阵维护重；与 pnpm monorepo 链接解析冲突|构建复杂度|

### Option B：预编译产物 + 只读 bin（采纳）

bin 入口只做三件事：解析 --port/--host 为 CHORUS_PANEL_* 环境变量、校验 dist-server/index.js 存在（缺失则提示重新安装或仓内构建）、`await import(serverEntry)`——服务端模块在 import 时自行监听（bin/chorus-panel.mjs:4-9,37-51；index.ts:7-18）。Docker 路径则多阶段构建：core 先 build（panel 引其 dist），prod 依赖按 panel 闭包重装（Dockerfile:22-33）。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：同时满足「npx 零工具链」与「单一构建入口」；Option A 把构建成本转嫁给最不该承担它的用户，Option C 的维护成本与其收益不成比例。

### 4.1 实施要点

- 发版前必须 `pnpm --filter @chorus/panel build`；files 白名单只带三个产物目录（package.json:15-19）
- bin 缺产物时显式中文报错并给修复命令（bin:46-49）
- 容器内保持 pnpm 相对符号链接布局原样 COPY，保证 panel→core→.pnpm 解析链（Dockerfile:43-53）

## 备注

- 与全局 ADR-006（发布通道）衔接：npm 包与 GHCR 镜像是同一产物的两种载体（docker-compose PANEL_IMAGE 可切 GHCR，docker-compose.yml:20-21）。
- 版本号在 server/info 路由存在硬编码副本（info.ts:26），见 risk.md 技术债条目。
