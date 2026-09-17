import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudClient } from '../src/services/cloud-client.js';
import { AppError } from '../src/errors.js';

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    text: async () => JSON.stringify(body),
    json: async () => JSON.parse(JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CloudClient.request (core-D2 / 预算·重试·401 自愈)', () => {
  it('5xx 按退避表重试，成功后返回数据', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 'KV_UNAVAILABLE', message: 'quota' } }))
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 'KV_UNAVAILABLE', message: 'quota' } }))
      .mockResolvedValueOnce(jsonResponse(200, { protocols: [{ id: 'p1' }] }));

    const client = new CloudClient(); // cloud_token 为空 → 不触发 login
    const pending = client.getProtocols();

    // 重试退避 1s + 4s
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual([{ id: 'p1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('noRetry 请求 5xx 时不重试，立即快速失败', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: 'boom' } }));

    const client = new CloudClient();
    // checkTagAvailable：检查端点不可用时不阻塞创建 → 返回 true
    await expect(client.checkTagAvailable('tag1')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络错误持续发生时在 25s 预算内抛 CLOUD_UNREACHABLE（不超前端 30s 超时）', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const client = new CloudClient();
    const pending = client.getProtocols();
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'CLOUD_UNREACHABLE',
      statusCode: 503,
    });

    // 预算 25s 内全部退避耗尽（1+4+16=21s 后第四次尝试立即失败）
    await vi.runAllTimersAsync();
    await assertion;

    // 预算约束：请求数 = 25s 预算内能容纳的尝试次数（≤ RETRY_DELAYS.length）
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
  });

  it('401 时清空缓存令牌并用新令牌重试一次', async () => {
    fetchMock
      // ensureToken: login 换 JWT
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt-1', expiresIn: 3600 }))
      // 数据请求带旧令牌 → 401
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: 'expired' } }))
      // 401 后清缓存重新 login
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt-2', expiresIn: 3600 }))
      // 重试成功
      .mockResolvedValueOnce(jsonResponse(200, { clients: [{ name: 'a' }] }));

    const client = new CloudClient({ cloud_token: 'static-token' });
    await expect(client.getClients()).resolves.toEqual([{ name: 'a' }]);

    // login 两次 + 数据请求两次
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const retryAuth = fetchMock.mock.calls[3][1].headers.Authorization;
    expect(retryAuth).toBe('Bearer jwt-2');
  });

  it('login 失败时回退静态令牌，请求照常发出', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: { message: 'no auth endpoint' } }))
      .mockResolvedValueOnce(jsonResponse(200, { clients: [] }));

    const client = new CloudClient({ cloud_token: 'static-token' });
    await expect(client.getClients()).resolves.toEqual([]);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer static-token');
  });
});

describe('CloudClient API 语义', () => {
  it('剥离 baseUrl 末尾的斜杠', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { protocols: [] }));
    const client = new CloudClient({ cloud_url: 'http://x.example///' });
    await client.getProtocols();
    expect(fetchMock.mock.calls[0][0]).toBe('http://x.example/api/protocols');
  });

  it('路径参数做 URL 编码（含斜杠/空格的名称不会撕裂路径）', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { subscription: null }));
    const client = new CloudClient();
    await client.getSubscription('a/b c');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/subscriptions/a%2Fb%20c');
  });

  it('204 响应 → data 为 null，不做 JSON 解析', async () => {
    fetchMock.mockResolvedValue({ status: 204, text: async () => '' } as unknown as Response);
    const client = new CloudClient();
    await expect(client.deleteNodeClient('fp', 'x')).resolves.toBeUndefined();
  });

  it('200 但 body 非 JSON（如 Cloudflare 错误页）→ 降级为 raw 载荷而非抛错', async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => '<html>503 Service Temporarily</html>' } as unknown as Response);
    const client = new CloudClient();
    await expect(client.getProtocols()).resolves.toEqual([]);
  });

  it('uploadNodeClient >=400 → CLOUD_UPLOAD_FAILED AppError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'TAG_DUP', message: 'tag duplicated' } }));
    const client = new CloudClient();
    await expect(client.uploadNodeClient({
      name: 'a', fingerprint: 'fp', config: {}, protocol_type: 'hy2', content_hash: 'h', enabled: true, deployed: false,
    })).rejects.toMatchObject({ code: 'CLOUD_UPLOAD_FAILED', statusCode: 502 });
  });

  it('getNodeClients 404 → 空列表；>=400（重试耗尽）→ CLOUD_UNREACHABLE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
    const client = new CloudClient();
    await expect(client.getNodeClients('fp')).resolves.toEqual([]);

    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: 'kv down' } }));
    const pending = client.getNodeClients('fp2');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'CLOUD_UNREACHABLE' });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('checkTagAvailable：available=false → false（阻塞创建）；错误响应 → true（不阻塞）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { available: false }))
      .mockResolvedValueOnce(jsonResponse(500, {}));
    const client = new CloudClient();
    await expect(client.checkTagAvailable('dup')).resolves.toBe(false);
    await expect(client.checkTagAvailable('whatever')).resolves.toBe(true);
  });

  it('createSubscription 失败时透出 zod issues 细节', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, {
      error: { message: 'Invalid body', issues: [{ path: ['name'], message: 'required' }] },
    }));
    const client = new CloudClient();
    await expect(client.createSubscription({})).rejects.toMatchObject({ code: 'CLOUD_CREATE_FAILED' });
    await client.createSubscription({}).catch((e) => expect(e.message).toContain('name: required'));
  });

  it('JWT 在过期前复用缓存（多次请求只 login 一次）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'jwt-a', expiresIn: 3600 }))
      .mockResolvedValue(jsonResponse(200, { protocols: [] }));
    const client = new CloudClient({ cloud_token: 't' });
    await client.getProtocols();
    await client.getProtocols();
    await client.getProtocols();
    const logins = fetchMock.mock.calls.filter(([url]) => url === 'http://localhost:8787/api/auth/login');
    expect(logins).toHaveLength(1);
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer jwt-a');
  });
});
