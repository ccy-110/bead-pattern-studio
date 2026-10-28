import { reactive } from 'vue'

import { ApiError, apiFetch } from '@/api/client'
import { makeProjectFile } from '@/core/export/project-file'
import { generationParams, loadPatternFile, pattern, state } from '@/stores/project'

/**
 * 云端账号与图纸。
 *
 * 设计约束：**后端挂了不能影响主功能**。所有网络失败都收进 `cloud.error`，
 * 本地保存、导出、编辑照旧。所以 init() 不抛错，调用方也不需要 try/catch。
 */

export interface CloudUser {
  id: string
  email: string
}

export interface CloudPattern {
  id: string
  title: string
  rows: number
  cols: number
  thumbnail: string | null
  shared: boolean
  updatedAt: number
}

export type CloudStatus = 'idle' | 'loading' | 'ready' | 'offline'

export const cloud = reactive({
  user: null as CloudUser | null,
  status: 'idle' as CloudStatus,
  patterns: [] as CloudPattern[],
  error: null as string | null,
  notice: null as string | null,
  busy: false,
})

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : '操作失败'
}

function clearMessages(): void {
  cloud.error = null
  cloud.notice = null
}

function fail(err: unknown): void {
  cloud.error = message(err)
}

/** 分享链接形如 `/?share=<slug>`：纯前端参数，静态托管也能用 */
function shareUrl(slug: string): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('share', slug)
  return url.toString()
}

export async function refreshPatterns(): Promise<void> {
  if (cloud.user === null) {
    cloud.patterns = []
    return
  }
  try {
    const res = await apiFetch<{ patterns: CloudPattern[] }>('/patterns')
    cloud.patterns = res.patterns
  } catch (err) {
    fail(err)
  }
}

/**
 * 启动时调一次：确认登录态，并处理 `?share=` 分享链接。
 *
 * 放在 `main.ts` 里调用，而不是组件挂载时 —— 组件测试会 mount 面板，
 * 不应该因此去连一个不存在的后端。
 */
export async function init(): Promise<void> {
  cloud.status = 'loading'
  try {
    const res = await apiFetch<{ user: CloudUser }>('/auth/me')
    cloud.user = res.user
    await refreshPatterns()
    cloud.status = 'ready'
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      cloud.user = null
      cloud.status = 'ready'
    } else {
      // 后端没启动是常态（比如只想用本地功能），不弹错误，只标记离线
      cloud.status = 'offline'
    }
  }

  const slug = new URLSearchParams(window.location.search).get('share')
  if (slug !== null && slug !== '') await openShared(slug)
}

/** 打开别人分享的图纸：载入编辑器，但不属于自己（需要另存才会进账号） */
export async function openShared(slug: string): Promise<void> {
  try {
    const res = await apiFetch<{ data: unknown }>(`/share/${encodeURIComponent(slug)}`)
    loadPatternFile(JSON.stringify(res.data))
    if (state.error !== null) {
      cloud.error = state.error
      return
    }
    cloud.notice = '已打开分享的图纸。它不在你的账号里，需要的话请保存一份。'
    // 去掉地址栏里的参数，刷新时不会重复拉取
    window.history.replaceState(null, '', window.location.pathname)
  } catch (err) {
    fail(err)
  }
}

export async function register(email: string, password: string): Promise<boolean> {
  clearMessages()
  cloud.busy = true
  try {
    const res = await apiFetch<{ user: CloudUser }>('/auth/register', {
      body: { email, password },
    })
    cloud.user = res.user
    cloud.status = 'ready'
    await refreshPatterns()
    cloud.notice = '注册成功'
    return true
  } catch (err) {
    fail(err)
    return false
  } finally {
    cloud.busy = false
  }
}

export async function login(email: string, password: string): Promise<boolean> {
  clearMessages()
  cloud.busy = true
  try {
    const res = await apiFetch<{ user: CloudUser }>('/auth/login', {
      body: { email, password },
    })
    cloud.user = res.user
    cloud.status = 'ready'
    await refreshPatterns()
    return true
  } catch (err) {
    fail(err)
    return false
  } finally {
    cloud.busy = false
  }
}

export async function logout(): Promise<void> {
  clearMessages()
  try {
    await apiFetch('/auth/logout', { method: 'POST' })
  } catch {
    // 即便请求失败，本地也按已退出处理：服务端的会话可以稍后自然过期
  }
  cloud.user = null
  cloud.patterns = []
}

/** 把当前图纸存到云端。返回新图纸的 id。 */
export async function saveCurrent(): Promise<string | null> {
  const p = pattern.value
  if (p === null || cloud.user === null) return null
  clearMessages()
  cloud.busy = true
  try {
    const { text } = makeProjectFile(p, generationParams())
    const res = await apiFetch<{ id: string }>('/patterns', { body: { data: text } })
    cloud.notice = '已保存到云端'
    await refreshPatterns()
    return res.id
  } catch (err) {
    fail(err)
    return null
  } finally {
    cloud.busy = false
  }
}

/** 从云端打开一张图纸。走与「打开工程文件」完全相同的载入路径。 */
export async function openPattern(id: string): Promise<void> {
  clearMessages()
  cloud.busy = true
  try {
    const res = await apiFetch<{ data: unknown }>(`/patterns/${encodeURIComponent(id)}`)
    loadPatternFile(JSON.stringify(res.data))
    if (state.error !== null) {
      cloud.error = state.error
      return
    }
    cloud.notice = '已从云端打开'
  } catch (err) {
    fail(err)
  } finally {
    cloud.busy = false
  }
}

export async function removePattern(id: string): Promise<void> {
  clearMessages()
  try {
    await apiFetch(`/patterns/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await refreshPatterns()
    cloud.notice = '已删除'
  } catch (err) {
    fail(err)
  }
}

/** 生成（或复用）分享链接，成功时返回完整 URL */
export async function sharePattern(id: string): Promise<string | null> {
  clearMessages()
  try {
    const res = await apiFetch<{ slug: string }>(
      `/patterns/${encodeURIComponent(id)}/share`,
      { method: 'POST' },
    )
    const url = shareUrl(res.slug)
    await refreshPatterns()
    try {
      await navigator.clipboard.writeText(url)
      cloud.notice = '分享链接已复制到剪贴板'
    } catch {
      // 非安全上下文里没有剪贴板权限：把链接显示出来让用户手动复制
      cloud.notice = `分享链接：${url}`
    }
    return url
  } catch (err) {
    fail(err)
    return null
  }
}

export async function unsharePattern(id: string): Promise<void> {
  clearMessages()
  try {
    await apiFetch(`/patterns/${encodeURIComponent(id)}/share`, { method: 'DELETE' })
    await refreshPatterns()
    cloud.notice = '已关闭分享，旧链接立即失效'
  } catch (err) {
    fail(err)
  }
}
