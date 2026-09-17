import { Command } from 'commander';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const panelCommand = new Command('panel')
  .description('启动 ChorusPanel Web UI');

/**
 * Run a build command with friendly failure output (R-CTL-D2): the raw
 * ENOENT/npm stack is replaced by the equivalent manual command so the
 * operator can recover without reverse-engineering the CLI internals.
 */
function runBuildStep(label: string, command: string, cwd: string): void {
  console.log(`\x1b[33m需要先${label}...\x1b[0m`);
  try {
    execSync(command, { cwd, stdio: 'inherit' });
  } catch {
    console.error(`\x1b[31m错误: ${label}失败\x1b[0m`);
    console.error(`请检查网络与依赖安装后，在仓库根目录手动执行: ${command}`);
    process.exit(1);
  }
}

/**
 * Locate a runnable ChorusPanel server entry.
 *
 * Resolution order:
 *  1. Installed `@chorus/panel` package (npm dependency / npx cache) — the
 *     published tarball ships prebuilt dist-server, nothing to build.
 *  2. Sibling `packages/panel` in the monorepo (dev checkout) — builds
 *     on demand with pnpm like before.
 * Returns null when neither exists (caller prints the npx hint).
 */
function resolvePanelServer(): { serverEntry: string; cwd: string } | null {
  // 1) Installed / workspace-linked @chorus/panel package
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve('@chorus/panel/package.json'));
    const serverEntry = join(pkgDir, 'dist-server', 'index.js');
    if (existsSync(serverEntry)) {
      return { serverEntry, cwd: pkgDir };
    }
    console.error(`\x1b[31m错误: 已安装的 @chorus/panel 缺少预编译产物 (dist-server)\x1b[0m`);
    console.error(`请重新安装: npm install -g @chorus/panel`);
    process.exit(1);
  } catch {
    // not installed — fall through
  }

  // 2) Monorepo dev checkout
  const panelDir = join(__dirname, '..', '..', '..', '..', 'panel');
  const monoRoot = join(__dirname, '..', '..', '..', '..');
  const distServer = join(panelDir, 'dist-server', 'index.js');
  if (existsSync(panelDir)) {
    // Check Node.js
    try {
      execSync('node --version', { stdio: 'pipe' });
    } catch {
      console.error(`\x1b[31m错误: Node.js 未安装\x1b[0m`);
      console.error(`请安装 Node.js 18+ 后重试: https://nodejs.org/`);
      process.exit(1);
    }

    // R-CTL-D3: pnpm is required by the on-demand build steps below — check
    // it up front instead of surfacing a raw ENOENT stack mid-build.
    try {
      execSync('pnpm --version', { stdio: 'pipe' });
    } catch {
      console.error(`\x1b[31m错误: pnpm 未安装\x1b[0m`);
      console.error(`按需构建 panel 产物需要 pnpm，请先安装: npm install -g pnpm`);
      process.exit(1);
    }

    if (!existsSync(distServer)) {
      runBuildStep('构建服务器', 'pnpm --filter @chorus/panel build:server', monoRoot);
    }

    const distWeb = join(panelDir, 'dist-web', 'index.html');
    if (!existsSync(distWeb)) {
      runBuildStep('构建前端', 'pnpm --filter @chorus/panel build', monoRoot);
    }

    return { serverEntry: distServer, cwd: panelDir };
  }

  return null;
}

panelCommand
  .command('start')
  .description('启动 Web 管理界面')
  .option('-p, --port <port>', '监听端口', '8088')
  .option('--host <host>', '监听地址', '127.0.0.1')
  .action((opts: { port: string; host: string }) => {
    const resolved = resolvePanelServer();
    if (!resolved) {
      console.error(`\x1b[31m错误: ChorusPanel 包未找到\x1b[0m`);
      console.error(`可独立启动 Web UI: npx @chorus/panel start`);
      process.exit(1);
    }

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    env['CHORUS_PANEL_PORT'] = opts.port;
    env['CHORUS_PANEL_HOST'] = opts.host;

    console.log(`\x1b[32m启动 ChorusPanel → http://${opts.host}:${opts.port}\x1b[0m`);
    const child = spawn('node', [resolved.serverEntry], { cwd: resolved.cwd, env, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
  });
