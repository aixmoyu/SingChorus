# SingChorus

Sing-box 配置管理与部署系统：本地引擎（core）+ Web 管理面板（panel）+ 命令行工具（ctl）+ Cloudflare 云端同步（cloud）。

## 环境要求

- **Node.js ≥ 20**（建议 22 LTS）
- **pnpm 11**：仓库声明了 `packageManager: pnpm@11.5.0`，安装 pnpm 后进入仓库会自动切换到该版本（需 pnpm ≥ 10 支持 `manage-package-manager-versions`）

```bash
npm install -g pnpm   # 或 corepack enable
```

## 本地开发

```bash
# 安装依赖（首次）
pnpm install

# 全部服务并行启动（core tsc --watch + panel 双进程 + cloud wrangler dev）
pnpm dev

# 或单独启动
pnpm dev:panel    # panel：Express server (8088, tsx watch) + Vite dev server (5173, /api 代理到 8088)
pnpm dev:cloud    # cloud：wrangler dev (8787)
```

访问入口：panel 开发模式用 `http://localhost:5173`（Vite 提供热更新），生产构建产物在 8088。

### 常用命令（仓库根目录执行）

| 命令 | 说明 |
|---|---|
| `pnpm build` | 按拓扑序构建所有包（core → ctl/panel） |
| `pnpm test` | 运行所有包的测试 |
| `pnpm typecheck` | 所有包 TS 类型检查 |
| `pnpm --filter @chorus/panel build` | 只构建 panel |
| `pnpm --filter chorus-cloud test` | 只跑 cloud 测试 |

> 注意：panel 引用的是 `@chorus/core` 的 **dist 产物**而非源码。首次 `pnpm install` 后或改完 core 后，需先 `pnpm --filter @chorus/core build`，否则 panel 服务端报 `ERR_MODULE_NOT_FOUND`（`pnpm build` 会自动处理构建顺序）。

## 部署

| 目标 | 方式 | 文档 |
| --- | --- | --- |
| Cloudflare | `packages/cloud` 一键部署按钮 / `pnpm setup:prod` | [packages/cloud/docs/deploy.md](packages/cloud/docs/deploy.md) |
| 自托管 VPS / 本地 | 同一份代码的 Node 入口（SQLite 存储，Docker 或裸机） | [packages/cloud/docs/deploy-vps.md](packages/cloud/docs/deploy-vps.md) |

## 发布到 npm

三个包均为独立 npm 包，统一使用 `@chorus` scope：

| 包 | npm 名 | bin 命令 | 内容 |
|---|---|---|---|
| core | `@chorus/core` | — | 引擎库（编译 dist/） |
| panel | `@chorus/panel` | `chorus-panel` | Web UI（tarball 内置预编译 dist-server + dist-web） |
| ctl | `@chorus/ctl` | `chorusctl` | CLI（编译 dist/） |

### 前置条件

1. 在 npm 上拥有 **@chorus 组织**（组织名与包 scope 一致）
2. `npm login` 完成认证
3. 更新对应包的 `version`（直接改各包 package.json，或用 changesets）

### 发布命令

```bash
# 必须按顺序：core 先发，panel/ctl 依赖它
pnpm publish:core

# 之后两个无先后依赖
pnpm publish:panel
pnpm publish:ctl
```

每条命令会自动：先构建该包（panel 含 vue-tsc + vite + tsc 三步）→ `pnpm publish`（自动把 `workspace:*` 依赖重写为实际版本号，`publishConfig.access: public` 已在包内声明）。

### 发布前自查

```bash
# 检查 tarball 内容是否完整（panel 应包含 bin/ dist-server/ dist-web/）
cd packages/panel && pnpm pack --dry-run

# 发布后验证 npx 体验
npx @chorus/panel start --help
npx @chorus/ctl --help
```

## 终端用户使用（发布后）

无需克隆仓库，`npx` 自动下载执行（包内含预编译产物，零构建）：

```bash
# Web 管理界面（默认 127.0.0.1:8088）
npx @chorus/panel start
npx @chorus/panel start -p 8088 --host 0.0.0.0

# 或全局安装
npm install -g @chorus/panel
chorus-panel start

# 命令行工具
npx @chorus/ctl health
npx @chorus/ctl deploy --json
```

两者可独立使用，也可共存（共享 `~/.singchorus/` 数据目录）。

## 一键部署云端同步（Cloudflare）

不需要 VPS 和 Docker，只想要云端配置同步？点击按钮即可把 `chorus-cloud` Worker 部署到你自己的 Cloudflare 账号（免费额度即可运行）：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aixmoyu/singchorus/tree/main/packages/cloud)

部署流程（约 2 分钟）：

1. 点击按钮并登录 Cloudflare（需 GitHub/GitLab 账号授权，仓库需为公开仓库）
2. Cloudflare 自动克隆 `packages/cloud` 到你的账号、创建并绑定 D1 数据库
3. 在设置页填入两个密钥（可用 `openssl rand -hex 32` 生成）：
   - `AUTH_TOKEN`：管理 API 的 Bearer Token
   - `JWT_SECRET`：JWT 签名密钥
4. 点击 Create & Deploy，完成后会得到 `https://chorus-cloud.<你的子域>.workers.dev`

验证：

```bash
curl https://chorus-cloud.<你的子域>.workers.dev/health
# 期望 {"status":"ok","service":"chorus-cloud"}
```

后续代码更新时，Cloudflare 会同步你账号中克隆出的仓库并自动重新构建部署。更多细节（自定义域名、CI/CD、速率限制）见 `packages/cloud/docs/deploy.md`。

### CLI 部署（可选）

不想用部署按钮，也可以用 wrangler CLI 从源码部署（需 Node.js >= 18、pnpm 和 Cloudflare 账号，在 `packages/cloud` 目录下执行）：

```bash
cd packages/cloud
pnpm install
npx wrangler login
pnpm setup:prod   # 首次部署：自动创建 D1、应用迁移、部署 Worker、设置 secrets、seed 模板
pnpm deploy:prod  # 日常发版：应用新迁移并重新部署
```

- `pnpm setup:prod` 幂等，可重复执行；密钥默认随机生成并写入 `.prod.vars`，也可通过环境变量指定：
  `AUTH_TOKEN=$(openssl rand -hex 32) JWT_SECRET=$(openssl rand -hex 32) pnpm setup:prod`
- 也可用 GitHub Actions 自动部署（`CLOUDFLARE_API_TOKEN` + `pnpm setup:prod`），详见 `packages/cloud/docs/deploy.md` §5

## 目录结构

```
packages/
  core/    # 引擎：配置存储、云同步、Docker 部署（零运行时依赖）
  panel/   # Web 管理面板：Vue 3 SPA + Express API
  ctl/     # CLI 工具：chorusctl
  cloud/   # Cloudflare Worker：云端配置同步（部署用 wrangler，见 packages/cloud/docs/）
```

## 相关文档

- Panel 设计：`packages/panel/DESIGN.md`
- Cloud 部署：`packages/cloud/docs/deploy.md`
- Cloud 自托管（VPS/Node）：`packages/cloud/docs/deploy-vps.md`

## License

[MIT](LICENSE)
