---
project: SingChorus
type: adr
id: ADR-panel-003  # ADR-<module_id>-<nnn>
description: 细化全局 ADR-005：DooD 下 cloud 渲染的相对卷路径由 panel 容器侧 docker CLI 转为绝对路径后交宿主 daemon 解析，故容器内 $HOME/.singchorus 必须与宿主逐字一致；用 SINGCHORUS_HOME 单点控制两侧。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "DooD 路径一致性约束与 SINGCHORUS_HOME 单点控制（细化 ADR-005）"
date: 2026-09-17
code_refs:
  - packages/panel/docker-compose.yml:1-14,26-28,36-38
  - packages/panel/Dockerfile:6-9
---

# ADR-panel-003: DooD 路径一致性约束与 SINGCHORUS_HOME 单点控制（细化全局 ADR-005）

## 状态

accepted（细化 architecture_views/adrs/ADR-005-panel-dood.md，不替代）

## 1. 背景

**业务背景**：panel 容器内经挂载的宿主 docker.sock 驱动 sing-box 容器（DooD，非 privileged）。
**技术背景**：sing-box 的 compose 由 cloud 渲染，使用 `./data`、`./tls` 相对卷；该 compose 在 **panel 容器内**由 docker CLI 展开——相对路径以 panel 容器的 cwd/$HOME 为基准转成绝对路径（如 `$HOME/.singchorus/docker/...`），随后由**宿主 daemon** 在宿主文件系统上解析（docker-compose.yml:1-11 注释；Dockerfile:6-9 注释）。
**核心问题**：同一路径字符串被两个文件系统视角先后消费，如何保证宿主上解析到的就是 panel/core 写入的那一份？

**约束条件**：

- panel 容器已把宿主 `$HOME/.singchorus` 原样挂载（docker-compose.yml:38）
- 默认用户是 root 部署的 VPS（$HOME=/root）；非 root 用户路径不同

## 2. 决策驱动因素

1. **挂卷有效性**（高）：路径不一致时 sing-box 容器会挂到宿主上不存在的目录，表现为服务静默异常。
2. **配置零分发**（中）：不能要求用户手改 compose 内多处路径。
3. **开箱即用**（中）：root 部署（默认 /root）无需任何设置。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|约定路径恒为 /root/.singchorus|实现最简|非 root 用户必坏|静默挂错卷|
|Option B|SINGCHORUS_HOME 同时注入容器 HOME 与卷挂载两侧（采纳）|一处变量控制两侧；默认值即 root 开箱即用|用户须理解「两侧路径必须一致」|漏设环境变量（已用 compose 默认值缓解）|
|Option C|改用 DinD 或命名卷绕开路径问题|无路径映射|DinD=privileged（违背 ADR-005）；命名卷使 core 的文件存储与宿主脱节|架构回退|

### Option B：SINGCHORUS_HOME 单点控制（采纳）

`HOME: ${SINGCHORUS_HOME:-/root}`（docker-compose.yml:28）与卷声明 `- ${SINGCHORUS_HOME:-/root}/.singchorus:${SINGCHORUS_HOME:-/root}/.singchorus`（docker-compose.yml:38）取同一变量，容器内外锚点天然一致；非 root 场景一条命令：`SINGCHORUS_HOME=/home/admin docker compose up -d --build`（docker-compose.yml:11）。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：在 DooD 模型（ADR-005）不动摇的前提下，把「双文件系统视角消费同一路径」的风险压缩为一个显式变量；默认值覆盖主流 root 部署，文档注释明示风险与安全提示（sock≈宿主 root，docker-compose.yml:13-14）。

### 4.1 实施要点

- 容器监听 0.0.0.0:8088，端口经 PANEL_PORT 映射（docker-compose.yml:24-27；Dockerfile:39-41）
- linux 宿主上 cloud 跑在宿主 localhost 时，向导内填 `http://host.docker.internal:8787`，由 extra_hosts host-gateway 打通（docker-compose.yml:39-42）
- 健康检查用 alpine 自带 wget 探无鉴权首页（Dockerfile:56-58）

## 备注

- 违反本约束的故障特征：sing-box 容器 Up 但卷内无数据/无 TLS 文件——排查时先比对 `SINGCHORUS_HOME` 与宿主实际目录。
- 该约束同时约束 core/ctl（共享 ~/.singchorus 数据目录）；若未来引入命名卷或远端 docker host，本 ADR 与 ADR-005 需一并重审。
