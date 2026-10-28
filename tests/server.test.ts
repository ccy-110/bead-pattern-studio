import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { loadConfig } from '../server/config'
import type { ServerConfig } from '../server/config'
import { openDb } from '../server/db'
import type { Db } from '../server/db'

/**
 * 后端接口测试。
 *
 * 每个用例起一个真实的 HTTP 服务（随机端口）+ 一个内存数据库，
 * 用 fetch 走完整的真实链路 —— 不 mock 请求对象，因为要验证的恰恰是
 * 鉴权、Cookie、状态码这些"框架外面"的行为。
 *
 * 密码哈希的强度在测试里调低（scrypt N=1024），生产仍用 16384。
 */

let db: Db
let server: Server
let base: string

/** 一份最小的合法图纸文件 */
function sampleFile(title = '测试图纸') {
  return {
    format: 'beadpattern',
    version: 1,
    createdAt: new Date(0).toISOString(),
    title,
    beadSizeMm: 5,
    colors: [{ id: 't.T1', code: 'T1', name: 'T1', hex: '#ff0000', kind: 'solid' }],
    grid: [
      [0, 0, 0],
      [0, 0, 0],
    ],
  }
}

interface Reply {
  status: number
  body: Record<string, unknown>
  headers: Headers
}

/** 每个客户端自带 Cookie 罐，模拟一个浏览器 */
function makeClient() {
  let cookie = ''

  return async function call(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    // 默认发 JSON，但允许用例显式覆盖（比如验证非 JSON 内容类型会被拒）
    if (init.body !== undefined && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (cookie !== '') headers['Cookie'] = cookie

    const res = await fetch(base + path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })

    const setCookie = res.headers.get('set-cookie')
    if (setCookie !== null) {
      const pair = setCookie.split(';')[0]!
      cookie = pair.endsWith('=') ? '' : pair
    }

    const text = await res.text()
    let body: Record<string, unknown> = {}
    try {
      body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    } catch {
      body = { raw: text }
    }
    return { status: res.status, body, headers: res.headers }
  }
}

