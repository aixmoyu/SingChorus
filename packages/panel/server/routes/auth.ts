import { Router } from 'express'
import { isFirstRun, isInitialized } from '../config.js'
import { setupAdminPassword, verifyPassword, issueToken, clearToken, requireAuth, changePassword, validatePasswordPolicy, type AuthedRequest } from '../auth.js'
import { toErrorEnvelope } from '../api-error.js'

const router = Router()

/**
 * In-memory login rate limiting: after MAX_FAILURES consecutive failures the
 * source IP is locked out for LOCKOUT_MS. Entries reset on success and are
 * swept opportunistically. State is process-local — restarting the server
 * clears it, which is acceptable for a single-admin local panel.
 */
const MAX_FAILURES = 5
const LOCKOUT_MS = 15 * 60 * 1000
const failures = new Map<string, { count: number; lockedUntil: number }>()

function clientKey(req: AuthedRequest): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function isLockedOut(req: AuthedRequest): boolean {
  const entry = failures.get(clientKey(req))
  if (!entry) return false
  if (entry.lockedUntil > Date.now()) return true
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) failures.delete(clientKey(req))
  return false
}

function recordFailure(req: AuthedRequest): void {
  const key = clientKey(req)
  const entry = failures.get(key) || { count: 0, lockedUntil: 0 }
  entry.count += 1
  if (entry.count >= MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS
    entry.count = 0
    req.log.warn({ ip: key, lockoutMinutes: LOCKOUT_MS / 60_000 }, 'login locked out after repeated failures')
  }
  failures.set(key, entry)
}

function clearFailures(req: AuthedRequest): void {
  failures.delete(clientKey(req))
}

// Opportunistic sweep so entries don't accumulate unbounded.
function sweepFailures(): void {
  const now = Date.now()
  failures.forEach((entry, key) => {
    if (entry.lockedUntil && entry.lockedUntil <= now) failures.delete(key)
  })
}

router.get('/status', (req: AuthedRequest, res) => {
  res.json({
    first_run: isFirstRun(),
    initialized: isInitialized(),
    authenticated: req.isAuthenticated,
  })
})

router.post('/setup', async (req: AuthedRequest, res) => {
  if (!isFirstRun()) {
    res.status(400).json(toErrorEnvelope('already_setup', 'Admin password already set'))
    return
  }
  if (isLockedOut(req)) {
    res.status(429).json(toErrorEnvelope('too_many_attempts', 'Too many attempts — try again later'))
    return
  }
  const { password } = req.body || {}
  try {
    await setupAdminPassword(password)
    clearFailures(req)
    issueToken(res)
    req.log.info({ ip: clientKey(req) }, 'admin password initialized (first run)')
    res.json({ ok: true })
  } catch (err: any) {
    recordFailure(req)
    res.status(400).json(toErrorEnvelope('bad_password', err.message))
  }
})

router.post('/login', async (req: AuthedRequest, res) => {
  sweepFailures()
  if (isLockedOut(req)) {
    res.status(429).json(toErrorEnvelope('too_many_attempts', 'Too many failed attempts — try again later'))
    return
  }
  if (isFirstRun()) {
    res.status(400).json(toErrorEnvelope('first_run', 'Please set up admin password first'))
    return
  }
  const { password } = req.body || {}
  if (!password) {
    res.status(400).json(toErrorEnvelope('missing_password', 'Password required'))
    return
  }
  if (!(await verifyPassword(password))) {
    recordFailure(req)
    req.log.warn({ ip: clientKey(req) }, 'login failed: wrong password')
    res.status(401).json(toErrorEnvelope('wrong_password', 'Incorrect password'))
    return
  }
  clearFailures(req)
  issueToken(res)
  req.log.info({ ip: clientKey(req) }, 'login succeeded')
  res.json({ ok: true })
})

router.post('/logout', requireAuth, (req: AuthedRequest, res) => {
  clearToken(res)
  res.json({ ok: true })
})

router.post('/change-password', requireAuth, async (req: AuthedRequest, res) => {
  const { old_password, new_password } = req.body || {}
  if (!old_password || !new_password) {
    res.status(400).json(toErrorEnvelope('missing_fields', 'Both old and new password required'))
    return
  }
  // Surface policy violations with a precise code so the UI can guide the user.
  const policyErr = validatePasswordPolicy(new_password)
  if (policyErr) {
    res.status(400).json(toErrorEnvelope(policyErr.code, policyErr.message))
    return
  }
  if (!(await changePassword(old_password, new_password))) {
    recordFailure(req)
    req.log.warn({ ip: clientKey(req) }, 'password change failed: old password incorrect')
    res.status(401).json(toErrorEnvelope('wrong_password', 'Old password incorrect'))
    return
  }
  clearFailures(req)
  // changePassword bumps the token version, invalidating the caller's current
  // cookie — re-issue a fresh one so the session survives the change.
  issueToken(res)
  req.log.info('admin password changed')
  res.json({ ok: true })
})

export default router
