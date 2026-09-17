import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DockerManager, DeployInProgressError } from '../src/services/docker-manager.js';

// mock child_process.execFile：按 handler 路由 docker 子命令，避免真实 docker 依赖。
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => execFileMock(...args),
}));

type Cb = (err: any, stdout: string, stderr: string) => void;
type Handler = (cmd: string, args: string[], cb: Cb) => void;

let handler: Handler = () => { throw new Error('unexpected execFile call'); };
/** 记录每次 docker 调用的子命令序列（如 ['compose','-f',...,'up','-d'] → 'up'） */
let calls: string[][] = [];

beforeEach(() => {
  execFileMock.mockReset();
  calls = [];
  execFileMock.mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
    const callback: Cb = typeof opts === 'function' ? opts : cb;
    calls.push(args);
    handler(cmd, args, callback);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const ok: Handler = (_c, _a, cb) => setImmediate(() => cb(null, '', ''));
const failWith = (stderr: string): Handler => (_c, _a, cb) => setImmediate(() => cb(new Error(stderr), '', stderr));

function newMgr() {
  const dir = join(tmpdir(), `dc-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { mgr: new DockerManager({ docker_dir: dir }), dir };
}
function withCompose(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
}
const sub = (args: string[]) => {
  const f = args.findIndex((a) => a === 'ps' || a === 'up' || a === 'down' || a === 'restart' || a === 'logs' || a === 'info');
  return f >= 0 ? args[f] : args[0];
};

describe('DockerManager.statusCompose（core-A3）', () => {
  it("无 compose 文件 → 'stopped'，且不调用 docker", async () => {
    handler = ok;
    const { mgr } = newMgr();
    await expect(mgr.statusCompose()).resolves.toBe('stopped');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("NDJSON 格式的 compose ps 输出 → running", async () => {
    handler = (_c, args, cb) => {
      if (sub(args) === 'ps') return setImmediate(() => cb(null, '{"State":"running","Health":"healthy"}\n', ''));
      return setImmediate(() => cb(null, '', ''));
    };
    const { mgr, dir } = newMgr();
    withCompose(dir);
    await expect(mgr.statusCompose()).resolves.toBe('running');
  });

  it("JSON 数组格式的 compose ps 输出（core-R6）→ exited → stopped", async () => {
    handler = (_c, args, cb) => {
      if (sub(args) === 'ps') return setImmediate(() => cb(null, '[{"State":"exited"},{"State":"exited"}]', ''));
      return setImmediate(() => cb(null, '', ''));
    };
    const { mgr, dir } = newMgr();
    withCompose(dir);
    await expect(mgr.statusCompose()).resolves.toBe('stopped');
  });

  it("ps 失败且 docker 守护进程不可用 → 'unavailable'（而非误导性的 stopped）", async () => {
    handler = (_c, args, cb) => {
      if (sub(args) === 'info') return setImmediate(() => cb(new Error('daemon down'), '', ''));
      return setImmediate(() => cb(new Error('ps failed'), '', 'ps failed'));
    };
    const { mgr, dir } = newMgr();
    withCompose(dir);
    await expect(mgr.statusCompose()).resolves.toBe('unavailable');
  });

  it("ps 失败但守护进程健康 → 'stopped'", async () => {
    handler = (_c, args, cb) => {
      if (sub(args) === 'info') return setImmediate(() => cb(null, '', ''));
      return setImmediate(() => cb(new Error('ps failed'), '', 'ps failed'));
    };
    const { mgr, dir } = newMgr();
    withCompose(dir);
    await expect(mgr.statusCompose()).resolves.toBe('stopped');
  });
});

describe('DockerManager.deployRendered', () => {
  it('空 compose yaml / entry 脚本 → 在触碰 docker 前快速失败', async () => {
    handler = ok;
    const { mgr } = newMgr();
    await expect(mgr.deployRendered({}, '  ', 'sh')).rejects.toThrow(/empty compose yaml/);
    await expect(mgr.deployRendered({}, 'yaml', ' \n')).rejects.toThrow(/empty entry script/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('成功部署：写入 compose/entry/config 工件，容器健康后返回', async () => {
    handler = (_c, args, cb) => {
      if (sub(args) === 'ps') return setImmediate(() => cb(null, '[{"State":"running","Health":"healthy"}]', ''));
      return setImmediate(() => cb(null, '', ''));
    };
    const { mgr, dir } = newMgr();
    const serverConfig = { inbounds: [{ type: 'hysteria2', listen_port: 443 }] };
    await mgr.deployRendered(serverConfig, 'services: {}\n', '#!/bin/sh\nexec "$@"');

    expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8')).toBe('services: {}\n');
    expect(JSON.parse(readFileSync(join(dir, 'data', 'config.json'), 'utf-8'))).toEqual(serverConfig);
    expect(readFileSync(join(dir, 'data', 'entry.sh'), 'utf-8')).toBe('#!/bin/sh\nexec "$@"');
    expect(calls.map(sub)).toContain('up');
  });

  it('容器始终不健康 → down + 回滚上一份 config.json + DockerError（core-A2）', async () => {
    const { mgr, dir } = newMgr();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), '{"old":true}');

    handler = (_c, args, cb) => {
      if (sub(args) === 'ps') return setImmediate(() => cb(null, '[{"State":"exited"}]', ''));
      return setImmediate(() => cb(null, '', ''));
    };

    vi.useFakeTimers();
    const pending = mgr.deployRendered({ new: true }, 'services: {}\n', '#!/bin/sh\n');
    const assertion = expect(pending).rejects.toThrow(/failed to become healthy/i);
    // 健康检查窗口 30s、3s 轮询
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;

    // 回滚：config.json 恢复旧内容，栈被 down
    expect(readFileSync(join(dataDir, 'config.json'), 'utf-8')).toBe('{"old":true}');
    expect(calls.map(sub)).toContain('down');
  });

  it('进行中的 deploy 使第二次请求得到 DEPLOY_IN_PROGRESS(409)；进程内串行', async () => {
    let releaseUp!: Cb;
    let heldOnce = false;
    handler = (_c, args, cb) => {
      if (sub(args) === 'up') {
        if (!heldOnce) { heldOnce = true; releaseUp = cb; return; } // 仅挂起第一次 compose up
        return setImmediate(() => cb(null, '', ''));
      }
      if (sub(args) === 'ps') return setImmediate(() => cb(null, '[{"State":"running"}]', ''));
      return setImmediate(() => cb(null, '', ''));
    };
    const { mgr } = newMgr();
    const first = mgr.deployRendered({}, 'yaml\n', 'sh\n');
    await expect(mgr.deployRendered({}, 'yaml\n', 'sh\n'))
      .rejects.toMatchObject({ code: 'DEPLOY_IN_PROGRESS', statusCode: 409 });
    // 等待首个 deploy 走到 compose up 并挂起（中间有 chmod 等异步步骤）
    await vi.waitFor(() => {
      if (typeof releaseUp !== 'function') throw new Error('compose up not called yet');
    });
    releaseUp(null, '', '');
    await expect(first).resolves.toBeUndefined();
    // 释放后允许再次部署（up 立即成功）
    await expect(mgr.deployRendered({}, 'yaml\n', 'sh\n')).resolves.toBeUndefined();
  });

  it('跨进程部署锁被占用（.deploy.lock 存在）→ DEPLOY_IN_PROGRESS（core-R4）', async () => {
    handler = ok;
    const { mgr, dir } = newMgr();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.deploy.lock'), '999\n'); // 他人持有（未过期）
    await expect(mgr.deployRendered({}, 'yaml\n', 'sh\n')).rejects.toBeInstanceOf(DeployInProgressError);
    // 锁文件未被误删（持有者仍持有）
    expect(existsSync(join(dir, '.deploy.lock'))).toBe(true);
  });
});

describe('DockerManager 生命周期', () => {
  it('stopCompose：无 compose 文件时跳过 docker 调用', async () => {
    handler = ok;
    const { mgr } = newMgr();
    await mgr.stopCompose();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('stopCompose：有 compose 文件 → compose down', async () => {
    handler = ok;
    const { mgr, dir } = newMgr();
    withCompose(dir);
    await mgr.stopCompose();
    expect(calls.map(sub)).toEqual(['down']);
  });

  it('restartCompose：restart 失败 → 降级 down + up -d', async () => {
    handler = (_c, args, cb) => {
      if (sub(args) === 'restart') return setImmediate(() => cb(new Error('restart failed'), '', ''));
      return setImmediate(() => cb(null, '', ''));
    };
    const { mgr, dir } = newMgr();
    withCompose(dir);
    await mgr.restartCompose();
    expect(calls.map(sub)).toEqual(['restart', 'down', 'up']);
  });

  it('logsCompose：无 compose 文件 → 空字符串；失败 → 空字符串而非抛错', async () => {
    handler = failWith('no logs');
    const { mgr, dir } = newMgr();
    await expect(mgr.logsCompose()).resolves.toBe('');
    withCompose(dir);
    handler = (_c, args, cb) => {
      if (sub(args) === 'logs') return setImmediate(() => cb(null, 'line1\nline2\n', ''));
      return setImmediate(() => cb(null, '', ''));
    };
    await expect(mgr.logsCompose(50)).resolves.toBe('line1\nline2\n');
    expect(calls.map(sub)).toContain('logs');
  });
});

describe('DockerManager 备份治理', () => {
  it('多次部署后 config.json.bak 数量不超过 5（BACKUP_KEEP）', async () => {
    handler = (_c, args, cb) => {
      if (sub(args) === 'ps') return setImmediate(() => cb(null, '[{"State":"running"}]', ''));
      return setImmediate(() => cb(null, '', ''));
    };
    const { mgr, dir } = newMgr();
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    // 预置 8 份历史备份 + 当前 config
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(dataDir, `config.json.bak.2026-01-0${i}T00-00-00-000Z`), '{}');
    }
    writeFileSync(join(dataDir, 'config.json'), '{"current":true}');

    await mgr.deployRendered({ v: 1 }, 'services: {}\n', '#!/bin/sh\n');
    const baks = readdirSync(dataDir).filter((f) => f.startsWith('config.json.bak.'));
    expect(baks.length).toBeLessThanOrEqual(5);
    // 本次部署又生成了一份备份
    expect(baks.length).toBeGreaterThanOrEqual(1);
  });
});
