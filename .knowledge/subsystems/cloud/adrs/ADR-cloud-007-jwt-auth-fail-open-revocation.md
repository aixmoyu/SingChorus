---
project: SingChorus
type: adr
id: ADR-cloud-007
description: 管理面认证从长期静态 token 升级为「静态 token 换发 24h HS256 JWT + D1 吊销表」，吊销检查在 D1 宕机时显式 fail-open——用有界的风险窗口换取管理面不因吊销查询而瘫痪。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-cloud-007: JWT 化管理认证与 fail-open 吊销"
date: 2026-09-20
code_refs:
  - packages/cloud/src/auth/jwt.ts
  - packages/cloud/src/auth/middleware.ts
  - packages/cloud/src/routes/auth.ts
  - packages/cloud/src/routes/users.ts
---

# ADR-cloud-007: JWT 化管理认证与 fail-open 吊销

## 状态

accepted（P1 迭代；订阅交付 token 仍为静态 query token，不属本 ADR 范围）

## 1. 背景

**业务背景**：panel 与 ctl 以共享 AUTH_TOKEN 调用 cloud 管理面；令牌一旦泄露无法止损，且无法区分操作者。
**技术背景**：Workers 无会话存储；吊销状态需持久化 → D1 tokens 表（token_hash 唯一、revoked 位）；D1 与管理面同生共死。
**核心问题**：如何在无状态运行时实现可吊销的认证，且吊销查询不成为 D1 故障时的全站阻断点？

**约束条件**：

- WebCrypto HS256（双运行时可用，jwt.ts:1-4）
- 吊销记录必须哈希存储（tokens.token_hash，schema.ts:163-171）
- 用户体验：24h 内不应频繁重新登录

## 2. 决策驱动因素

1. **可吊销**（高）：logout/refresh/删用户必须即时止损。
2. **可用性**（高）：吊销查询不能把 D1 故障放大为认证全灭。
3. **可审计**（中）：登录/登出/签发留痕（audit_logs + stdout）。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|维持长期静态 Bearer token|实现最简|不可吊销、不可审计、泄露即永久|凭据泄露无止损|
|Option B|JWT + 吊销表 fail-closed|吊销严格|D1 宕机=全管理面 401（与 CLOUD-A2「管理面显式降级」哲学冲突）|可用性反噬|
|Option C|JWT(24h/30d) + 吊销表 fail-open（仅 revoked=1 拒绝）|可吊销 + D1 故障可用性保持|宕机窗口内新吊销不生效（签名仍验）|有界安全窗口|

### Option C：JWT + fail-open 吊销（已实施）

- login：AUTH_TOKEN 换 JWT（sub/type/iat/exp/jti），登记 tokens 表 best-effort（auth.ts:25-39）；失败登录留审计日志（auth.ts:20-22）。
- refresh：吊销旧 jti + 签发新 token（auth.ts:52-71）；logout 吊销当前（:77-85）；删用户联动吊销其全部 user 型 token（users.ts:117）。
- 中间件：验签+过期 → 哈希查 tokens 表 → **仅 revoked=1 拒绝；查不到/查询失败放行**（middleware.ts:41-55，注释「D1 outage — fail open ... signature is already valid」）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：吊销能力达成（驱动 1）；fail-open 的风险窗口由「签名已验 + 24h TTL + 需先持有合法 JWT」三重限定（驱动 2），与索引/限流/审计等既有 fail-open 点位哲学一致；审计留痕达成（驱动 3）。

### 4.1 实施要点

- token 哈希统一 `hashToken`（SHA-256+base64url，jwt.ts:91-95）；表内不落明文 JWT。
- TOKEN_TTL：ADMIN 24h / USER 30d（jwt.ts:97-100）。
- 登记失败不阻断签发（auth.ts:37-39）——该 token 仅失去吊销跟踪。

## 备注

- 残余风险：窗口语义、以及订阅 token 明文的对照差异，见 risk.md 技术债与 middleware.ts:25-27 注释。
- core 侧消费：401 → 清缓存换 token 重试一次（cloud-client.ts:183-204）。
