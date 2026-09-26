---
project: SingChorus
type: adr
id: ADR-cloud-008
description: 订阅双交付型——subscriptions 增加 type 列（singbox|url），url 型把已启用实例的 clientConfig 转成 vless/hysteria2/trojan/ss/vmess 分享链接按行交付（text/plain），不绑 sing-box 版本与 overall 模板，type 创建后不可变。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-cloud-008: 订阅分享链接（url）交付型"
date: 2026-09-26
code_refs:
  - packages/cloud/src/engine/share-urls.ts
  - packages/cloud/src/engine/types.ts
  - packages/cloud/src/routes/subscriptions.ts
  - packages/cloud/src/db/schema.ts
  - packages/panel/src/views/SubscriptionCreate.vue
  - packages/ctl/src/commands/subscription.ts
---

# ADR-cloud-008: 订阅分享链接（url）交付型

## 状态

accepted（相关提交：本次订阅双型改造）

## 1. 背景

**业务背景**：订阅消费端不只有 sing-box。V2rayN/NekoBox 等客户端通用导入格式是 URI 分享链接列表（`vless://…\nhysteria2://…`），现有订阅只交付 sing-box JSON，无法服务这类客户端。
**技术背景**：URI 各协议格式有社区规范——vless 遵循 Xray-core discussion 716，hysteria2 遵循官方 URI-Scheme，ss 为 SIP002，vmess 为 v2rayN base64 JSON；这些格式与 sing-box outbound 结构一一对应但字段命名不同。
**核心问题**：分享链接能力应以何种形态挂进现有订阅体系——独立端点、独立表，还是复用订阅模型加类型维度？

**约束条件**：

- 现有 singbox 型订阅及其版本绑定闭环（ADR-cloud-003）不得受影响
- D1 存量库升级只能走 ALTER_TABLES 幂等补列（不重部署数据）
- URI 转换失败的单个实例不能挂掉整个交付
- 无迁移场景：不写任何 legacy/兼容代码

## 2. 决策驱动因素

1. **单一订阅模型**（高）：path/token/active/限流/stale 降级等机制全部复用，不重复造一套链接订阅。
2. **语义清晰**（中）：url 型没有 sing-box 版本概念，绑版本反而是错误模型——消费端不是 sing-box。
3. **可演进**（中）：后续新增协议（tuic 等）只改 share-urls.ts 纯函数，不动路由与表结构。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|独立分享链接端点+独立表|互不干扰|token/path/限流/缓存/降级全重复实现|两套订阅语义漂移|
|Option B|subscriptions 加 type 列，url 型复用全交付链路|机制全复用；一张表一个语义|需处理「url 型无版本/模板」的字段空值语义|校验分支漏判|
|Option C|渲染时同时产出 JSON 与链接（无类型）|零表改动|消费端格式由客户端猜；缓存/Content-Type 混乱|隐式行为不可解释|

### Option B：订阅双交付型（已实施）

- 数据层：`subscriptions.type TEXT NOT NULL DEFAULT 'singbox'`（schema.ts CREATE + ALTER_TABLES + 0001_init.sql 三处同步，钉 schema-fingerprint/schema-upgrade）。
- 类型层：engine/types.ts `SUBSCRIPTION_TYPES = ['singbox','url']`；url 型落库 `singbox_version=''`、`overall_template_id=NULL`。
- 转换层：engine/share-urls.ts 纯函数 `outboundToShareUrl`（零 IO，钉双规范：vless=Xray-core#716、hysteria2=官方 URI-Scheme；ss=SIP002 base64url userinfo；vmess=v2rayN base64 JSON）；缺 server/port 或协议不支持返回 null，单实例失败不阻断交付，全部失败才 500 SHARE_URL_NONE。
- 交付层：url 型分支跳过 compat 过滤与 overall 渲染，逐实例转 URI 以 `\n` 连接，`text/plain; charset=utf-8` 交付；sub_delivery_cache 复用单表，text 格式带 `{__format:'share-urls'}` 标记，stale 回放按标记还原 Content-Type。
- 校验层：createSubSchema superRefine（singbox 型必填 singboxVersion；url 型禁传版本/模板）；PUT 改 type → 400 SUB_TYPE_IMMUTABLE；url 型更新传版本/模板 → 400 SUB_FIELD_NOT_APPLICABLE。
- 消费端：panel 创建页类型单选（url 型隐藏版本/模板选择器）、详情/列表类型标签；ctl create `-t/--type`（singbox 型手动校验必填版本）。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：交付机制（token/active/限流/缓存/三级降级）天然与格式正交，type 是数据属性而非独立能力；独立端点必然复制整套安全与缓存逻辑。url 型不做 compat 过滤是显式决策——URI 的消费方是 V2rayN 类客户端而非 sing-box，版本绑定模型不适用。

### 4.1 实施要点

- **type 不可变**：与协议 tag 不可变同理由——type 决定字段语义（版本/模板是否适用），中途变更等于换一种资源。
- **缓存格式标记**：`{__format:'share-urls'}` 只加在 text 格式，json 格式保持裸对象——避免对存量缓存行做迁移。
- **zValidator 剥离陷阱**：updateSubSchema 必须显式声明 `type: z.string().optional()` 才能在 handler 里收到并拒绝（未声明字段被静默剥离，测试曾因此拿到 200 而非 400）。
- **测试钉机制不钉数据**：share-urls.spec 集成用例复用 tests/seed-baseline 推导值；断言用 startsWith/endsWith 辅助函数（vitest-pool-workers 无 toStartWith）。
- 已知边界：url 型交付同样受 client_configs 300s isolate 缓存节奏影响（与 singbox 型一致）。

## 备注

- 相关原则：principles_cloud（机制与格式正交、纯函数引擎）。
- 关联：ADR-cloud-002（三级降级——url 型共用同一降级链）、ADR-cloud-003（版本绑定闭环——仅 singbox 型适用）。
