---
project: "SingChorus"
type: adr
id: ADR-global-005
description: "panel 容器化采用 DooD（仅装 docker CLI + 挂载宿主 docker.sock，非 privileged）驱动 sing-box 容器，而非 DinD 或宿主直装。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "panel 容器以 DooD 驱动 sing-box"
date: 2026-09-17
code_refs:
  - packages/panel/Dockerfile:6-9
  - packages/panel/docker-compose.yml:13-16
  - packages/panel/docker-compose.yml:36-38
---

# ADR-005: panel 容器以 DooD 驱动 sing-box

## 状态

accepted

## 1. 背景

**业务背景**：panel 需要在用户 VPS 上创建/管理 sing-box 容器（部署、健康检查、日志），panel 自身以 Docker 镜像分发。
**技术背景**：容器内管理其他容器有三种成熟路径：DinD、DooD、绕过容器直装宿主。
**核心问题**：panel 容器如何获得管理 sing-box 容器的能力，同时把权限面与运维复杂度控制在可接受范围？

**约束条件**：

- 面向自托管用户，不能要求复杂的主机侧预配置
- 镜像需支持 amd64+arm64（GHCR 双架构）
- 容器内 `$HOME/.singchorus` 路径必须与宿主一致（compose 注释明示，`docker-compose.yml:8-11`）

## 2. 决策驱动因素

1. **权限面最小化**（高）：DinD 需要 privileged，等于宿主 root。
2. **存储一致性**（高）：DooD 下 sing-box 容器与宿主共享 Docker 存储，无双层卷。
3. **运维复杂度**（中）：不在容器内跑第二个 Docker 守护进程。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|DinD（privileged 内嵌守护进程）|完全隔离|privileged≈root；双守护进程、双存储层|逃逸=宿主沦陷|
|Option B|DooD：挂宿主 docker.sock（采纳）|无 privileged；单守护进程|sock≈宿主 root；路径约束|sock 泄露=宿主沦陷|
|Option C|panel 直装宿主（放弃容器化）|无 sock 问题|失去镜像分发便利|用户装机成本高|

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：驱动因素 1 否决 DinD；镜像分发是主要交付通道否决 C。sock 风险显式接受并登记（`Dockerfile:6-9`；[../risk.md](../risk.md) RISK-SEC-002：建议 TLS 反代/网络分段/sock 代理缓解）。

### 4.1 实施要点

- 镜像仅含 docker CLI（`Dockerfile:6-9`）
- compose 挂载 `/var/run/docker.sock`，`SINGCHORUS_HOME` 同控容器与宿主两侧保证路径一致（`docker-compose.yml:13-16,36-38`）

## 备注

- sock 权限为行业共性取舍；缓解方案与残余风险见 [../risk.md](../risk.md) RISK-SEC-002。
