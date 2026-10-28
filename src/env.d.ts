/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 后端 API 的基地址。
   *
   * 默认 `/api`：开发时由 Vite 代理到本机 8787，生产环境由反向代理分发。
   * 前后端分开部署时可以设成完整 URL（例如 `https://api.example.com`），
   * 那种情况下需要后端也允许跨源。
   */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
