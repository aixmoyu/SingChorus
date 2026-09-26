/**
 * 分享链接（share URL / URI subscription）转换：sing-box outbound → 标准 URI。
 *
 * url 型订阅交付时，把每个 instance 的 sing-box 客户端 outbound 转成一行
 * 标准分享链接（vless:// hysteria2:// ...），供 V2rayN / NekoBox / Streisand
 * 等客户端导入。格式依据：
 *   - VLESS:  https://github.com/XTLS/Xray-core/discussions/716
 *   - Hysteria2: https://v2.hysteria.network/zh/docs/developers/URI-Scheme/
 *   - Shadowsocks: SIP002（https://shadowsocks.org/doc/sip002.html）
 *   - VMess: v2rayN base64 JSON 约定
 *
 * 纯函数、零依赖（principles_cloud_001_render_engine_pure）：不做 IO、不查
 * D1；无法识别/缺关键字段的 outbound 返回 null，由调用方决定跳过或报错——
 * 与交付端「一个坏 instance 不能挂掉整个订阅」的语义一致。
 */

/** percent-encode a query value（含 & = ? # 等全部保留字符）。 */
function q(v: string): string {
  return encodeURIComponent(v);
}

/**
 * UTF-8 安全的 base64。btoa 只支持 Latin1，中文 tag/password 会抛
 * InvalidCharacterError——本模块契约是「转不出返回 null」而非抛异常，
 * 故统一走这里（先编码成字节再逐字节转 Latin1）。
 */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 分享链接的名称片段（# 后），percent-encoded。 */
function nameFragment(tag: unknown): string {
  return typeof tag === 'string' && tag ? `#${q(tag)}` : '';
}

/** host 可能是 IPv6（含冒号）→ URI authority 里必须加方括号。 */
function formatHost(server: string): string {
  return server.includes(':') ? `[${server}]` : server;
}

/** sing-box tls 对象形状（只取分享链接关心的字段）。 */
interface TlsLike {
  enabled?: boolean;
  server_name?: string;
  insecure?: boolean;
  alpn?: string[];
  utls?: { enabled?: boolean; fingerprint?: string };
  reality?: { enabled?: boolean; public_key?: string; short_id?: string };
}

/** sing-box transport 对象形状。 */
interface TransportLike {
  type?: string;
  path?: string;
  host?: string[] | string;
  headers?: { Host?: string };
  service_name?: string;
}

function tlsOf(outbound: Record<string, unknown>): TlsLike | null {
  const tls = outbound.tls;
  return tls && typeof tls === 'object' ? (tls as TlsLike) : null;
}

function transportOf(outbound: Record<string, unknown>): TransportLike | null {
  const t = outbound.transport;
  return t && typeof t === 'object' ? (t as TransportLike) : null;
}

/** TLS/REALITY/传输层 → 通用 query（Xray 讨论区 716 的参数约定）。 */
function tlsQuery(tls: TlsLike | null, transport: TransportLike | null): Map<string, string> {
  const query = new Map<string, string>();
  if (transport) {
    const type = transport.type;
    if (type === 'ws' || type === 'httpupgrade' || type === 'http' || type === 'grpc' || type === 'quic') {
      query.set('type', type === 'httpupgrade' ? 'ws' : type);
    }
    if (transport.path) query.set('path', transport.path);
    const host = Array.isArray(transport.host) ? transport.host[0] : transport.host
      ?? (transport.type === 'ws' ? transport.headers?.Host : undefined);
    if (host) query.set('host', host);
    if (transport.service_name) query.set('serviceName', transport.service_name);
  }
  if (!tls || !tls.enabled) {
    // 无 TLS：Xray 约定 security=none；无传输层时整段可省略。
    if (transport) query.set('security', 'none');
    return query;
  }
  const reality = tls.reality?.enabled ? tls.reality : null;
  query.set('security', reality ? 'reality' : 'tls');
  if (tls.server_name) query.set('sni', tls.server_name);
  if (tls.alpn?.length) query.set('alpn', tls.alpn.join(','));
  if (tls.utls?.enabled && tls.utls.fingerprint) query.set('fp', tls.utls.fingerprint);
  if (tls.insecure) query.set('allowInsecure', '1');
  if (reality) {
    if (reality.public_key) query.set('pbk', reality.public_key);
    if (reality.short_id) query.set('sid', reality.short_id);
  }
  return query;
}

