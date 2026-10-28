import { createServer } from 'node:http'
import { createApp } from './app'
import { loadConfig } from './config'
import { deleteExpiredSessions, openDb } from './db'

/**
 * 后端入口。默认监听 8787，Vite 把 `/api` 代理到这里。
 *
 * 只服务 JSON 接口，不托管静态文件 —— 前端仍然是纯静态站点，
 * 生产环境里由反向代理分别处理 `/` 与 `/api`。
 */
const config = loadConfig()
const db = openDb(config.dbPath)

const removed = deleteExpiredSessions(db)
if (removed > 0) console.log(`[server] 清理了 ${removed} 个过期会话`)

const server = createServer(createApp(config, db))

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // 常见于重复双击启动脚本。给一句能照做的提示，而不是一段堆栈
    console.error(`[server] 端口 ${config.port} 已被占用 —— 后端可能已经在运行了。`)
    console.error('[server] 要重启的话，先关掉那个后端窗口，或在任务管理器里结束 node 进程。')
    process.exit(1)
  }
  console.error('[server] 启动失败', err)
  process.exit(1)
})

server.listen(config.port, () => {
  console.log(`[server] 已启动: http://localhost:${config.port}/api/health`)
  console.log(`[server] 数据库: ${config.dbPath}`)
  if (!config.cookieSecure) {
    console.log('[server] 提示: 当前 Cookie 未加 Secure（本机开发正常，上线前设 COOKIE_SECURE=1）')
  }
})

function shutdown(signal: string): void {
  console.log(`\n[server] 收到 ${signal}，正在关闭…`)
  server.close(() => {
    db.close()
    process.exit(0)
  })
  // 兜底：十秒内还没关干净就强制退出
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
