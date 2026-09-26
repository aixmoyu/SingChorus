---
project: SingChorus
type: development-principle
id: principle-core-002
description: 一切持久化写入走同目录 temp+rename 原子写；损坏文件按「历史快照优先恢复、无快照改名隔离」自愈，绝不静默丢弃。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 原子写与损坏自愈

## 原则详细描述

写路径三件套：1) `atomicWrite` = 同目录 `.<uuid>.tmp` 写入 + 单次 rename（store.ts:40-45；docker-manager.ts:57-66，且说明 temp 不落 os.tmpdir 防 EXDEV）；2) 状态迁移用单次 rename 覆盖（saveConfig 先把对侧 enabled/disabled 旧文件 rename 到目标再写内容，杜绝双份并存，store.ts:189-197）；3) 自愈 = 历史快照原子写回（RPO≤20 次变更），无快照则 `.corrupt-<时间戳>` 改名隔离保留现场（store.ts:118-152,216-224,238-241；顶层无历史文件走 loadJsonQuarantine，store.ts:74-85）。

## 为什么要这样

进程随时可能被杀（停电/崩溃/部署中断）。原子写保证磁盘上只有完整旧文件或完整新文件；单次 rename 迁移使 core-C1 历史遗留的「双份并存」不再产生；隔离而非删除，让损坏现场可人工排查（core-A1 注释，store.ts:70-73）。

## 适用范围

- store.ts 全部写操作；docker-manager.ts 部署制品（compose/entry.sh/config.json/deploy-meta.json）。

## 规则

- 禁止对最终文件直接 `writeFileSync`。
- temp 文件必须与目标同目录；rename 失败要清理 temp 再抛（docker-manager.ts:62-65）。
- 配置写同时落 `.history` 快照并裁剪至 MAX_HISTORY=20（store.ts:198-207）。
- 部署元信息只在健康检查通过后落盘，回滚路径不留「看似成功」记录（docker-manager.ts:287-292）。

## 反模式 / 禁止项

- 跨目录/跨设备 rename。
- 读到损坏 JSON 时静默 return null 且不隔离（顶层文件场景也必须隔离，store.ts:78-83）。
- 用复制实现状态迁移（会产生双份）。

## 修改检查清单

- [ ] 新写路径使用 atomicWrite 且 temp 同目录
- [ ] 状态类文件迁移是 rename 而非 copy+delete
- [ ] 损坏路径有恢复与隔离两级处理并有日志
