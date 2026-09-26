---
project: "SingChorus"
type: adr
id: ADR-global-006
description: "发布通道决策：npm 包内嵌预编译产物（panel bin 不编译只加载 dist-server），GHCR 镜像双通道（tag→semver+latest，main→edge），推送 amd64+arm64 双架构。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "npm 内嵌预编译产物 + GHCR 双通道镜像发布"
date: 2026-09-17
code_refs:
  - packages/panel/bin/chorus-panel.mjs:4-8
  - .github/workflows/docker-cloud.yml:45-69
---

# ADR-006: npm 内嵌预编译产物 + GHCR 双通道发布

## 状态

accepted

## 1. 背景

**业务背景**：用户获取 SingChorus 的渠道有三类——npm 全局安装（panel/ctl）、自托管 Docker（cloud/panel）、Workers 部署（cloud）。需要一条可追溯、低门槛的发布链路。
**技术背景**：pnpm monorepo 经 dist 产物消费包间依赖（改 core 先 build，principles_009）；GH Actions 为唯一 CI。
**核心问题**：npm 包分发源码（装后构建）还是预编译产物？Docker 镜像版本通道如何设计才能兼顾「稳定版」与「跟主线」两类用户？

**约束条件**：

- 用户机器未必有完整工具链（构建依赖越少越好）
- 自托管用户需要能跟进主线修复（edge）也要能锁版本（tag）
- GH Actions 免费额度内的双架构构建成本

## 2. 决策驱动因素

1. **安装即用**（高）：npm 安装后不得要求用户先跑构建。
2. **版本策略双轨**（高）：生产锁 semver、尝鲜跟 edge。
3. **与 monorepo 纪律同源**（中）：镜像内产物必须与 pnpm 构建产物一致（根上下文构建，`packages/cloud/Dockerfile:2-3,15`）。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|npm 发布源码、install 时构建|包体小|要求用户工具链；install 慢且易失败|用户侧构建环境差异|
|Option B|npm 内嵌 dist + GHCR 双通道（采纳）|安装即用；锁版与跟线兼得|仓库内含构建产物需同步 core dist|产物过期/不一致|
|Option C|仅 Docker 分发|单一通道|排除非 Docker 用户|—|

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：panel 的 bin 入口明确注释不编译、只加载 dist-server（`packages/panel/bin/chorus-panel.mjs:4-8`），安装即用（因素 1）；docker-cloud workflow 以 tag `cloud-v*`/`panel-v*` → semver+latest、main → `edge` 双通道并推 amd64+arm64（`docker-cloud.yml:45-69`，因素 2）；镜像构建上下文为仓库根，产物与本地产物同源（因素 3）。

### 4.1 实施要点

- 发布 tag 命名规范：`cloud-v*` / `panel-v*` 触发对应镜像
- edge 通道仅出自 main 分支，便于用户回退到固定 semver
- core dist 变更必须先构建再打下游包（CI 顺序固化）

## 备注

- 风险：`packages/core/pnpm-lock.yaml` 被跟踪违反单一 lockfile 纪律，会破坏安装一致性 → [../risk.md](../risk.md)。