async function startServer(config: ServerConfig, rateLimit: boolean): Promise<void> {
  server = createServer(createApp(config, db, { cost: { N: 1024, r: 8, p: 1 }, rateLimit }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  base = `http://127.0.0.1:${address.port}/api`
}

beforeEach(async () => {
  db = openDb(':memory:')
  const config = loadConfig({ ALLOWED_ORIGIN: 'http://localhost:5173' } as NodeJS.ProcessEnv)
  await startServer(config, false)
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
})

async function register(client: ReturnType<typeof makeClient>, email: string): Promise<void> {
  const res = await client('/auth/register', {
    body: { email, password: 'correct-horse-1' },
  })
  expect(res.status).toBe(201)
}

async function createPattern(client: ReturnType<typeof makeClient>, title?: string): Promise<string> {
  const res = await client('/patterns', { body: { data: sampleFile(title) } })
  expect(res.status).toBe(201)
  return String(res.body.id)
}

// ---------------------------------------------------------------------------

describe('账号', () => {
  it('注册成功后直接是登录状态', async () => {
    const call = makeClient()
    const res = await call('/auth/register', {
      body: { email: 'a@example.com', password: 'correct-horse-1' },
    })

    expect(res.status).toBe(201)
    expect((res.body.user as { email: string }).email).toBe('a@example.com')
    const cookie = res.headers.get('set-cookie') ?? ''
    // 会话 Cookie 必须是 HttpOnly + SameSite，JS 读不到才挡得住 XSS 偷 token
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')

    const me = await call('/auth/me')
    expect(me.status).toBe(200)
    expect((me.body.user as { email: string }).email).toBe('a@example.com')
  })

  it('重复邮箱返回 409', async () => {
    const call = makeClient()
    await register(call, 'dup@example.com')
    const again = await call('/auth/register', {
      body: { email: 'DUP@example.com', password: 'correct-horse-1' },
    })
    // 大小写不敏感：DUP@ 和 dup@ 是同一个邮箱
    expect(again.status).toBe(409)
  })

  it('邮箱格式与密码长度会被校验', async () => {
    const call = makeClient()
    expect((await call('/auth/register', { body: { email: 'not-an-email', password: 'correct-horse-1' } })).status).toBe(400)
    expect((await call('/auth/register', { body: { email: 'b@example.com', password: 'short' } })).status).toBe(400)
    expect((await call('/auth/register', { body: {} })).status).toBe(400)
  })

  it('登录失败的信息不区分"邮箱不存在"和"密码错"', async () => {
    const call = makeClient()
    await register(call, 'c@example.com')

    const wrongPassword = await call('/auth/login', { body: { email: 'c@example.com', password: 'wrong-password' } })
    const noSuchUser = await call('/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-password' } })

    expect(wrongPassword.status).toBe(401)
    expect(noSuchUser.status).toBe(401)
    expect(wrongPassword.body.error).toBe(noSuchUser.body.error)
  })

  it('登出后会话立即失效', async () => {
    const call = makeClient()
    await register(call, 'd@example.com')
    expect((await call('/auth/me')).status).toBe(200)

    expect((await call('/auth/logout', { method: 'POST' })).status).toBe(204)
    expect((await call('/auth/me')).status).toBe(401)
  })

  it('改密码需要原密码，且会作废旧会话', async () => {
    const call = makeClient()
    await register(call, 'e@example.com')

    expect((await call('/auth/password', { body: { oldPassword: 'nope', newPassword: 'new-password-1' } })).status).toBe(401)

    const changed = await call('/auth/password', {
      body: { oldPassword: 'correct-horse-1', newPassword: 'new-password-1' },
    })
    expect(changed.status).toBe(204)
    // 当前设备换发了新会话，仍然是登录状态
    expect((await call('/auth/me')).status).toBe(200)

    const fresh = makeClient()
    expect((await fresh('/auth/login', { body: { email: 'e@example.com', password: 'correct-horse-1' } })).status).toBe(401)
    expect((await fresh('/auth/login', { body: { email: 'e@example.com', password: 'new-password-1' } })).status).toBe(200)
  })

  it('密码与会话在数据库里都不是明文', async () => {
    const call = makeClient()
    await register(call, 'f@example.com')

    const user = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('f@example.com') as {
      password_hash: string
    }
    expect(user.password_hash).not.toContain('correct-horse-1')
    expect(user.password_hash.startsWith('scrypt$')).toBe(true)

    const sessions = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]
    expect(sessions.length).toBe(1)
    // 存的是 sha256 十六进制，不是原始 token
    expect(sessions[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('鉴权与归属', () => {
  it('未登录访问图纸接口一律 401', async () => {
    const call = makeClient()
    expect((await call('/patterns')).status).toBe(401)
    expect((await call('/patterns', { body: { data: sampleFile() } })).status).toBe(401)
  })

  it('别人的图纸读到的是 404，不是 403 —— 不泄露存在性', async () => {
    const alice = makeClient()
    await register(alice, 'alice@example.com')
    const id = await createPattern(alice, '爱丽丝的图纸')

    const bob = makeClient()
    await register(bob, 'bob@example.com')

    expect((await bob(`/patterns/${id}`)).status).toBe(404)
    expect((await bob(`/patterns/${id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await bob(`/patterns/${id}`, { body: { data: sampleFile('篡改') }, method: 'PATCH' })).status).toBe(404)
    expect((await bob(`/patterns/${id}/share`, { method: 'POST' })).status).toBe(404)

    // 爱丽丝自己的还在
    expect((await alice(`/patterns/${id}`)).status).toBe(200)
  })

  it('列表只包含自己的图纸', async () => {
    const alice = makeClient()
    await register(alice, 'alice2@example.com')
    await createPattern(alice, 'A')

    const bob = makeClient()
    await register(bob, 'bob2@example.com')
    await createPattern(bob, 'B')

    const list = await alice('/patterns')
    const titles = (list.body.patterns as { title: string }[]).map((p) => p.title)
    expect(titles).toEqual(['A'])
  })
})

describe('图纸的增删改查', () => {
  it('创建后能列出、读回、更新、删除', async () => {
    const call = makeClient()
    await register(call, 'crud@example.com')

    const id = await createPattern(call, '原始标题')

    const list = await call('/patterns')
    const summaries = list.body.patterns as { id: string; title: string; rows: number; cols: number; shared: boolean }[]
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ id, title: '原始标题', rows: 2, cols: 3, shared: false })

    const one = await call(`/patterns/${id}`)
    expect((one.body.data as { grid: number[][] }).grid[0]).toEqual([0, 0, 0])

    const updated = await call(`/patterns/${id}`, {
      method: 'PATCH',
      body: { data: { ...sampleFile('改过的标题'), grid: [[0]] } },
    })
    expect(updated.status).toBe(204)

    const after = await call(`/patterns/${id}`)
    expect((after.body.data as { title: string }).title).toBe('改过的标题')
    expect((after.body.data as { grid: number[][] }).grid).toEqual([[0]])

    expect((await call(`/patterns/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await call(`/patterns/${id}`)).status).toBe(404)
  })

  it('列表不带完整网格 —— 免得几十张图纸一次传几 MB', async () => {
    const call = makeClient()
    await register(call, 'slim@example.com')
    await createPattern(call)

    const list = await call('/patterns')
    const first = (list.body.patterns as Record<string, unknown>[])[0]!
    expect(first).not.toHaveProperty('data')
  })

  it('非法输入被拒绝', async () => {
    const call = makeClient()
    await register(call, 'bad@example.com')

    expect((await call('/patterns', { body: {} })).status).toBe(400)
    expect((await call('/patterns', { body: { data: { format: 'nope' } } })).status).toBe(400)
    expect((await call('/patterns', { body: { data: { ...sampleFile(), grid: [[0], [0, 0]] } } })).status).toBe(400)
    expect((await call('/patterns', { body: { data: { ...sampleFile(), colors: [] } } })).status).toBe(400)
  })

  it('超出资源上限的图纸被拒绝（防止用内存打服务器）', async () => {
    const call = makeClient()
    await register(call, 'huge@example.com')

    // 400 行 × 400 列：超过 300 的边长上限
    const bigGrid = Array.from({ length: 400 }, () => Array.from({ length: 400 }, () => 0))
    const tooBig = await call('/patterns', {
      body: { data: { ...sampleFile(), grid: bigGrid } },
    })
    expect(tooBig.status).toBe(400)

    const longTitle = await call('/patterns', {
      body: { data: { ...sampleFile('x'.repeat(200)) } },
    })
    expect(longTitle.status).toBe(400)

    const badThumb = await call('/patterns', {
      body: { data: { ...sampleFile(), thumbnail: 'data:text/html;base64,PHNjcmlwdD4=' } },
    })
    expect(badThumb.status).toBe(400)
  })

  it('请求体过大返回 413', async () => {
    const call = makeClient()
    await register(call, 'large@example.com')

    const res = await call('/patterns', {
      body: { data: { ...sampleFile(), padding: 'x'.repeat(3 * 1024 * 1024) } },
    })
    expect(res.status).toBe(413)
  })

  it('写操作要求 JSON 内容类型', async () => {
    const call = makeClient()
    await register(call, 'ct@example.com')

    const res = await call('/patterns', {
      body: { data: sampleFile() },
      headers: { 'Content-Type': 'text/plain' },
    })
    expect(res.status).toBe(415)
  })
})

describe('分享', () => {
  it('创建分享后未登录也能打开，撤回后 404', async () => {
    const owner = makeClient()
    await register(owner, 'share@example.com')
    const id = await createPattern(owner, '分享的图纸')

    const created = await owner(`/patterns/${id}/share`, { method: 'POST' })
    expect(created.status).toBe(200)
    const slug = String(created.body.slug)

    // 不可猜：22 个 base64url 字符（16 字节）
    expect(slug).toMatch(/^[A-Za-z0-9_-]{20,24}$/)

    const anonymous = makeClient()
    const opened = await anonymous(`/share/${slug}`)
    expect(opened.status).toBe(200)
    expect((opened.body.data as { title: string }).title).toBe('分享的图纸')

    // 幂等：再点一次分享拿到同一个链接
    const again = await owner(`/patterns/${id}/share`, { method: 'POST' })
    expect(again.body.slug).toBe(slug)

    expect((await owner(`/patterns/${id}/share`, { method: 'DELETE' })).status).toBe(204)
    expect((await anonymous(`/share/${slug}`)).status).toBe(404)
  })

  it('分享链接猜不到：不存在的 slug 一律 404', async () => {
    const anonymous = makeClient()
    expect((await anonymous('/share/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404)
  })
})

describe('跨站与限流', () => {
  it('写操作带上不认识的 Origin 会被拒绝', async () => {
    const call = makeClient()
    await register(call, 'origin@example.com')

    const blocked = await call('/patterns', {
      body: { data: sampleFile() },
      headers: { Origin: 'http://evil.example' },
    })
    expect(blocked.status).toBe(403)

    const allowed = await call('/patterns', {
      body: { data: sampleFile() },
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(allowed.status).toBe(201)
  })

  it('登录接口有限流', async () => {
    // 换一个开了限流的实例
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const config = loadConfig({ ALLOWED_ORIGIN: 'http://localhost:5173' } as NodeJS.ProcessEnv)
    await startServer(config, true)

    const call = makeClient()
    let last = 0
    for (let i = 0; i < 35; i++) {
      const res = await call('/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-password' } })
      last = res.status
    }
    expect(last).toBe(429)
  })
})
