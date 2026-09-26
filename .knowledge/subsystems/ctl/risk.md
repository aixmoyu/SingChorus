---
project: SingChorus
type: risk
description: ctl 模块（packages/ctl/）范围内的架构风险：CLI 命令零测试覆盖、--json 契约无机器校验、process.exit 散布、部署后同步漂移窗口、check-tag 降级误判；跨模块风险仅记录与 ctl 边界相关的 core 强依赖与 panel 双进程共享。全局级风险见 architecture_views/risk.md
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
---

# 模块架构风险分析（ctl）

> 故障域限定于 `packages/ctl/` code_mapping；跨模块仅记录边界相关依赖（见 `boundaries.md`）。
> 全局条目 RISK-STAB-001（部署锁）与全局技术债「ctl 测试近空」登记于 `architecture_views/risk.md:16,85`，本文件不重复，仅在边界处引用。

## 模块内稳定性与并发风险

|风险 ID|场景|触发条件|影响范围（本模块内）|概率|严重度|优先级|当前缓解|建议缓解|状态|
|-|-|-|-|-|-|-|-|-|-|
|RISK-CTL-001|CLI 命令层零测试导致回归静默|任何重构 commands/*.ts 或 index.ts 装配|8 命令组 + 内联 health 全部行为无回归保护；仅 utils.spec.ts 覆盖 parseParams/confirm/json 开关（`packages/ctl/tests/utils.spec.ts:1-47`）|高|中|P1|`vitest run --passWithNoTests` 兜底不失败（`packages/ctl/package.json:27`）|补命令级契约测试：mock ChorusCore 断言 JSON 输出形态与退出码|开放|
|RISK-CTL-002|process.exit 散布使错误路径难以测试与组合|fail() 及 check-tag/check-port/cloud status 等直接 exit(1)（`packages/ctl/src/utils.ts:23`、`packages/ctl/src/commands/config.ts:211,244`、`packages/ctl/src/commands/cloud.ts:19,39,81,123`）|测试须 spy process.exit（如 utils.spec.ts:15-17 的 workaround）；库化复用受阻|中|低|P3|测试中 mock exit|收敛为抛错 + 顶层统一 exit|开放|
|RISK-CTL-003|--json 契约靠注释维系，无机器校验|开发者改动 print*/fail 输出结构|脚本消费方静默破裂；契约仅为 description 文案（`packages/ctl/src/index.ts:19`）与注释（`packages/ctl/src/utils.ts:12-15`）|中|中|P2|R-CTL-D4 文案声明|契约快照测试（对 40 子命令 --json 输出做 schema 断言）|开放|

## 跨模块依赖风险

|风险 ID|依赖方向|依赖对象|失效/漂移场景|影响|当前保障|改进方案|
|-|-|-|-|-|-|-|
|RISK-CTL-D01|本模块→下游|@chorus/core（强，workspace:*）|ctl 消费 core **dist 产物**，改 core 后忘 build 则 CLI 跑旧逻辑|命令行为与 core 源码不一致，难排查|CI 显式先 build core（`docs/knowledge/architecture_views/guidelines/principles_009_monorepo_build_discipline.md:15`）|维持 CI 步骤；本地 dev 提示|
|RISK-CTL-D02|本模块→下游（共享目录）|panel 双进程共享 ~/.singchorus/data|两进程并发写数据目录|数据目录互斥由 core 文件锁保障（`packages/core/src/services/store.ts:17,177-183`）；ctl 自身无锁代码，锁失效风险归 core（全局 RISK-STAB-001）|core 锁原语 + 全局 principles_005|跟随全局 RISK-STAB-001 整改|
|RISK-CTL-D03|本模块→下游（弱）|@chorus/panel + 宿主 node/pnpm|panel start 时已装包缺 dist-server 或 monorepo 依赖缺失|启动失败|入口解析降级链 + pnpm/node 预检查并给出恢复命令（`packages/ctl/src/commands/panel.ts:39-92`，R-CTL-D2/D3）|已充分缓解|关闭候选|

## 模块内性能瓶颈风险

不适用：CLI 短生命周期进程，单命令单次调用；唯一重复成本是每命令 `new ChorusCore()` 构造（`packages/ctl/src/commands/config.ts:9-11`），实测开销可忽略 [待确认: 未测量构造耗时]。

## 模块内数据一致性风险

|风险 ID|场景|一致性级别|当前保障|潜在问题|概率|影响|改进方案|
|-|-|-|-|-|-|-|-|
|RISK-CTL-C01|deploy/stop 后本地与云端 deployed 集合漂移|最终一致|变更后尽力同步一次，失败仅警告并提示定时同步重试（`packages/ctl/src/commands/deploy.ts:14-22`）|漂移窗口内订阅端看到过期集合；JSON 模式 warning 混在 stdout|中|低|脚本侧解析 warning 字段；窗口依赖 core 定时同步闭合|
|RISK-CTL-C02|check-tag 云端不可达降级误判|尽力而为|降级为仅本地检查并显式输出 `source:'local_only'`（`packages/ctl/src/commands/config.ts:220-225`）|脚本若只读 `available:true` 忽略 source，会漏判云端占用|中|低|消费方契约化检查 source 字段；或降级时改用非 0 退出码 [待确认: 退出码语义是否允许变更]|

**失败场景分析模板**

```
正常路径：deploy up → 本地容器更新 → syncAllToCloud 推送 → 云端 deployed 集合更新
异常路径：云端不可达 → 同步失败 → 仅 warning（退出码 0）→ 漂移持续至下一次定时同步
```

## 模块可用性风险

不适用：CLI 按需短生命周期进程，无常驻服务可用性概念；`health` 命令本身是可用性探针（`packages/ctl/src/index.ts:36-65`）。SPOF：否。

## 模块内技术债务

|区域（本模块）|债务类型|原因|严重度|偿还建议|
|-|-|-|-|-|
|tests/ 仅 utils.spec.ts|测试债|8 命令组依赖 core 全链路，未做 mock 隔离|中等|命令级契约测试（JSON 形态 + 退出码），与 RISK-CTL-001 合并偿还（`docs/knowledge/architecture_views/risk.md:85`）|
|commands/*.ts 内联 JSON/人读分流|代码债|双模式输出逻辑分散在每个 action，print* 家族 9 个函数近似重复|轻微|维持 print* 收敛即可，暂不抽象|
|帮助文本即文档|文档债|契约细节（退出码/source 字段语义）散在注释与 --help|轻微|随契约测试补充 README 契约表|
