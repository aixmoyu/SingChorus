import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock child_process.execFile：按 handler 路由 docker 子命令，避免真实 docker 依赖。
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => execFileMock(...args),
}));

type Cb = (err: any, stdout: string, stderr: string) => void;
type Handler = (cmd: string, args: string[], cb: Cb) => void;

let handler: Handler = () => { throw new Error('unexpected execFile call'); };

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
    const callback: Cb = typeof opts === 'function' ? opts : cb;
    handler(cmd, args, callback);
  });
});

async function makeValidator(over: Record<string, unknown> = {}) {
  const { SingboxValidator } = await import('../src/services/validator.js');
  return new SingboxValidator({
    singbox_image: 'img:test',
    validate_timeout_seconds: 1,
    prepull_singbox_image: false,
    ...over,
  } as any);
}
const countSub = (name: string) => execFileMock.mock.calls.filter(([, args]) => args[0] === name).length;

describe('SingboxValidator（core-P1）', () => {
  it('docker 不可用 → 跳过校验（valid:true + 提示），且结果进缓存', async () => {
    handler = (_c, args, cb) => {
      if (args[0] === 'info') return setImmediate(() => cb(new Error('daemon down'), '', ''));
      throw new Error('should not reach docker run');
    };
    const v = await makeValidator();
    const r1 = await v.validate({ a: 1 });
    expect(r1.valid).toBe(true);
    expect(r1.errors[0]).toMatch(/Docker not available/);
    // 同内容第二次 → 命中缓存，不再探测 docker
    const r2 = await v.validate({ a: 1 });
    expect(r2).toEqual(r1);
    expect(countSub('info')).toBe(1);
  });

  it('键序不同但内容相同 → 视为同一内容（缓存命中）', async () => {
    handler = (_c, args, cb) => {
      if (args[0] === 'info') return setImmediate(() => cb(new Error('daemon down'), '', ''));
      throw new Error('should not reach docker run');
    };
    const v = await makeValidator();
    await v.validate({ a: 1, b: { x: 2 } });
    await v.validate({ b: { x: 2 }, a: 1 });
    expect(countSub('info')).toBe(1);
  });

  it('内容不同 → 不共用缓存', async () => {
    handler = (_c, args, cb) => {
      if (args[0] === 'info') return setImmediate(() => cb(new Error('daemon down'), '', ''));
      throw new Error('should not reach docker run');
    };
    const v = await makeValidator();
    await v.validate({ a: 1 });
    await v.validate({ a: 2 });
    expect(countSub('info')).toBe(2);
  });

  it('docker run 通过 → valid:true', async () => {
    handler = (_c, args, cb) => {
      if (args[0] === 'info') return setImmediate(() => cb(null, '', ''));
      if (args[0] === 'run') return setImmediate(() => cb(null, '', ''));
      return setImmediate(() => cb(null, '', ''));
    };
    const v = await makeValidator();
    const good = await v.validate({ inbounds: [{ type: 'hysteria2' }] });
    expect(good).toEqual({ valid: true, errors: [] });
    // 校验参数经 execFile 数组传递（无 shell 注入面），config 内容写入临时文件
    const runCall = execFileMock.mock.calls.find(([, args]) => args[0] === 'run');
    expect(runCall?.[1]).toContain('check');
  });

  it('校验失败 → valid:false + docker stderr', async () => {
    handler = (_c, args, cb) => {
      if (args[0] === 'info') return setImmediate(() => cb(null, '', ''));
      if (args[0] === 'run') return setImmediate(() => cb(new Error('exit 1'), '', 'FATAL decode: unknown field'));
      return setImmediate(() => cb(null, '', ''));
    };
    const v = await makeValidator();
    const bad = await v.validate({ bad: true });
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]).toContain('unknown field');
    expect(bad.errors[0]).toContain('FATAL');
  });

  it('单飞：并发同内容校验只跑一次 docker run', async () => {
    handler = (_c, args, cb) => {
      if (args[0] === 'info') return setImmediate(() => cb(null, '', ''));
      if (args[0] === 'run') return setTimeout(() => cb(null, '', ''), 30) as any;
      return setImmediate(() => cb(null, '', ''));
    };
    const v = await makeValidator();
    const [r1, r2] = await Promise.all([v.validate({ x: 1 }), v.validate({ x: 1 })]);
    expect(r1.valid).toBe(true);
    expect(r2).toEqual(r1);
    expect(countSub('run')).toBe(1);
  });

  it('串行队列：并发不同内容校验，任意时刻至多一个 docker run（core-P1）', async () => {
    let running = 0;
    let maxRunning = 0;
    handler = (_c, args, cb) => {
      if (args[0] === 'info') return setImmediate(() => cb(null, '', ''));
      if (args[0] === 'run') {
        running++;
        maxRunning = Math.max(maxRunning, running);
        setTimeout(() => { running--; cb(null, '', ''); }, 20);
        return;
      }
      return setImmediate(() => cb(null, '', ''));
    };
    const v = await makeValidator();
    await Promise.all([v.validate({ a: 1 }), v.validate({ b: 2 }), v.validate({ c: 3 })]);
    expect(maxRunning).toBe(1);
  });
});
