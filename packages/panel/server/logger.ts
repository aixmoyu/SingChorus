/**
 * Panel server logger (pino).
 *
 * JSON lines to stdout only — production runs under docker/journald which own
 * rotation and retention; the server never writes log files itself.
 * Level via CHORUS_LOG_LEVEL (default: info in production, debug otherwise).
 * Dev can pipe through pino-pretty (`pnpm dev:server | pino-pretty`).
 */
import pino from 'pino'
import { isProduction } from './env.js'

const defaultLevel =
  process.env.NODE_ENV === 'test' ? 'warn' : isProduction ? 'info' : 'debug'

export const logger = pino({
  level: process.env.CHORUS_LOG_LEVEL || defaultLevel,
  // Never let secrets reach the logs, even in debug level.
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'accessToken',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
})
