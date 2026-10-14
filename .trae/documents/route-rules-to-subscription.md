# route_rules 从配置级迁移到订阅级（删除原 client_configs 实现）

## Context

`{{ route_rules }}` 拼接点只在订阅交付渲染（`renderClientOverall`）时消费，但规则数据却存在 `client_configs` 表（配置创建/详情页填写）。交付优先走 `protocol_instances` 路径（无规则列，静默跳过并打 warn），只有无实例时回退 `client_configs` 才拼接——数据源与消费点错位，规则不可靠。

本次重构：规则迁移到 `subscriptions.route_rules`（panel 新建/编辑订阅表单填写），交付时**无论哪条路径**统一拼接；同时删除配置级 route_rules 的全部实现（commit 830a58b 的配置侧部分）。

## 1. cloud

### schema（三处同步铁律：CREATE_TABLES + 0001_init.sql + ALTER_TABLES + 两个 schema 测试）
- [schema.ts](file:///Users/li/Projects/SingChorus/packages/cloud/src/db/schema.ts)：subscriptions CREATE 加 `route_rules TEXT NOT NULL DEFAULT '[]'`；ALTER_TABLES 加对应 ADD COLUMN（fresh 库重复执行被已有 catch 吞掉）；client_configs 删除 route_rules 列（CREATE + ALTER 均删，项目未上线无迁移场景，远端残留死列无害不写 DROP）
- [0001_init.sql](file:///Users/li/Projects/SingChorus/packages/cloud/migrations/0001_init.sql)：同步加/删列

### engine
- [types.ts](file:///Users/li/Projects/SingChorus/packages/cloud/src/engine/types.ts)：`SubscriptionRow` 加 `route_rules: string`；`Subscription` 加 `routeRules: unknown[]`；`parseSubscriptionRow` 用 `safeParseArray` 解析
- [registry.ts](file:///Users/li/Projects/SingChorus/packages/cloud/src/engine/registry.ts)：
  - 删 `ProtocolInstanceConfig.routeRules`
  - `renderOverall`/`renderClientOverall` 加第 4 参 `routeRules?: unknown[]`：`replacements[ROUTE_RULES_TOKEN] = routeRules ?? []`（保持「始终注册，空则占位元素整体消失」语义）；B3 warn（模板无拼接点）改用第 4 参计数
  - 新增 outbound 白名单告警：known = `{'direct','proxy','auto'} ∪ instances[].clientConfig.tag`（string）；规则引用未知 outbound → 一次 `logger.warn`（含未知 tag、规则数、templateId），**不阻断渲染**（订阅级无法预知交付 outbound 集合，B3 风格）
- `SPLICE_KEYWORDS`（interpolator.ts）不动

### routes
- [subscriptions.ts](file:///Users/li/Projects/SingChorus/packages/cloud/src/routes/subscriptions.ts)：
  - 删 `loadConfigsFromD1` 读 route_rules、删 L233-246 实例路径 B2 warn 块
  - `createSubSchema`/`updateSubSchema` 加 `routeRules`（结构校验从 clients.ts 搬入：对象数组、每项 `outbound` 非空字符串、≤ `MAX_ROUTE_RULES = 100`，常量在此导出）
  - url 型：POST superRefine + PUT 明示 400（沿用 `SUB_FIELD_NOT_APPLICABLE` 模式）
  - INSERT / UPDATE 动态 SET 加列；**PUT 缓存失效条件加 `body.routeRules !== undefined`**
  - 交付：`renderClientOverall(compatible, sub.overallTemplateId, overallParams, sub.routeRules)`（两条路径统一）
  - 简单合并路径（无 overallTemplateId）且 `sub.routeRules.length > 0` → logger.warn（规则不生效提示）
- [clients.ts](file:///Users/li/Projects/SingChorus/packages/cloud/src/routes/clients.ts)：route_rules 相关全删（zod、SELECT、INSERT/UPDATE）
- [render.ts](file:///Users/li/Projects/SingChorus/packages/cloud/src/routes/render.ts)：`renderClientOverall` 调用点加第 4 参，body zod 加可选 `routeRules` 透传（预览规则拼接效果）

### cloud 测试
- schema-upgrade.spec：client_configs route_rules 断言改为 subscriptions.route_rules ALTER 回归
- template-port.spec：L151/L188 改第 4 参传规则；新增白名单 warn 用例
- subscriptions.spec：CRUD routeRules 回显、url 型 400、PUT 后 sub_delivery_cache 失效、实例路径与 client_configs 路径均拼接、简单合并 warn
- clients.spec：fixture 删字段；schema-fingerprint.spec 若基线指纹需更新则按其机制重新生成

## 2. core（全删配置级实现）

- [config-manager.ts](file:///Users/li/Projects/SingChorus/packages/core/src/services/config-manager.ts)：删 `validateRouteRules`、makeEntry 的 rules 参数、add/upsert/update/markSynced 接线
- [hash.ts](file:///Users/li/Projects/SingChorus/packages/core/src/services/hash.ts)：删 computeContentHash 第 4 段
- errors.ts：删 `CFG_ROUTE_RULES_INVALID`
- core.ts：删 L163/L241/L337/L367 透传；schemas/config.ts：删 `ConfigEntry.route_rules`，`Subscription` 接口加 `routeRules: unknown[]`
- 测试：config-manager.spec 删 hash 第 4 段（B1 回归）与 validateRouteRules 相关 describe；core.spec L248「route_rules 变更重上传」删

## 3. panel

- server/routes/core/cloud.ts：`createSubscriptionSchema`/`updateSubscriptionSchema` 加 `routeRules: z.array(recordSchema).max(100).optional()`（代理层只挡形状，语义校验在云端）
- server/routes/core/configs.ts：删 routeRulesSchema 及透传
- [SubscriptionCreate.vue](file:///Users/li/Projects/SingChorus/packages/panel/src/views/SubscriptionCreate.vue)：加 Route Rules textarea（JSON parse 校验 + 提示文案，实现搬自原 ConfigCreate L74-90），仅 singbox 型显示
- [SubscriptionDetail.vue](file:///Users/li/Projects/SingChorus/packages/panel/src/views/SubscriptionDetail.vue)：回显 `subscription.routeRules`（容错 null/undefined → '[]'）+ 提交
- ConfigCreate.vue / ConfigDetail.vue：route rules 字段与逻辑全删
- tests/cloud-routes.test.ts：补订阅 routeRules 透传用例

## 实施顺序与验证

1. cloud engine（registry/types）+ render + template-port.spec → `pnpm -C packages/cloud test tests/plugins tests/render.spec.ts`
2. cloud subscriptions.ts + subscriptions.spec → `pnpm -C packages/cloud test tests/subscriptions.spec.ts`
3. cloud schema/0001/clients.ts + schema 测试 → `pnpm -C packages/cloud test`
4. core 删减 + 测试 → `pnpm -C packages/core test && pnpm -C packages/core build`
5. panel server + 前端 → `pnpm -C packages/panel test && pnpm -C packages/panel build`（server 测试遵守 makeTempHome 后动态 import 铁律）
6. 全量 `pnpm -r build && pnpm -r test`；更新项目记忆（B1-B5 加固条目按新设计改写）

## 风险与边界

- content_hash 因删第 4 段而变化 → core 全量重传一次，未上线无兼容问题
- url 型订阅 routeRules 默认 `[]`，panel 回显需容错
- 白名单告警为 best-effort（引用 overall 模板专属 selector 分组的规则会 warn，不阻断——与原配置级「拒绝引用模板 selector」的已知取舍一致，从硬拒绝降级为告警）

## 修复记录（code review 后续）

1. **routeRulesSchema 放宽 outbound 为可选**（subscriptions.ts）：`z.string().min(1).optional()`——sing-box 1.11+ 的 action 型规则（reject / hijack-dns / sniff 等）不带 outbound，原实现（配置级）显式支持；存在时仍要求非空字符串。出站语义继续由渲染时白名单告警承担。
2. **补测试**：subscriptions.spec 增「action 型规则合法可存」「outbound 空串 → 400」「PUT routeRules 后 sub_delivery_cache 失效」；render.spec 增「/api/render/overall 透传 routeRules 拼接预览」「非数组 routeRules → 400 INVALID_ROUTE_RULES」。
3. **render.ts 预览端点**：routeRules 非数组 → 400 `INVALID_ROUTE_RULES`（此前非数组会被 splice 当作单元素整体拼入，产出畸形预览）。
4. **SubscriptionDetail.vue**：仅当规则语义变化（解析成数组后比较，格式化差异不算）才携带 `routeRules` 提交——避免改名等无关编辑触发云端交付缓存失效；离开页脏检查同语义；修正 `dialog.warning` 闭合括号缩进。
