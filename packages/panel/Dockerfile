# chorus-panel 自托管镜像。
# 构建上下文是仓库根目录：
#   docker build -f packages/panel/Dockerfile -t chorus-panel .
# 或直接用 compose：cd packages/panel && docker compose up -d --build
#
# 运行时只装 docker CLI（compose 插件），不跑 dockerd：panel 通过挂载的
# 宿主 /var/run/docker.sock 驱动 sing-box（DooD），compose 文件里的相对卷
# 路径由 CLI 在容器侧转成绝对路径后交给宿主 daemon 解析——因此 compose 里
# 必须保证容器内 $HOME/.singchorus 与宿主路径一致（见 docker-compose.yml）。
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@11.5.0

# 先拷贝 workspace 清单，依赖层可被 Docker 缓存
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/panel/package.json packages/panel/
COPY packages/ctl/package.json packages/ctl/
COPY packages/cloud/package.json packages/cloud/
RUN pnpm install --frozen-lockfile --filter @chorus/panel...

COPY packages/core packages/core
COPY packages/panel packages/panel
# core 先行：panel 引用的是 core 的 dist 产物
RUN pnpm --filter @chorus/core build \
 && pnpm --filter @chorus/panel build

# 裁剪到生产依赖：清空后按 @chorus/panel 闭包重装（pnpm store 在同一构建
# 容器内，硬链重装几乎无成本）。core 无运行时依赖，node_modules 可能不生成，
# mkdir 兜底保证下游 COPY 不失败。
RUN rm -rf node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter @chorus/panel... \
 && mkdir -p packages/core/node_modules

FROM node:22-alpine
# docker CLI + compose 插件（只需客户端，守护进程在宿主）
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
ENV NODE_ENV=production \
    CHORUS_PANEL_HOST=0.0.0.0 \
    CHORUS_PANEL_PORT=8088

# 保持与构建期一致的目录布局：pnpm 的 node_modules 全是相对符号链接，
# 原样拷贝即可保持 panel → core → .pnpm 的解析链完整。
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/panel/package.json ./packages/panel/package.json
COPY --from=build /app/packages/panel/bin ./packages/panel/bin
COPY --from=build /app/packages/panel/dist-server ./packages/panel/dist-server
COPY --from=build /app/packages/panel/dist-web ./packages/panel/dist-web
COPY --from=build /app/packages/panel/node_modules ./packages/panel/node_modules

EXPOSE 8088
# alpine 自带 busybox wget；首页无需鉴权，200 即存活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8088/ || exit 1
CMD ["node", "packages/panel/dist-server/index.js"]
