import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import { loadConfig, updateConfig, runConfigExclusive, isFirstRun, type PanelConfig } from './config.js'
import { isProduction } from './env.js'
import { toErrorEnvelope } from './api-error.js'

const TOKEN_COOKIE = 'chorus_panel_token'
const TOKEN_TTL_SECONDS = 60 * 60 * 12 // 12 hours

/** Minimum password length — raised from the original 4-char floor. */
const PASSWORD_MIN_LENGTH = 8
/** Max bcrypt rounds — keeps verification under ~100ms on commodity hardware. */
const BCRYPT_ROUNDS = 10

export interface PasswordPolicyError {
  code: string
  message: string
}

export function getCookieName(): string {
  return TOKEN_COOKIE
}

export function getTokenTtl(): number {
  return TOKEN_TTL_SECONDS
}

/**
 * Validate password strength against the panel policy.
 * Returns `null` when the password is acceptable, otherwise an error descriptor.
 *
 * Policy:
 *  - at least 8 characters
 *  - must contain characters from at least 3 of the 4 classes:
 *    lowercase, uppercase, digit, symbol
 */
export function validatePasswordPolicy(password: string): PasswordPolicyError | null {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return {
      code: 'PASSWORD_TOO_SHORT',
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    }
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length
  if (classes < 3) {
    return {
      code: 'PASSWORD_TOO_WEAK',
      message: 'Password must contain at least 3 of: lowercase, uppercase, digit, symbol',
    }
  }
  return null
}

export async function setupAdminPassword(password: string): Promise<void> {
  const err = validatePasswordPolicy(password)
  if (err) throw new Error(err.message)
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  // Serialize the read-modify-write tail behind the bcrypt await (and
  // re-check first-run inside the lock) so two concurrent setup requests
  // can't interleave and overwrite each other's hash / token_version.
  await runConfigExclusive(() => {
    const cfg = loadConfig()
    if (cfg.admin_password_hash) throw new Error('Admin password already set')
    // Bump the token version so any token issued before this point is rejected.
    updateConfig({ admin_password_hash: hash, token_version: (cfg.token_version || 0) + 1 })
  })
}

export async function verifyPassword(password: string): Promise<boolean> {
  const cfg = loadConfig()
  if (!cfg.admin_password_hash) return false
  try {
    return await bcrypt.compare(password, cfg.admin_password_hash)
  } catch {
    return false
  }
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
  if (!(await verifyPassword(oldPassword))) return false
  if (validatePasswordPolicy(newPassword) !== null) return false
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  // Serialize the read-modify-write tail behind the bcrypt await so a
  // concurrent setup/change can't be overwritten by a stale snapshot.
  // Bump the token version so all previously-issued tokens (including the
  // caller's current session) are invalidated. The route re-issues a fresh
  // cookie after a successful change.
  await runConfigExclusive(() => {
    const cfg = loadConfig()
    updateConfig({ admin_password_hash: hash, token_version: (cfg.token_version || 0) + 1 })
  })
  return true
}

export function issueToken(res: Response): string {
  const cfg = loadConfig()
  const token = jwt.sign({ sub: 'admin', ts: Date.now(), ver: cfg.token_version || 0 }, cfg.jwt_secret, {
    expiresIn: TOKEN_TTL_SECONDS,
  })
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    // `strict` in production prevents the cookie from being sent on
    // cross-site navigations; `lax` in dev keeps OAuth-style redirects working.
    sameSite: isProduction ? 'strict' : 'lax',
    // Only transmit over HTTPS in production — localhost dev stays on HTTP.
    secure: isProduction,
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  })
  return token
}

export function clearToken(res: Response): void {
  // Mirror the cookie options used in `issueToken` so the browser reliably
  // matches the cookie to delete.
  res.clearCookie(TOKEN_COOKIE, {
    httpOnly: true,
    sameSite: isProduction ? 'strict' : 'lax',
    secure: isProduction,
    path: '/',
  })
}

export function checkAuthToken(token: string | undefined): boolean {
  if (!token) return false
  const cfg = loadConfig()
  try {
    const payload = jwt.verify(token, cfg.jwt_secret) as { ver?: number }
    // Tokens issued before a password change/setup carry an outdated version.
    if (payload.ver !== (cfg.token_version || 0)) return false
    return true
  } catch {
    return false
  }
}

export interface AuthedRequest extends Request {
  isAuthenticated?: boolean
}

export function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = (req.cookies && (req.cookies as Record<string, string>)[TOKEN_COOKIE]) || undefined
  req.isAuthenticated = checkAuthToken(token)
  next()
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated) {
    res.status(401).json(toErrorEnvelope('unauthorized', 'Authentication required'))
    return
  }
  next()
}
