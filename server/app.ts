import type { IncomingMessage, ServerResponse } from 'node:http'

import { SESSION_COOKIE, createAuthHandlers, createRateLimiter } from './auth'
import type { ScryptCost } from './auth'
import type { ServerConfig } from './config'
import type { Ctx } from './context'
import type { Db } from './db'
import {
  HttpError,
  assertSameOrigin,
  clientIp,
  isMutating,
  parseCookies,
  readJson,
  sendJson,
} from './http'
import { LIMITS, createPatternHandlers } from './patterns'

/**
 * 手写的小路由。
 *
 * 只有十来条接口，用不着框架：一个方法 + 路径段的匹配就够了。
 * 代价是每个端点的错误处理得自己写全 —— 所以这里把「鉴权、body 解析、
 * 错误映射」统一放在分发层，处理器只管业务。
 */

interface Route {
  method: string
  /** 路径段；以 `:` 开头的段是参数 */
  path: string[]
  /** 是否需要登录 */
  auth: boolean
  /** 是否读取 JSON 请求体 */
  body?: boolean
  handler: (ctx: Ctx) => Promise<void> | void
}

export interface AppOptions {
  /** 测试里调低 scrypt 成本用 */
  cost?: ScryptCost
  /** 测试里传 false 关掉限流 */
  rateLimit?: boolean
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

export function createApp(
  config: ServerConfig,
  db: Db,
  options: AppOptions = {},
): RequestHandler {
  const limiter = createRateLimiter()
  const auth = createAuthHandlers({
    db,
    config,
    ...(options.cost ? { cost: options.cost } : {}),
    limiter: options.rateLimit === false ? () => {} : limiter,
  })
  const patterns = createPatternHandlers({ db })

  const routes: Route[] = [
    { method: 'GET', path: ['api', 'health'], auth: false, handler: (ctx) => sendJson(ctx.res, 200, { ok: true }) },

    { method: 'POST', path: ['api', 'auth', 'register'], auth: false, body: true, handler: auth.register },
    { method: 'POST', path: ['api', 'auth', 'login'], auth: false, body: true, handler: auth.login },
    { method: 'POST', path: ['api', 'auth', 'logout'], auth: false, handler: auth.logout },
    { method: 'GET', path: ['api', 'auth', 'me'], auth: true, handler: auth.me },
    { method: 'POST', path: ['api', 'auth', 'password'], auth: true, body: true, handler: auth.changePassword },

    { method: 'GET', path: ['api', 'patterns'], auth: true, handler: patterns.list },
    { method: 'POST', path: ['api', 'patterns'], auth: true, body: true, handler: patterns.create },
    { method: 'GET', path: ['api', 'patterns', ':id'], auth: true, handler: patterns.get },
    { method: 'PATCH', path: ['api', 'patterns', ':id'], auth: true, body: true, handler: patterns.update },
    { method: 'DELETE', path: ['api', 'patterns', ':id'], auth: true, handler: patterns.remove },

    { method: 'POST', path: ['api', 'patterns', ':id', 'share'], auth: true, handler: patterns.share },
    { method: 'DELETE', path: ['api', 'patterns', ':id', 'share'], auth: true, handler: patterns.unshare },

    // 分享链接是公开的：别人点开就能看，不需要注册
    { method: 'GET', path: ['api', 'share', ':slug'], auth: false, handler: patterns.getShared },
  ]

  function match(
    method: string,
    segments: string[],
  ): { route: Route; params: Record<string, string> } | null {
    for (const route of routes) {
      if (route.method !== method) continue
      if (route.path.length !== segments.length) continue

      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < route.path.length; i++) {
        const expected = route.path[i]!
        const actual = segments[i]!
        if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual)
        else if (expected !== actual) {
          ok = false
          break
        }
      }
      if (ok) return { route, params }
    }
    return null
  }

  return (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // 兜底：任何没被捕获的异常都不能让进程挂掉，也不能把堆栈漏给客户端
      console.error('[server] 未处理的请求错误', err)
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' })
      else res.end()
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal')
    const method = (req.method ?? 'GET').toUpperCase()

    if (!url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: '接口不存在' })
      return
    }

    const segments = url.pathname.split('/').filter(Boolean)
    const found = match(method, segments)
    if (found === null) {
      sendJson(res, 404, { error: '接口不存在' })
      return
    }

    const ctx: Ctx = {
      req,
      res,
      db,
      config,
      params: found.params,
      body: undefined,
      user: null,
      sessionToken: null,
      ip: clientIp(req, config.trustProxy),
    }

    try {
      // 写操作校验来源（配合 SameSite=Lax 挡 CSRF）
      if (isMutating(method)) assertSameOrigin(req, config.allowedOrigins)

      // 解析会话（公开接口也解析：登录了就能拿到 user，但目前用不上）
      const cookies = parseCookies(req.headers.cookie)
      const token = cookies[SESSION_COOKIE]
      if (token !== undefined) auth.resolveToken(ctx, token)

      if (found.route.auth && ctx.user === null) {
        throw new HttpError(401, '请先登录')
      }

      if (found.route.body === true) {
        ctx.body = await readJson(req, LIMITS.bodyBytes)
      }

      await found.route.handler(ctx)
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message })
        return
      }
      console.error('[server] 请求处理失败', err)
      sendJson(res, 500, { error: '服务器内部错误' })
    }
  }
}
