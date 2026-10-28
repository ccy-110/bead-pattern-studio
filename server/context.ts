import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerConfig } from './config'
import type { Db } from './db'

export interface AuthUser {
  id: string
  email: string
}

/** 一次请求的上下文。路由处理器只依赖这个结构，方便单独测试。 */
export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  db: Db
  config: ServerConfig
  /** 路径参数，例如 `/api/patterns/:id` 里的 id */
  params: Record<string, string>
  /** 已解析的 JSON 请求体（仅写操作有） */
  body: unknown
  /** 当前登录用户；未登录为 null */
  user: AuthUser | null
  /** 本次请求携带的会话 token（登出时用它精确删除这一个会话） */
  sessionToken: string | null
  ip: string
}
