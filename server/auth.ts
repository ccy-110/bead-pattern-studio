import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'

import type { Ctx } from './context'
import type { Db } from './db'
import { deleteExpiredSessions } from './db'
import { HttpError, badRequest, clearCookie, sendEmpty, sendJson, serializeCookie } from './http'

/**
 * 账号与会话。
 *
 * 几个不能省的细节：
 * - 密码用 **scrypt**（内存硬），每个用户独立随机盐，比对用 `timingSafeEqual`
 * - 会话表里只存 **token 的 sha256**：库被拖走也不等于会话被接管
 * - 登录失败只说"邮箱或密码不正确"，不暴露邮箱是否存在；邮箱不存在时也跑一次
 *   scrypt，避免用响应时间探测已注册邮箱
 */

export const SESSION_COOKIE = 'sid'

const KEY_LEN = 64
const DEFAULT_N = 16384
const R = 8
const P = 1
const MAX_MEM = 64 * 1024 * 1024

/** 测试里可以调低，生产保持默认 */
export interface ScryptCost {
  N: number
  r: number
  p: number
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  cost: ScryptCost,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N: cost.N, r: cost.r, p: cost.p, maxmem: MAX_MEM },
      (err, key) => {
        if (err) reject(err)
        else resolve(key)
      },
    )
  })
}

function b64(buf: Buffer): string {
  return buf.toString('base64url')
}

