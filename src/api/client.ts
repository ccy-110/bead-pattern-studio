/**
 * 后端 API 客户端。
 *
 * 同源 + Cookie 会话：开发时 Vite 把 `/api` 代理到本机的 8787 端口，
 * 生产环境由反向代理分发，所以前端不需要处理 CORS，也不需要把 token 存在
 * localStorage 里（那正是 XSS 最想偷的东西）。
 */

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiRequest {
  method?: string
  body?: unknown
}

/** 把后端返回的 `{error}` 或网络错误统一成一句能显示给用户的话 */
export async function apiFetch<T>(path: string, init: ApiRequest = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch {
    // 后端没启动是本机开发最常见的情况，给一句能直接照做的提示
    throw new ApiError(0, '连不上服务器。请确认后端已经启动（npm run server）')
  }

  if (res.status === 204) return undefined as T

  let payload: unknown = null
  const text = await res.text()
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!res.ok) {
    const message =
      payload !== null && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（HTTP ${res.status}）`
    throw new ApiError(res.status, message)
  }

  return payload as T
}
