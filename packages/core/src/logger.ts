/**
 * Minimal injectable logger for @chorus/core.
 *
 * core is a library: it must not hard-wire a logging implementation (panel
 * injects pino, ctl keeps plain console, tests stay silent). Hosts pass a
 * `Logger` via `ChorusCore` options; anything not injected falls back to the
 * console default below, which preserves the historical `console.warn/error`
 * behavior for CLI usage.
 *
 * Meta is a free-form object (e.g. `{ config: name, attempt: 2 }`) — structured
 * hosts (pino / the cloud logger) index it, the console default prints it as
 * JSON suffix.
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function fmt(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  return ` ${JSON.stringify(meta)}`;
}

/**
 * Default when the host injects nothing: warn/error reach stderr exactly as
 * before; debug/info are dropped (core never emitted them historically).
 */
export const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, meta) => console.warn(`${msg}${fmt(meta)}`),
  error: (msg, meta) => console.error(`${msg}${fmt(meta)}`),
};

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
