import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { CORE_VERSION } from '../src/index.js';

describe('CORE_VERSION', () => {
  it('与 package.json version 一致（防止常量漂移）', () => {
    const pkg = JSON.parse(
      readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../package.json'), 'utf8'),
    );
    expect(CORE_VERSION).toBe(pkg.version);
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
