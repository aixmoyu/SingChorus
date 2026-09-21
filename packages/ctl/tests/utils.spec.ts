import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseParams, confirm } from '../src/utils.js';
import { setJsonOutput, isJson } from '../src/config.js';

describe('parseParams', () => {
  it('解析 key=value 列表', () => {
    expect(parseParams(['tag=foo', 'port=443'])).toEqual({ tag: 'foo', port: '443' });
  });

  it('value 中允许包含 =', () => {
    expect(parseParams(['a=b=c'])).toEqual({ a: 'b=c' });
  });

  it('无 = 的参数直接报错退出而不是静默跳过', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => parseParams(['notapair'])).toThrow('__exit__');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('confirm', () => {
  it('非 TTY 环境直接返回 false，不悬空等待 stdin', async () => {
    // vitest worker 中 stdin 通常不是 TTY；即便个别环境是 TTY，
    // 该断言也应跳过而不是挂起。
    if (process.stdin.isTTY) return;
    await expect(confirm('删除? (y/N) ')).resolves.toBe(false);
  });
});

describe('json 输出状态', () => {
  beforeEach(() => setJsonOutput(false));
  afterEach(() => setJsonOutput(false));

  it('setJsonOutput 切换内存态，isJson 读取', () => {
    expect(isJson()).toBe(false);
    setJsonOutput(true);
    expect(isJson()).toBe(true);
  });
});
