import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => {
  // 读取 .env.local / 环境变量（VITE_ALLOWED_HOSTS，逗号分隔的域名白名单）
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      allowedHosts: env.VITE_ALLOWED_HOSTS
        ? env.VITE_ALLOWED_HOSTS.split(',')
            .map((h) => h.trim())
            .filter(Boolean)
        : [],
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8088',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist-web',
      emptyOutDir: true,
      sourcemap: false,
    },
  }
})
