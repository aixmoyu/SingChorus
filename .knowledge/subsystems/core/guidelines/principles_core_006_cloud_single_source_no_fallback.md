---
project: SingChorus
type: development-principle
id: principle-core-006
description: 部署与协议渲染的事实源在云端；渲染失败必须响亮失败，禁止本地旧配置静默顶上。merger 仅作为显式回退 API 保留，不进部署链路。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 云端单一事实源，无本地回退

## 原则详细描述

deploy 的三件制品（合并 server 配置、compose yaml、entry.sh）全部来自 `POST /api/render/deploy`，与订阅同一渲染源；core 侧 DockerManager 「只落盘并驱动 docker compose，无本地模板」（docker-manager.ts:68-72 注释）。core.deploy 明确注释「No local fallback: if the cloud can't render, deploy fails loudly instead of silently serving a stale local config」（core.ts:421-427）；云端缺端点时报 `CLOUD_ENDPOINT_MISSING` 而非降级（cloud-client.ts:372-375）。`merger.ts` 的本地装配仅作为显式回退 API（generateServerConfig/generateSubscription，core.ts:405-415）存在。

## 为什么要这样

静默回退本地旧配置会让节点以过期/漂移的配置对外服务而无人知晓（全局 ADR-003）；订阅与部署同源保证「用户订阅到的」与「节点运行的」一致。响亮失败把不可用变成可感知、可行动的运维信号。

## 适用范围

- 部署链路（core.deploy → renderDeploy → deployRendered）；协议渲染（generateConfig）；模板与版本目录获取。

## 规则

- 渲染失败/端点缺失向上抛结构化错误，不得捕获后走本地装配。
- DockerManager 不内置任何模板字符串；制品为空即抛（`Cloud returned an empty compose yaml`，docker-manager.ts:255-256）。
- sing-box 版本 pin 由 core 从 AppConfig 注入渲染请求，不进宿主请求体（core.ts:427,434-445）。

## 反模式 / 禁止项

- 「云端失败就本地拼一份」的自动降级。
- 在 core 内嵌协议/overall 模板副本。
- 部署失败后保留旧容器带旧配置继续服务而不告警（健康超时必须 compose down + 回滚 + 抛错，docker-manager.ts:277-285）。

## 修改检查清单

- [ ] 新渲染能力走 cloud 端点并处理 404/非 200
- [ ] 未新增本地模板或自动回退分支
- [ ] 失败路径保留响亮错误与回滚顺序（先备份后写、健康过才写 meta）
