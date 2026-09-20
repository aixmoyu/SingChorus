import { randomBytes } from 'node:crypto';

/**
 * Tag composition for rendered configs: `<node-name>-<protocol>-<random>`,
 * e.g. `tokyo-01-hy2-x7k2m9`. Used when the caller leaves `tag` empty —
 * explicit user tags always pass through untouched (cloud's
 * resolveAndValidate already gives user values precedence over generators).
 */

/** Protocol type → short tag prefix. Unmapped types fall back to their first
 *  kebab-case segment (vless-reality-vision → vless). */
const PROTOCOL_SHORT_NAMES: Record<string, string> = {
  hysteria2: 'hy2',
};

const TAG_SUFFIX_LEN = 6;
const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Lowercase, collapse non-alphanumerics to single dashes, trim edges. */
export function slugifyName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'node';
}

export function composeTag(nodeName: string, protocolType: string): string {
  const short = PROTOCOL_SHORT_NAMES[protocolType] ?? slugifyName(protocolType.split('-')[0]);
  const buf = randomBytes(TAG_SUFFIX_LEN);
  let suffix = '';
  for (let i = 0; i < TAG_SUFFIX_LEN; i++) {
    suffix += TAG_ALPHABET[buf[i] % TAG_ALPHABET.length];
  }
  return `${slugifyName(nodeName)}-${short}-${suffix}`;
}
