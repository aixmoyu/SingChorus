#!/usr/bin/env node
/**
 * chorus-panel CLI entry (npm bin / npx).
 *
 * The npm tarball ships prebuilt artifacts (dist-server + dist-web), so this
 * entry never compiles anything: it parses --port/--host into the
 * CHORUS_PANEL_* env vars the server already reads, then loads the compiled
 * server which starts listening on import.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', 'dist-server', 'index.js');

function usage() {
  console.log(`ChorusPanel - SingChorus Web 管理界面

用法: chorus-panel [start] [选项]

选项:
  -p, --port <port>    监听端口 (默认 8088)
  -h, --host <host>    监听地址 (默认 127.0.0.1，对外暴露请用 0.0.0.0)
  --help               显示帮助

数据目录: ~/.singchorus/`);
}

// Accept an optional "start" subcommand plus --port/--host flags.
const args = process.argv.slice(2).filter((a) => a !== 'start');
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

const portFlag = args.indexOf('--port') !== -1 ? args.indexOf('--port') : args.indexOf('-p');
if (portFlag !== -1 && args[portFlag + 1]) {
  process.env.CHORUS_PANEL_PORT = args[portFlag + 1];
}
const hostFlag = args.indexOf('--host');
if (hostFlag !== -1 && args[hostFlag + 1]) {
  process.env.CHORUS_PANEL_HOST = args[hostFlag + 1];
}

if (!existsSync(serverEntry)) {
  console.error('错误: 缺少预编译产物 dist-server，请重新安装本包或在仓库内执行 `pnpm --filter @chorus/panel build`');
  process.exit(1);
}

await import(serverEntry);
