import express, { type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import compression from 'compression'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinoHttp } from 'pino-http'
import { authMiddleware } from './auth.js'
import { resolveCorsOrigin, isProduction, getTrustProxy } from './env.js'
import { toErrorEnvelope } from './api-error.js'
import { logger } from './logger.js'
import { requestContext } from './request-context.js'
import authRoutes from './routes/auth.js'
import coreRoutes from './routes/core.js'
import settingsRoutes from './routes/settings.js'
import infoRoutes from './routes/info.js'
import initRoutes from './routes/init.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * CSRF defence for cookie-based auth: state-changing requests must either be
 * same-origin (Origin host == Host header) or pass the configured CORS
 * allow-list. Requests without an Origin header (curl, server-to-server)
 * are allowed. This complements SameSite cookies rather than replacing them.
 */
function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next()
    return
  }
  const origin = req.headers.origin
  if (!origin) {
    next()
    return
  }
  // Same-origin: browsers send the full URL in Origin; compare its host
  // against the Host header (which includes the port).
  let host = ''
  try {
    host = new URL(origin).host
  } catch { /* malformed origin — fall through to rejection */ }
  if (host && host === req.headers.host) {
    next()
    return
  }
  // Cross-origin: allow only what the CORS allow-list accepts (dev reflects
  // everything so the Vite proxy workflow keeps working).
  const allowed = resolveCorsOrigin(origin)
  if (allowed === true || allowed === origin) {
    next()
    return
  }
  res.status(403).json(toErrorEnvelope('FORBIDDEN_ORIGIN', 'Cross-origin request rejected'))
}

/**
 * Build the Express app. Split from the server entry (index.ts) so tests can
 * import this module without binding a port or installing process handlers.
 */
export function createApp(): express.Application {
  const app = express()

  // Trust proxy: when behind a reverse proxy, CHORUS_PANEL_TRUST_PROXY makes
  // req.ip resolve from X-Forwarded-For so the login rate limiter keys on the
  // real client. Unset → trust nothing (direct 127.0.0.1 access).
  app.set('trust proxy', getTrustProxy())

  // CORS: reflect origin in dev, allow-list in production.
  app.use(
    cors({
      origin: (origin, cb) => cb(null, resolveCorsOrigin(origin)),
      credentials: true,
    }),
  )

  // Compression for text-heavy payloads (logs, configs, template JSON).
  app.use(compression())

  // Hardening headers.
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    next()
  })

  app.use(cookieParser())
  app.use(express.json({ limit: '10mb' }))

  // Request logging + request id (pino-http). Honors an incoming
  // X-Request-ID so callers can correlate; the id is echoed back as a
  // response header and stored in AsyncLocalStorage so deep layers
  // (CloudClient) forward it to the cloud for end-to-end tracing.
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = (req.headers['x-request-id'] as string | undefined) || randomUUID()
      res.setHeader('X-Request-ID', id)
      return id
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error'
      if (res.statusCode >= 400) return 'warn'
      return 'info'
    },
  }))
  // Everything after this point runs inside the request context so
  // `currentRequestId()` works from any async depth.
  app.use((req, _res, next) => {
    requestContext.run({ requestId: (req as { id: string }).id }, () => next())
  })

  app.use(originCheck)
  app.use(authMiddleware)

  app.use('/api/auth', authRoutes)
  app.use('/api/core', coreRoutes)
  app.use('/api/settings', settingsRoutes)
  app.use('/api/info', infoRoutes)
  app.use('/api/init', initRoutes)

  // Unknown /api paths must return JSON 404s — the SPA catch-all below would
  // otherwise answer with index.html and clients would choke parsing it.
  app.use('/api', (_req, res) => {
    res.status(404).json(toErrorEnvelope('NOT_FOUND', 'Unknown API endpoint'))
  })

  const distWeb = path.join(__dirname, '..', 'dist-web')
  app.use(express.static(distWeb))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distWeb, 'index.html'))
  })

  // Centralised error handler — converts thrown errors into a stable envelope.
  // 5xx details are sanitised in production so internal details (paths, fs
  // errors) never reach the client — but the full error IS always logged
  // (with stack) server-side, production included. Skipping this log is what
  // used to make VPS failures undebuggable.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const statusCode = (err as { statusCode?: number }).statusCode || 500
    const code = (err as { code?: string }).code || 'INTERNAL_ERROR'
    const message = statusCode >= 500 && isProduction ? 'Internal server error' : err.message || 'Internal server error'
    if (statusCode >= 500) {
      req.log.error({ err, statusCode }, 'request failed')
    }
    res.status(statusCode).json(toErrorEnvelope(code, message))
  })

  return app
}
