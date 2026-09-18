import { createMiddleware } from 'hono/factory';
import { verifyJWT, hashToken } from './jwt';

export interface AuthContext {
  actor: string;
  tokenType: 'admin' | 'user';
  jti: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * adminAuth 中间件 — 验证 JWT (HS256)
 * P1: Admin Token 改为 JWT (24h 过期)，支持吊销
 *
 * 验证流程：
 * 1. 提取 Bearer token
 * 2. 验证 JWT 签名 + 过期时间 (Web Crypto API)
 * 3. 查询 tokens 表确认未被吊销
 *
 * 吊销状态只存 D1（tokens.revoked）。D1 宕机期间对签名合法但查不到
 * 吊销记录的 token fail-open（JWT 签名已验证，风险窗口有限）。
 */
export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: { code: 'AUTH_MISSING_TOKEN', message: 'Authentication required' } }, 401);
  }
  const token = authHeader.slice(7);

  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: { code: 'AUTH_INVALID_TOKEN', message: 'Invalid or expired token' } }, 401);
  }

  // Check revocation in tokens table
  // Only reject if token is explicitly revoked (revoked=1).
  // If token is not found in DB (e.g., DB reset, cross-instance), accept it —
  // the JWT signature is already verified.
  const tokenHash = await hashToken(token);
  try {
    const tokenRow = await c.env.DB.prepare(
      'SELECT revoked FROM tokens WHERE token_hash = ?'
    ).bind(tokenHash).first<{ revoked: number }>();

    if (tokenRow && tokenRow.revoked === 1) {
      return c.json({ error: { code: 'AUTH_TOKEN_REVOKED', message: 'Token has been revoked' } }, 401);
    }
  } catch {
    // D1 outage — fail open for unknown tokens (signature is already valid).
  }

  c.set('auth', {
    actor: payload.sub,
    tokenType: payload.type,
    jti: payload.jti,
  });

  await next();
});
