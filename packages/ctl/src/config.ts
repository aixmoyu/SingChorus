import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface CtlConfig {
  jsonOutput: boolean
}

const STORE_DIR = join(homedir(), '.singchorus', 'ctl');
const CONFIG_PATH = join(STORE_DIR, 'config.json');

let cached: CtlConfig | null = null;

export function loadCtlConfig(): CtlConfig {
  if (cached !== null) return cached;
  if (existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      cached = data as CtlConfig;
      return cached;
    } catch { /* fall through */ }
  }
  cached = { jsonOutput: false };
  return cached;
}

export function saveCtlConfig(cfg: CtlConfig) {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  cached = cfg;
}
