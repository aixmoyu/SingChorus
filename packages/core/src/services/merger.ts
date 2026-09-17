import type { ConfigEntry } from '../schemas/config.js';

/** Collect inbound objects from an entry's server config.
 * Cloud-rendered protocol configs are a single inbound object, not wrapped in an `inbounds` array. */
function collectInbounds(sc: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(sc.inbounds)) return sc.inbounds as Record<string, unknown>[];
  if (typeof sc.type === 'string') return [sc];
  return [];
}

/** Fallback server-config assembly for when the cloud render endpoint is
 * unavailable. Inbounds are exactly the configured protocol inbounds —
 * no extra local proxy listener. */
export function mergeServer(entries: ConfigEntry[]): Record<string, unknown> {
  const outbounds: Record<string, unknown>[] = [{ type: 'direct', tag: 'direct' }];
  const route: Record<string, unknown> = { rules: [], final: 'direct' };

  const inbounds: Record<string, unknown>[] = [];
  for (const e of entries) {
    if (!e.server_config) continue;
    inbounds.push(...collectInbounds(e.server_config));
  }

  return {
    log: { level: 'info' },
    inbounds,
    outbounds,
    route,
  };
}

/** Fallback subscription assembly. Outbounds only — local inbound listening
 * is the client's own concern, not the subscription's. */
export function mergeSubscription(entries: ConfigEntry[]): Record<string, unknown> {
  const outbounds: Record<string, unknown>[] = [];

  for (const e of entries) {
    if (!e.client_config) continue;
    const cc = e.client_config;
    if (Array.isArray(cc.outbounds)) {
      outbounds.push(...(cc.outbounds as Record<string, unknown>[]));
    } else if (typeof cc.type === 'string') {
      // Single outbound object, as rendered by cloud protocol templates.
      outbounds.push(cc);
    }
  }

  outbounds.push({ type: 'direct', tag: 'direct' });

  return {
    log: { level: 'info' },
    outbounds,
    route: { rules: [], final: 'proxy' },
  };
}