/** 把 Map 序列化为 query string（保持插入顺序）。 */
function qs(query: Map<string, string>): string {
  return [...query].map(([k, v]) => `${k}=${q(v)}`).join('&');
}

/**
 * 单个 sing-box outbound → 分享链接。返回 null 表示无法转换（协议不支持或
 * 缺 server/port 等必要字段），调用方跳过即可，不应中断整个订阅交付。
 */
export function outboundToShareUrl(outbound: unknown): string | null {
  if (!outbound || typeof outbound !== 'object') return null;
  const ob = outbound as Record<string, unknown>;
  const server = typeof ob.server === 'string' ? ob.server : '';
  const port = typeof ob.server_port === 'number' || typeof ob.server_port === 'string'
    ? String(ob.server_port) : '';
  if (!server || !port) return null;
  const authority = `${formatHost(server)}:${port}`;
  const name = nameFragment(ob.tag);

  switch (ob.type) {
    case 'vless': {
      if (typeof ob.uuid !== 'string' || !ob.uuid) return null;
      const query = tlsQuery(tlsOf(ob), transportOf(ob));
      query.set('encryption', typeof ob.encryption === 'string' && ob.encryption ? ob.encryption : 'none');
      if (typeof ob.flow === 'string' && ob.flow) query.set('flow', ob.flow);
      return `vless://${q(ob.uuid)}@${authority}?${qs(query)}${name}`;
    }
    case 'trojan': {
      if (typeof ob.password !== 'string' || !ob.password) return null;
      const query = tlsQuery(tlsOf(ob), transportOf(ob));
      return `trojan://${q(ob.password)}@${authority}?${qs(query)}${name}`;
    }
    case 'hysteria2': {
      if (typeof ob.password !== 'string' || !ob.password) return null;
      const query = new Map<string, string>();
      const tls = tlsOf(ob);
      if (tls?.server_name) query.set('sni', tls.server_name);
      if (tls?.insecure) query.set('insecure', '1');
      if (ob.obfs && typeof ob.obfs === 'object') {
        const obfs = ob.obfs as { type?: string; password?: string };
        if (obfs.type) query.set('obfs', obfs.type);
        if (obfs.password) query.set('obfs-password', obfs.password);
      }
      // Hysteria2 URI scheme：hysteria2://auth@host:port/?key=value#name
      const queryString = query.size > 0 ? `/?${qs(query)}` : '/';
      return `hysteria2://${q(ob.password)}@${authority}${queryString}${name}`;
    }
    case 'shadowsocks': {
      if (typeof ob.method !== 'string' || !ob.method
        || typeof ob.password !== 'string' || !ob.password) return null;
      // SIP002：userinfo = base64url(method:password)
      const userinfo = b64(`${ob.method}:${ob.password}`)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `ss://${userinfo}@${authority}${name}`;
    }
    case 'vmess': {
      if (typeof ob.uuid !== 'string' || !ob.uuid) return null;
      const tls = tlsOf(ob);
      const transport = transportOf(ob);
      // v2rayN 约定的 base64 JSON 格式
      const v2 = {
        v: '2',
        ps: typeof ob.tag === 'string' ? ob.tag : '',
        add: server,
        port,
        id: ob.uuid,
        aid: typeof ob.alter_id === 'number' ? String(ob.alter_id) : '0',
        scy: typeof ob.security === 'string' ? ob.security : 'auto',
        net: transport?.type === 'httpupgrade' ? 'ws' : (transport?.type ?? 'tcp'),
        type: '',
        host: transport
          ? (Array.isArray(transport.host) ? transport.host[0] : transport.host)
            ?? (transport.type === 'ws' ? transport.headers?.Host : undefined) ?? ''
          : '',
        path: transport?.path ?? (transport?.service_name ?? ''),
        tls: tls?.enabled ? 'tls' : '',
        sni: tls?.server_name ?? '',
        alpn: tls?.alpn?.join(',') ?? '',
        fp: tls?.utls?.enabled ? tls.utls.fingerprint ?? '' : '',
      };
      return `vmess://${b64(JSON.stringify(v2))}`;
    }
    default:
      return null;
  }
}
