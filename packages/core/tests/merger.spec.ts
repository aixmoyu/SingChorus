import { describe, it, expect } from 'vitest';
import { mergeServer, mergeSubscription } from '../src/services/merger';
import type { ConfigEntry } from '../src/schemas/config';

function makeEntry(overrides: Partial<ConfigEntry>): ConfigEntry {
  return {
    name: 'test',
    node: 'default',
    type: 'hysteria2',
    enabled: true,
    synced: false,
    content_hash: '',
    server_config: {},
    client_config: {},
    params: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('mergeServer', () => {
  it('collects single inbound objects from cloud-rendered configs', () => {
    const entries = [
      makeEntry({
        server_config: { type: 'hysteria2', tag: 'hy2-a', listen: '::', listen_port: 8443 },
      }),
      makeEntry({
        server_config: { type: 'vless', tag: 'vless-b', listen: '::', listen_port: 443 },
      }),
    ];
    const result = mergeServer(entries) as any;
    // Inbounds are exactly the protocol inbounds — nothing extra.
    expect(result.inbounds).toHaveLength(2);
    expect(result.inbounds.map((i: any) => i.tag)).toEqual(['hy2-a', 'vless-b']);
    expect(result.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
  });

  it('still supports entries wrapping inbounds in an array', () => {
    const entries = [
      makeEntry({
        server_config: { inbounds: [{ type: 'hysteria2', tag: 'hy2-a', listen_port: 8443 }] },
      }),
    ];
    const result = mergeServer(entries) as any;
    expect(result.inbounds).toHaveLength(1);
    expect(result.inbounds[0].tag).toBe('hy2-a');
  });

  it('server_config 为空或无法识别形态的条目被跳过，不产生垃圾 inbound', () => {
    const entries = [
      makeEntry({ server_config: {} }),                    // 无 type 也无 inbounds
      makeEntry({ name: 'valid', server_config: { type: 'vless', tag: 'v' } }),
      makeEntry({ name: 'empty', server_config: undefined as any }),
    ];
    const result = mergeServer(entries) as any;
    expect(result.inbounds.map((i: any) => i.tag)).toEqual(['v']);
  });

  it('空列表 → 合法可运行的骨架配置', () => {
    const result = mergeServer([]) as any;
    expect(result.inbounds).toEqual([]);
    expect(result.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
    expect(result.route.final).toBe('direct');
  });
});

describe('mergeSubscription', () => {
  it('collects single outbound objects from cloud-rendered configs', () => {
    const entries = [
      makeEntry({
        client_config: { type: 'hysteria2', tag: 'hy2-a', server: '1.1.1.1', server_port: 8443 },
      }),
      makeEntry({
        client_config: { outbounds: [{ type: 'vless', tag: 'vless-b' }] },
      }),
    ];
    const result = mergeSubscription(entries) as any;
    expect(result.outbounds.map((o: any) => o.tag)).toEqual(['hy2-a', 'vless-b', 'direct']);
    expect(result.route.final).toBe('proxy');
    // No local inbound listening — that's the client's concern.
    expect(result.inbounds).toBeUndefined();
  });
});
