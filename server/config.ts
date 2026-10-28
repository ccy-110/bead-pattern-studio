import { resolve } from 'node:path'

/**
 * 服务端配置。全部走环境变量，默认值适配**本机开发**。
 *
 * 以后买服务器时不需要改代码，只改环境变量：
 * `PORT` / `DB_PATH` / `COOKIE_SECURE=1` / `ALLOWED_ORIGIN` / `TRUST_PROXY=1`。
 */
export interface ServerConfig {
  port: number
  dbPath: string
  /** 生产环境走 HTTPS 时必须打开，否则 Cookie 会被浏览器拒绝 */
  cookieSecure: boolean
  /** 允许发起写操作的前端源；开发时是 Vite 的两个地址 */
  allowedOrigins: string[]
  sessionTtlDays: number
  /**
   * 是否信任 `X-Forwarded-For`。
   *
   * 只有放在反向代理后面时才该打开 —— 否则任何客户端都能伪造这个头，
   * 按 IP 限流就成了摆设。
   */
  trustProxy: boolean
}

function bool(v: string | undefined): boolean {
  return v === '1' || v === 'true'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8787)
  const ttl = Number(env.SESSION_TTL_DAYS ?? 30)

  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787,
    dbPath: resolve(env.DB_PATH ?? 'data/app.db'),
    cookieSecure: bool(env.COOKIE_SECURE),
    allowedOrigins: (env.ALLOWED_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sessionTtlDays: Number.isFinite(ttl) && ttl > 0 ? ttl : 30,
    trustProxy: bool(env.TRUST_PROXY),
  }
}
