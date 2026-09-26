---
project: "SingChorus"
type: development-principle
id: principle-global-010
principle_scope: 项目级
description: "子进程与容器驱动收敛最小暴露面：一律 execFile 参数数组不经 shell；panel 容器仅装 docker CLI 并挂载宿主 docker.sock（DooD），非 privileged、不装守护进程。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 安全-最小暴露面
---

# 子进程与容器驱动最小暴露面

## 原则详细描述

- core 调用 docker/sing-box 校验一律 `execFile` + 参数数组，不经 shell 拼接，收敛注入面（`packages/core/src/services/validator.ts:80-82`；`docker-manager.ts:78-79`），并带 60s 超时；成功/失败均留痕日志供 VPS 排障（`validator.ts:152-158`；`packages/panel/server/routes/core/deploy.ts:33-36`）。
- panel 容器化选择 DooD：容器内只装 docker CLI，挂载宿主 `/var/run/docker.sock`，非 privileged（`packages/panel/Dockerfile:6-9`；`packages/panel/docker-compose.yml:13-16,36-38`），决策记录见 ADR-005。sock 挂载固有权限风险登记于 [../risk.md](../risk.md) RISK-SEC-002。

## 为什么要这样

- shell 拼接是把模板变量（节点名、tag 等）变成命令注入的直接通道；参数数组从机制上消除该类别。
- DooD 相比 DinD 不在容器内跑特权守护进程、不存双层存储，权限面与运维复杂度都更小。
- 排障留痕让「部署失败」在无头 VPS 上可事后追查。

## 适用范围

- 项目级：一切子进程调用（core 校验/部署、脚本）；容器化方案（panel）。

## 规则

- 子进程调用必须 execFile/spawn 数组形式，禁止 `exec`/shell 字符串拼接；外部输入进入参数前需校验（如 tag 白名单）。
- 容器方案优先最小权限形态；引入新挂载（sock、设备）必须登记风险。
- 子进程必须有超时，输出必须留痕。

## 反模式 / 禁止项

- 用 shell true 语法拼接 docker 命令。
- 容器内安装完整 docker daemon（DinD）或使用 privileged。
- 无超时的子进程调用。

## 修改检查清单

- [ ] 新子进程调用是否数组传参？参数是否含未校验外部输入？
- [ ] 是否设置超时与日志留痕？
- [ ] 容器权限面是否扩大？扩大是否登记 risk？
