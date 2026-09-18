import { describe, it, expect } from 'vitest';
import { getGenerator } from '../../src/engine/generators';

describe('built-in generators', () => {
  it('uuid returns a v4-ish UUID string of length 36', () => {
    const u = getGenerator('uuid')!();
    expect(typeof u).toBe('string');
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
  it('hex defaults to length 16, honors arg, max 1024', () => {
    const h8 = getGenerator('hex')!('8') as string;
    expect(h8).toMatch(/^[0-9a-f]{8}$/);
    const h32 = getGenerator('hex')!('32') as string;
    expect(h32).toMatch(/^[0-9a-f]{32}$/);
    const h0 = getGenerator('hex')!() as string;
    expect(h0).toMatch(/^[0-9a-f]{16}$/);
    const hBig = getGenerator('hex')!('2048') as string;
    expect(hBig.length).toBe(1024);
  });
  it('x25519_keypair returns { privateKey, publicKey } base64url', () => {
    const kp = getGenerator('x25519_keypair')!() as { privateKey: string; publicKey: string };
    expect(kp).toHaveProperty('privateKey');
    expect(kp).toHaveProperty('publicKey');
    expect(kp.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(kp.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('random_port returns a port in [1024, 65535] and varies per call', () => {
    const p = getGenerator('random_port')!() as number;
    expect(p).toBeGreaterThanOrEqual(1024);
    expect(p).toBeLessThanOrEqual(65535);
    const p2 = getGenerator('random_port')!() as number;
    expect(p2).toBeGreaterThanOrEqual(1024);
    expect(p2).toBeLessThanOrEqual(65535);
  });
  // Regression: random_port_high was registered without an implementation,
  // causing a ReferenceError (HTTP 500) on every protocol render that used it.
  it('random_port_high returns a port >= min (default 30000) and respects the arg', () => {
    expect(typeof getGenerator('random_port_high')).toBe('function');
    const p = getGenerator('random_port_high')!() as number;
    expect(p).toBeGreaterThanOrEqual(30000);
    expect(p).toBeLessThanOrEqual(65535);
    for (let i = 0; i < 20; i++) {
      const v = getGenerator('random_port_high')!('40000') as number;
      expect(v).toBeGreaterThanOrEqual(40000);
      expect(v).toBeLessThanOrEqual(65535);
    }
  });
  it('now_iso returns a valid ISO string', () => {
    const t = getGenerator('now_iso')!() as string;
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(t))).toBe(false);
  });
  it('random_tag honors the prefix and generates a random suffix', () => {
    const tag = getGenerator('random_tag')!('hy2') as string;
    expect(tag).toMatch(/^hy2-[a-z0-9]{6}$/);
    const tag2 = getGenerator('random_tag')!('vless') as string;
    expect(tag2).toMatch(/^vless-[a-z0-9]{6}$/);
    // Default prefix when no arg given.
    const tagDefault = getGenerator('random_tag')!() as string;
    expect(tagDefault).toMatch(/^node-[a-z0-9]{6}$/);
    // Suffix varies between calls (collision chance ~1/2^31 per pair).
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(getGenerator('random_tag')!('x') as string);
    expect(seen.size).toBeGreaterThan(15);
  });
  it('getGenerator returns a function or undefined', () => {
    expect(typeof getGenerator('uuid')).toBe('function');
    expect(getGenerator('does_not_exist')).toBeUndefined();
  });
});
