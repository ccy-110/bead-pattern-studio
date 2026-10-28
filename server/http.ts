import type { IncomingMessage, ServerResponse } from 'node:http'

/** 可以直接抛出的、带 HTTP 状态码的错误。响应体只会包含 message。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 业务错误信息的统一出口，避免把内部实现细节暴露给客户端 */
export function badRequest(message: string): HttpError {
  return new HttpError(400, message)
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isMutating(method: string | undefined): boolean {
  return method !== undefined && MUTATING.has(method)
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string | string[]> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // API 响应一律不缓存：里面可能有别人的分享内容与登录态
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(payload)
}

export function sendEmpty(res: ServerResponse, status = 204): void {
  res.writeHead(status, { 'Cache-Control': 'no-store' })
  res.end()
}

/**
 * 读取请求体并强制大小上限。
 *
 * 先看 Content-Length 只是省流量的优化 —— 它可以是假的，所以循环里要再数一次。
 * 没有上限的话，一个几 GB 的 JSON 就能把内存打满。
 */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, '请求体过大')
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > limit) throw new HttpError(413, '请求体过大')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** 读并解析 JSON 请求体。写操作强制要求 `application/json`，顺带挡掉表单型 CSRF。 */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '')
  if (!type.toLowerCase().includes('application/json')) {
    throw new HttpError(415, '请求体必须是 JSON')
  }

  const body = await readBody(req, limit)
  if (body.length === 0) throw badRequest('请求体为空')
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw badRequest('请求体不是合法的 JSON')
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    const name = part.slice(0, i).trim()
    if (name === '') continue
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      // 非法转义的 Cookie 直接忽略，不要让整个请求 500
    }
  }
  return out
}

/**
 * 拼 Set-Cookie。
 *
 * `HttpOnly` 让 JS 读不到（防 XSS 偷 token），`SameSite=Lax` 挡住跨站 POST（防 CSRF），
 * 生产环境加 `Secure` 只走 HTTPS。
 */
export function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(options.maxAgeSeconds)}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure })
}

/**
 * 写操作的来源校验。
 *
 * 浏览器的跨站表单请求会带上 `Origin`；它不在白名单里就拒绝。
 * 非浏览器客户端可以不带 `Origin` —— 但它同样得先有会话 Cookie 才能改数据。
 */
export function assertSameOrigin(
  req: IncomingMessage,
  allowedOrigins: readonly string[],
): void {
  const origin = req.headers.origin
  if (origin === undefined) return
  if (!allowedOrigins.includes(origin)) {
    throw new HttpError(403, '来源不被允许')
  }
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}
