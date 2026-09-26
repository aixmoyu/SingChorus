---
project: SingChorus
type: development-principle
id: principle-core-008
description: 同步语义以内容哈希为唯一裁决：键序无关的递归稳定序列化生成 content_hash；真变更才失效 synced/deployed，杜绝键序噪音重传与订阅闪断。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 内容指纹同步语义

## 原则详细描述

`content_hash = sha256(stable(server)|stable(client)|stable(params))`，stableStringify 递归排序键（hash.ts:12-26）。update 时重算 hash：**与原值一致则不翻转 synced/deployed**（键序不同内容相同的写入不触发冗余重传与订阅下线，config-manager.ts:99-106 注释）；推送条件 = `!synced || computeSyncStatus !== 'synced'`，启用切换只翻 enabled 不改 hash，靠 synced 标志触发（core.ts:220-222）。`markSynced` 上传成功后重算 hash（config-manager.ts:201-207）。同步判定三要素：hash + enabled + deployed 与云端全一致才 synced（config-manager.ts:209-221）。

## 为什么要这样

hash.ts:7-11 注释记录的反例：若用 `JSON.stringify(obj, Object.keys(obj).sort())` 实现，replacer 数组是「递归白名单」，会过滤深层字段（users 里的 password、tls、params 深层参数），嵌套变更不改变 hash → 同步误报 synced → 订阅漂移。enabled/deployed 漂移各自独立观测（computeSyncStatus），防「内容没变但状态变了」被漏判。

## 适用范围

- config-manager 的 add/upsert/update/restore/markSynced；core 同步推送条件；云端上传体携带 content_hash（cloud-client.ts:419,431）。

## 规则

- 任何参与同步判定的字段变更必须反映进 hash 或三要素之一。
- 序列化必须递归键序无关；禁止 replacer 白名单式实现。
- 「真变更」才失效 synced/deployed；纯 touched（updated_at 变化）不触发重传。

## 反模式 / 禁止项

- 以 updated_at/文件 mtime 作为变更依据。
- 序列化丢深层字段。
- 上传成功前置 synced=true（必须成功后 markSynced）。

## 修改检查清单

- [ ] hash 覆盖全部同步语义字段
- [ ] update 路径保留「hash 相同不失效」短路
- [ ] computeSyncStatus 三要素与云端上传体字段一一对应
