#!/usr/bin/env node
import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { deployCommand } from './commands/deploy.js';
import { cloudCommand } from './commands/cloud.js';
import { panelCommand } from './commands/panel.js';
import { subscriptionCommand } from './commands/subscription.js';
import { ChorusCore } from '@chorus/core';
import { loadCtlConfig, saveCtlConfig } from './config.js';

const program = new Command();

program
  .name('chorusctl')
  .description('SingChorus 命令行管理工具（R-CTL-D4：脚本集成必须使用 --json 输出，人读文案格式不保证稳定）')
  .version('0.1.0')
  .option('-j, --json', 'JSON 格式输出')
  .hook('preAction', (thisCmd) => {
    const opts = thisCmd.optsWithGlobals();
    const cfg = loadCtlConfig();
    cfg.jsonOutput = !!opts.json;
    saveCtlConfig(cfg);
  });

program.addCommand(configCommand);
program.addCommand(deployCommand);
program.addCommand(cloudCommand);
program.addCommand(panelCommand);
program.addCommand(subscriptionCommand);

program
  .command('health')
  .description('检查本地引擎状态')
  .action(() => {
    const core = new ChorusCore();
    try {
      const configs = core.configs.listAll();
      console.log(`\x1b[32m\u2705 本地引擎正常: ${configs.length} 个配置\x1b[0m`);
      console.log(core.metrics());
    } catch (err: any) {
      console.error(`\x1b[31m\u274c 错误: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

// Direct-run detection: dev runs execute src/index.ts (bun/tsx), while npx /
// npm-bin runs execute the compiled dist/index.js. Skip auto-parse when the
// module is imported by tests or other tools.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('chorusctl')) {
  program.parse(process.argv);
}

export { program };
