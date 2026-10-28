/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 相对路径，保证 dist 可以直接丢到任意静态托管的子目录下运行
  base: './',
  plugins: [vue()],
  server: {
    // 默认只绑 localhost 解析到的那个地址，于是常见的一幕是：
    // localhost:5173 能开，127.0.0.1:5173 连接被拒，取决于浏览器先试哪个。
    // 绑到所有网卡就没有这个歧义了，顺带能用手机连同一个 Wi-Fi 打开看图纸。
    host: true,
    port: 5173,
    // 端口被占用时直接报错，而不是悄悄换到 5174 ——
    // 悄悄换端口会让人对着一个已经不存在的地址反复刷新
    strictPort: true,
    // 开发时把 /api 转发给本机后端，前后端同源，不用处理 CORS
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787' },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
