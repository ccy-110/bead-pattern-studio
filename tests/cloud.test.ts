// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toPatternColor } from '../src/core/pattern/types'
import type { Pattern } from '../src/core/pattern/types'
import { cloud, init, saveCurrent } from '../src/stores/cloud'
import { pattern } from '../src/stores/project'

/**
 * 云端 store 的行为约束。
 *
 * 最要紧的一条：**后端不可用不能影响主功能**。所以这里重点验证
 * 「后端没开」「未登录」这两种情况都被稳稳接住，而不是把异常抛给界面。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function samplePattern(): Pattern {
  return {
    title: '云端测试',
    beadSizeMm: 5,
    rows: 2,
    cols: 2,
    colors: [toPatternColor({ id: 't.T1', code: 'T1', name: 'T1', hex: '#ff0000', rgb: [255, 0, 0], kind: 'solid' })],
    grid: Int16Array.from([0, 0, 0, 0]),
  }
}

beforeEach(() => {
  cloud.user = null
  cloud.status = 'idle'
  cloud.patterns = []
  cloud.error = null
  cloud.notice = null
  cloud.busy = false
  pattern.value = null
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('启动初始化', () => {
  it('未登录时安静地停在未登录状态，不报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '请先登录' }, 401)))

    await init()

    expect(cloud.user).toBeNull()
    expect(cloud.status).toBe('ready')
    expect(cloud.error).toBeNull()
  })

  it('后端没启动时标记为离线，而不是抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    await expect(init()).resolves.toBeUndefined()
    expect(cloud.status).toBe('offline')
    expect(cloud.user).toBeNull()
  })

  it('已登录时加载图纸列表', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ user: { id: 'u1', email: 'me@example.com' } })
      if (url.endsWith('/patterns')) {
        return jsonResponse({
          patterns: [
            { id: 'p1', title: '我的猫', rows: 10, cols: 10, thumbnail: null, shared: false, updatedAt: 1 },
          ],
        })
      }
      return jsonResponse({ error: 'not found' }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    await init()

    expect(cloud.user?.email).toBe('me@example.com')
    expect(cloud.status).toBe('ready')
    expect(cloud.patterns).toHaveLength(1)
    expect(cloud.patterns[0]!.title).toBe('我的猫')
  })
})

describe('分享链接', () => {
  it('打开 ?share= 时把图纸载入编辑器，并清掉地址栏参数', async () => {
    const file = {
      format: 'beadpattern',
      version: 1,
      createdAt: new Date(0).toISOString(),
      title: '别人分享的图纸',
      beadSizeMm: 5,
      colors: [{ id: 't.T1', code: 'T1', name: 'T1', hex: '#ff0000', kind: 'solid' }],
      grid: [
        [0, 0],
        [0, 0],
      ],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/auth/me')) return jsonResponse({ error: '请先登录' }, 401)
        if (url.includes('/share/abc123')) return jsonResponse({ data: file, title: file.title })
        return jsonResponse({ error: 'not found' }, 404)
      }),
    )

    window.history.replaceState(null, '', '/?share=abc123')
    await init()

    expect(pattern.value?.title).toBe('别人分享的图纸')
    expect(cloud.notice).toContain('分享')
    // 刷新页面时不该再拉一次
    expect(window.location.search).toBe('')
  })

  it('分享链接失效时给出错误，但不影响当前图纸', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/auth/me')) return jsonResponse({ error: '请先登录' }, 401)
        return jsonResponse({ error: '分享链接不存在或已失效' }, 404)
      }),
    )

    window.history.replaceState(null, '', '/?share=gone')
    await init()

    expect(cloud.error).toContain('失效')
    expect(pattern.value).toBeNull()
  })
})

describe('保存', () => {
  it('未登录时保存是空操作，不会发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    pattern.value = samplePattern()

    expect(await saveCurrent()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('登录后保存会 POST 工程文件并刷新列表', async () => {
    cloud.user = { id: 'u1', email: 'me@example.com' }
    pattern.value = samplePattern()

    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
        if (url.endsWith('/patterns') && init?.method === 'POST') return jsonResponse({ id: 'new-id' }, 201)
        if (url.endsWith('/patterns')) return jsonResponse({ patterns: [] })
        return jsonResponse({ error: 'not found' }, 404)
      }),
    )

    expect(await saveCurrent()).toBe('new-id')

    const post = calls.find((c) => c.body !== undefined)
    expect(post).toBeDefined()
    // 发出去的是完整的工程文件（自包含、带格式版本号）
    const payload = JSON.parse(post!.body!) as { data: string }
    const file = JSON.parse(payload.data) as { format: string; title: string }
    expect(file.format).toBe('beadpattern')
    expect(file.title).toBe('云端测试')
  })
})
