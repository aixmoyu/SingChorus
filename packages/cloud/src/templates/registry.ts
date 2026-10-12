/**
 * 内置模板的唯一注册源：新增模板 = 新建文件夹 + 在这里加一个条目。
 * db/seed.ts（seedIfEmpty）与 routes/admin.ts（POST /api/admin/seed）
 * 均从本文件消费，杜绝两套种子源失同步。
 */
import type { ProtocolConfigFile, OverallConfigFile } from '../engine/types';

import hysteria2Config from './protocols/hysteria2/config.json';
import hysteria2Server from './protocols/hysteria2/server.json';
import hysteria2Client from './protocols/hysteria2/client.json';
import vlessConfig from './protocols/vless-reality-vision/config.json';
import vlessServer from './protocols/vless-reality-vision/server.json';
import vlessClient from './protocols/vless-reality-vision/client.json';
import serverTemplate from './server/default/template.json';
import serverConfig from './server/default/config.json';
import serverCfTemplate from './server/default-cf/template.json';
import serverCfConfig from './server/default-cf/config.json';
import clientTemplate from './client/default/template.json';
import clientConfig from './client/default/config.json';
import clientTsTemplate from './client/default-ts/template.json';
import clientTsConfig from './client/default-ts/config.json';
import dockerTemplate from './docker/default/template.json';
import dockerConfig from './docker/default/config.json';

const hy2Config = hysteria2Config as ProtocolConfigFile;
const vlessCfg = vlessConfig as ProtocolConfigFile;
const serverCfg = serverConfig as OverallConfigFile;
const serverCfCfg = serverCfConfig as OverallConfigFile;
const clientCfg = clientConfig as OverallConfigFile;
const clientTsCfg = clientTsConfig as OverallConfigFile;
// select param 的字面量推导类型与 zod 联合类型不重叠，先经 unknown 中转
const dockerCfg = dockerConfig as unknown as OverallConfigFile;

export interface TemplateSeed {
  id: string;
  category: string;
  name: string;
  version: string;
  server_template: string | null;
  client_template: string | null;
  template_content: string | null;
  config: string | null;
  entry_script: string | null;
  params: string;
  description: string | null;
  singbox_compat: string | null;
}

export const templateSeeds: TemplateSeed[] = [
  // Protocol templates
  {
    id: 'hysteria2',
    category: 'protocol',
    name: hy2Config.name,
    version: hy2Config.version,
    server_template: JSON.stringify(hysteria2Server),
    client_template: JSON.stringify(hysteria2Client),
    template_content: null,
    config: null,
    entry_script: null,
    params: JSON.stringify(hy2Config.params),
    description: hy2Config.description ?? null,
    // certificate_provider (ACME) was introduced in sing-box 1.12
    singbox_compat: hy2Config.singbox_compat ?? null,
  },
  {
    id: 'vless-reality-vision',
    category: 'protocol',
    name: vlessCfg.name,
    version: vlessCfg.version,
    server_template: JSON.stringify(vlessServer),
    client_template: JSON.stringify(vlessClient),
    template_content: null,
    config: null,
    entry_script: null,
    params: JSON.stringify(vlessCfg.params),
    description: vlessCfg.description ?? null,
    // xtls-rprx-vision flow requires sing-box >= 1.8
    singbox_compat: vlessCfg.singbox_compat ?? null,
  },
  // Overall templates
  {
    id: 'server-default',
    category: 'overall-server',
    name: serverCfg.name ?? 'Default Server Config',
    version: serverCfg.version ?? '1.0.0',
    server_template: null,
    client_template: null,
    template_content: JSON.stringify(serverTemplate),
    config: JSON.stringify(serverConfig),
    entry_script: null,
    params: '[]',
    description: serverCfg.description ?? 'Default server overall template',
    // http_clients / default_domain_resolver / new DNS format are 1.12+ syntax
    singbox_compat: serverCfg.singbox_compat ?? null,
  },
  {
    id: 'server-default-cf',
    category: 'overall-server',
    name: serverCfCfg.name ?? 'Default Server Config (Cloudflare WARP)',
    version: serverCfCfg.version ?? '1.0.0',
    server_template: null,
    client_template: null,
    template_content: JSON.stringify(serverCfTemplate),
    config: JSON.stringify(serverCfConfig),
    entry_script: null,
    params: '[]',
    description: serverCfCfg.description ?? 'Default server overall template with Cloudflare WARP endpoint',
    // Same syntax family as server-default (1.12+); wireguard endpoint exists since 1.11
    singbox_compat: serverCfCfg.singbox_compat ?? null,
  },
  {
    id: 'client-default',
    category: 'overall-client',
    name: clientCfg.name ?? 'Default Client Config',
    version: clientCfg.version ?? '1.0.0',
    server_template: null,
    client_template: null,
    template_content: JSON.stringify(clientTemplate),
    config: JSON.stringify(clientConfig),
    entry_script: null,
    params: '[]',
    description: clientCfg.description ?? 'Default client overall template',
    singbox_compat: clientCfg.singbox_compat ?? null,
  },
  {
    id: 'client-default-ts',
    category: 'overall-client',
    name: clientTsCfg.name ?? 'Default Client Config (Tailscale)',
    version: clientTsCfg.version ?? '1.0.0',
    server_template: null,
    client_template: null,
    template_content: JSON.stringify(clientTsTemplate),
    config: JSON.stringify(clientTsConfig),
    entry_script: null,
    params: '[]',
    description: clientTsCfg.description ?? 'Default client overall template with Tailscale endpoint',
    singbox_compat: clientTsCfg.singbox_compat ?? null,
  },
  {
    id: 'docker-default',
    category: 'overall-docker',
    name: dockerCfg.name ?? 'Default Docker Compose',
    version: dockerCfg.version ?? '1.0.0',
    server_template: null,
    client_template: null,
    template_content: JSON.stringify(dockerTemplate),
    config: JSON.stringify(dockerConfig),
    // Matches the panel-side entry script: verify, format, then run.
    entry_script: '#!/bin/sh\nset -e\nconfigFilePath="/data/config.json"\necho "entry"\nsing-box version\necho -e "\\nconfig:"\nsing-box check -c $configFilePath || cat $configFilePath\necho -e "\\nstarting"\nsing-box run -c $configFilePath\n',
    params: JSON.stringify(dockerCfg.params),
    description: dockerCfg.description ?? 'Default docker-compose template',
    // entry.sh only uses basic subcommands — keep the range wide
    singbox_compat: dockerCfg.singbox_compat ?? null,
  },
];

/** 种子结构摘要（id + category）：测试通过它推导条数/分组，禁止在测试里
 * 硬编码种子数量（种子集随功能演进，演进时不应需要改测试）。 */
export const SEED_TEMPLATES = templateSeeds.map(({ id, category }) => ({ id, category }));

/** 协议模板的 config.json 原文，admin /seed 预校验用（协议行不落 config 列）。 */
export const seedProtocolConfigs: Record<string, ProtocolConfigFile> = {
  hysteria2: hy2Config,
  'vless-reality-vision': vlessCfg,
};

/** overall 模板的 config.json 原文，admin /seed 预校验用。 */
export const seedOverallConfigs: Record<string, OverallConfigFile> = {
  'server-default': serverCfg,
  'server-default-cf': serverCfCfg,
  'client-default': clientCfg,
  'client-default-ts': clientTsCfg,
  'docker-default': dockerCfg,
};
