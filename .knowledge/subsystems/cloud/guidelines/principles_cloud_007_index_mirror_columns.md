---
project: SingChorus
type: development-principle
id: principle-cloud-007
description: 跨节点合并配置要求 tag 全局唯一——用「镜像列 + 索引（含 partial unique）」把唯一性校验从全表扫描降为索引查询，并把约束下沉到数据库层背书。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 索引镜像列换查询性能

## 原则详细描述

tag（sing-box inbound/outbound 标识）存储在 JSON 大字段（params.tag / config.tag）内，但唯一性检查是高频操作。对策是写入时把 tag 提取进独立列并建索引：

- `protocol_instances.tag` 镜像 params.tag（protocol-instances.ts:14-19 extractTag；写入点 :71-81,111-119；索引 schema.ts:194）。
- `client_configs.tag` 镜像 config.tag（clients.ts:52-55 extractTag；写入点 :164,224,236；partial unique index `WHERE tag != ''`，schema.ts:208）。
- 同理 `client_configs.port` 镜像 server_port/listen_port（clients.ts:45-49），支撑同节点端口冲突检查（clients.ts:167-182）。

## 为什么要这样

- tags/check 是同步链路上的热端点（core 以 noRetry 调用，cloud-client.ts:512-522）；历史上 `params LIKE` 全表扫描会随数据量劣化并挤占 subrequest 预算（protocol-instances.ts:14-15 注释 CLOUD-P2）。
- partial unique 索引让「空 tag 不参与唯一约束、非空 tag 全局唯一」这条业务规则由数据库权威背书：应用层预检查给出精确 409（clients.ts:184-198），并发写入的竞态由索引兜底（clients.ts:239-248 注释）。
- 指纹同理：节点身份 = fingerprint，partial unique（允许 NULL 指纹行）支撑 register 的幂等 upsert（schema.ts:204-206、nodes.ts:54-59）。

## 适用范围

- 任何「JSON 字段成为高频查询/唯一性条件」的场景。

## 规则

- 镜像列在**每次写入**路径同步维护（含 update 重新提取）。
- 唯一性 = 应用层预检查（友好错误）+ 数据库索引（并发兜底）双层实现。
- 镜像提取函数单一实现（extractTag/extractPort），多处调用不复制。

## 反模式 / 禁止项

- 用 `JSON 字段 LIKE` 做唯一性/过滤查询。
- 只依赖应用层预检查（TOCTOU 竞态）或只依赖索引（错误信息不友好）。
- 镜像列与 JSON 源字段更新不同步。

## 修改检查清单

- [ ] 写路径（含 update）都维护镜像列了吗？
- [ ] 索引与 partial 条件与业务规则一致吗？
- [ ] 冲突错误码（TAG_CONFLICT/PORT_CONFLICT）语义是否保留？
