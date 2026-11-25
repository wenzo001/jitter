import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { AntdvNextResolver } from '@antdv-next/auto-import-resolver'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    vue(),
    Components({
      resolvers: [AntdvNextResolver()],
      dts: 'src/components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    // 不做手工分包：手动把 antdv-next / vue 拆成独立 chunk 会引入循环依赖，
    // 运行时直接报 "xxx is not a constructor"。交给打包器自动分块，
    // 产物体积一样（同样的模块、同样的字节），但不会踩循环依赖的坑。
  },
  server: {
    port: 5173,
    proxy: {
      // 开发时默认打到 3000（安装版）。
      // 想连开发实例（副本库）就设 JITTER_API_TARGET=http://127.0.0.1:3111，
      // 免得调试时把请求打到用户的正式库上。
      '/api': process.env.JITTER_API_TARGET || 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