/** 存储格式：`scrypt$N$r$p$salt$hash`。参数随密码一起存，将来调强度也能验证旧密码。 */
export async function hashPassword(
  password: string,
  cost: ScryptCost = { N: DEFAULT_N, r: R, p: P },
): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, KEY_LEN, cost)
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${b64(salt)}$${b64(key)}`
}

/** 固定盐 + 全零哈希：邮箱不存在时用它跑一次，保证耗时与真实校验接近 */
const DUMMY_SALT = Buffer.alloc(16)
const DUMMY_HASH = Buffer.alloc(KEY_LEN)

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (stored === null) {
    await scryptAsync(password, DUMMY_SALT, KEY_LEN, { N: DEFAULT_N, r: R, p: P })
    return false
  }

  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4]!, 'base64url')
    expected = Buffer.from(parts[5]!, 'base64url')
  } catch {
    return false
  }

  const actual = await scryptAsync(password, salt, expected.length || KEY_LEN, { N: n, r, p })
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/** 会话表存的是 token 的哈希，不是 token 本身 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSession(
  db: Db,
  userId: string,
  ttlMs: number,
): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + ttlMs
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), userId, expiresAt, now)
  return { token, expiresAt }
}

export function findSession(db: Db, token: string): { userId: string } | null {
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(hashToken(token)) as { user_id?: string; expires_at?: number } | undefined
  if (!row || typeof row.user_id !== 'string' || typeof row.expires_at !== 'number') return null
  if (row.expires_at <= Date.now()) return null
  return { userId: row.user_id }
}

export function destroySession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
export const PASSWORD_MIN = 8
const PASSWORD_MAX = 200
const EMAIL_MAX = 254

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('请填写邮箱')
  const email = value.trim().toLowerCase()
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw badRequest('邮箱格式不正确')
  return email
}

export function normalizePassword(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('请填写密码')
  if (value.length < PASSWORD_MIN) throw badRequest(`密码至少 ${PASSWORD_MIN} 位`)
  if (value.length > PASSWORD_MAX) throw badRequest('密码过长')
  return value
}

// ---------------------------------------------------------------------------
// 简单的内存限流
// ---------------------------------------------------------------------------

interface Bucket {
  count: number
  resetAt: number
}

/**
 * 按 key 计数的窗口限流。
 *
 * 只用于登录/注册这种低频接口 —— 放在进程内存里就够，重启丢计数也无所谓。
 * 超过条目上限时顺手清理过期项，避免被大量不同 IP 撑爆内存。
 */
export function createRateLimiter(maxEntries = 10_000) {
  const buckets = new Map<string, Bucket>()

  return function hit(key: string, limit: number, windowMs: number): void {
    const now = Date.now()
    const bucket = buckets.get(key)

    if (bucket === undefined || bucket.resetAt <= now) {
      if (buckets.size >= maxEntries) {
        for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return
    }

    bucket.count++
    if (bucket.count > limit) throw new HttpError(429, '尝试过于频繁，请稍后再试')
  }
}

// ---------------------------------------------------------------------------
// 路由处理器
// ---------------------------------------------------------------------------

export interface AuthDeps {
  db: Db
  config: { sessionTtlDays: number; cookieSecure: boolean }
  /** 测试里调低成本用 */
  cost?: ScryptCost
  /** 每个实例独立的限流器，测试之间互不影响 */
  limiter?: ReturnType<typeof createRateLimiter>
}

interface UserRow {
  id: string
  email: string
  password_hash: string
}

function publicUser(row: { id: string; email: string }) {
  return { id: row.id, email: row.email }
}

export function createAuthHandlers(deps: AuthDeps) {
  const limiter = deps.limiter ?? createRateLimiter()
  const ttlMs = deps.config.sessionTtlDays * 24 * 60 * 60 * 1000

  /** 建会话并把 Cookie 写进响应头 */
  function sessionCookie(ctx: Ctx, userId: string): string {
    const { token, expiresAt } = createSession(ctx.db, userId, ttlMs)
    return serializeCookie(SESSION_COOKIE, token, {
      maxAgeSeconds: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
      secure: deps.config.cookieSecure,
    })
  }

  return {
    async register(ctx: Ctx): Promise<void> {
      limiter(`register:${ctx.ip}`, 10, 10 * 60 * 1000)
      const body = (ctx.body ?? {}) as Record<string, unknown>
      const email = normalizeEmail(body.email)
      const password = normalizePassword(body.password)

      const hash = await hashPassword(password, deps.cost)
      const id = randomUUID()

      try {
        ctx.db
          .prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(id, email, hash, Date.now())
      } catch (err) {
        // 并发注册同一个邮箱时，靠唯一约束兜底
        if (String(err).includes('UNIQUE')) throw new HttpError(409, '这个邮箱已经注册过了')
        throw err
      }

      sendJson(ctx.res, 201, { user: { id, email } }, { 'Set-Cookie': sessionCookie(ctx, id) })
      deleteExpiredSessions(ctx.db, Date.now())
    },

    async login(ctx: Ctx): Promise<void> {
      limiter(`login:${ctx.ip}`, 30, 10 * 60 * 1000)
      const body = (ctx.body ?? {}) as Record<string, unknown>
      const email = normalizeEmail(body.email)
      const password = normalizePassword(body.password)

      const row = ctx.db
        .prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
        .get(email) as UserRow | undefined

      const ok = await verifyPassword(password, row?.password_hash ?? null)
      // 不区分"邮箱不存在"和"密码错"，避免被用来枚举已注册邮箱
      if (!ok || row === undefined) throw new HttpError(401, '邮箱或密码不正确')

      sendJson(
        ctx.res,
        200,
        { user: publicUser(row) },
        { 'Set-Cookie': sessionCookie(ctx, row.id) },
      )
      deleteExpiredSessions(ctx.db, Date.now())
    },

    logout(ctx: Ctx): void {
      if (ctx.sessionToken !== null) destroySession(ctx.db, ctx.sessionToken)
      // 顺手把浏览器上的 Cookie 也清掉，别留一个指向已删会话的垃圾值
      ctx.res.writeHead(204, {
        'Set-Cookie': clearCookie(SESSION_COOKIE, deps.config.cookieSecure),
        'Cache-Control': 'no-store',
      })
      ctx.res.end()
    },

    me(ctx: Ctx): void {
      if (ctx.user === null) throw new HttpError(401, '请先登录')
      sendJson(ctx.res, 200, { user: ctx.user })
    },

    async changePassword(ctx: Ctx): Promise<void> {
      if (ctx.user === null) throw new HttpError(401, '请先登录')
      limiter(`password:${ctx.ip}`, 10, 10 * 60 * 1000)

      const body = (ctx.body ?? {}) as Record<string, unknown>
      const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : ''
      const newPassword = normalizePassword(body.newPassword)

      const row = ctx.db
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(ctx.user.id) as { password_hash: string } | undefined

      const ok = await verifyPassword(oldPassword, row?.password_hash ?? null)
      if (!ok) throw new HttpError(401, '原密码不正确')

      const hash = await hashPassword(newPassword, deps.cost)
      ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, ctx.user.id)

      // 把该用户的所有会话作废（可能在其他设备上登录着），
      // 然后给当前这台设备换一个新会话，否则用户改完密码就被自己踢下线了
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(ctx.user.id)
      ctx.res.writeHead(204, {
        'Set-Cookie': sessionCookie(ctx, ctx.user.id),
        'Cache-Control': 'no-store',
      })
      ctx.res.end()
    },

    /** 路由层用：把 Cookie 里的 token 解析成用户 */
    resolveToken(ctx: Ctx, token: string): void {
      const session = findSession(ctx.db, token)
      if (session === null) return
      const row = ctx.db
        .prepare('SELECT id, email FROM users WHERE id = ?')
        .get(session.userId) as { id: string; email: string } | undefined
      if (row === undefined) return
      ctx.user = publicUser(row)
      ctx.sessionToken = token
    },

    clearSessionCookie(): string {
      return clearCookie(SESSION_COOKIE, deps.config.cookieSecure)
    },
  }
}
