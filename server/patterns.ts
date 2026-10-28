import { randomBytes, randomUUID } from 'node:crypto'

import { parsePatternFile } from '../src/core/pattern/serialize'
import type { Ctx } from './context'
import type { Db } from './db'
import { HttpError, badRequest, sendEmpty, sendJson } from './http'

/**
 * 图纸的增删改查与分享。
 *
 * 校验分两步，顺序不能反：
 *
 * 1. **先看资源上限**。`parsePatternFile` 是按客户端给的行列分配 `Int16Array` 的，
 *    没有任何上限 —— 先解析再检查就等于让人随便打内存。
 * 2. 再交给 `parsePatternFile` 做结构校验（它就是前端打开文件时用的那套，
 *    两边行为完全一致）。
 *
 * 所有元数据（标题、行列、豆径）**一律取自解析结果**，不信客户端单独传的字段。
 */

export const LIMITS = {
  bodyBytes: 2 * 1024 * 1024,
  rows: 300,
  cols: 300,
  cells: 90_000,
  colors: 300,
  titleChars: 120,
  thumbnailChars: 512 * 1024,
  patternsPerUser: 200,
} as const

interface PatternRow {
  id: string
  title: string
  rows: number
  cols: number
  palette_id: string | null
  bead_size_mm: number
  data: string
  thumbnail: string | null
  share_slug: string | null
  created_at: number
  updated_at: number
}

interface PatternSummary {
  id: string
  title: string
  rows: number
  cols: number
  paletteId: string | null
  beadSizeMm: number
  thumbnail: string | null
  shared: boolean
  createdAt: number
  updatedAt: number
}

function requireUser(ctx: Ctx): { id: string; email: string } {
  if (ctx.user === null) throw new HttpError(401, '请先登录')
  return ctx.user
}

function toSummary(row: Omit<PatternRow, 'data'>): PatternSummary {
  return {
    id: row.id,
    title: row.title,
    rows: row.rows,
    cols: row.cols,
    paletteId: row.palette_id,
    beadSizeMm: row.bead_size_mm,
    thumbnail: row.thumbnail,
    shared: row.share_slug !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 在分配任何内存之前先卡上限 */
function checkFileShape(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('图纸数据格式不正确')
  }
  const file = raw as Record<string, unknown>

  if (file.format !== 'beadpattern') throw badRequest('不是拼豆图纸文件')

  const grid = file.grid
  if (!Array.isArray(grid) || grid.length === 0) throw badRequest('图纸网格为空')
  if (grid.length > LIMITS.rows) throw badRequest(`图纸行数超过上限（${LIMITS.rows}）`)

  let cols = -1
  for (const row of grid) {
    if (!Array.isArray(row)) throw badRequest('图纸网格格式不正确')
    if (cols === -1) cols = row.length
    if (row.length !== cols) throw badRequest('图纸每行的列数不一致')
    if (row.length > LIMITS.cols) throw badRequest(`图纸列数超过上限（${LIMITS.cols}）`)
  }
  if (grid.length * cols > LIMITS.cells) {
    throw badRequest(`图纸总格数超过上限（${LIMITS.cells}）`)
  }

  const colors = file.colors
  if (!Array.isArray(colors) || colors.length === 0) throw badRequest('图纸没有颜色')
  if (colors.length > LIMITS.colors) throw badRequest(`颜色数量超过上限（${LIMITS.colors}）`)

  if (typeof file.title === 'string' && file.title.length > LIMITS.titleChars) {
    throw badRequest(`标题不能超过 ${LIMITS.titleChars} 个字符`)
  }

  if (file.thumbnail !== undefined && file.thumbnail !== null) {
    const thumb = file.thumbnail
    if (typeof thumb !== 'string' || !thumb.startsWith('data:image/png;base64,')) {
      throw badRequest('缩略图必须是 PNG data URL')
    }
    if (thumb.length > LIMITS.thumbnailChars) throw badRequest('缩略图过大')
  }
}

export interface ParsedUpload {
  /** 原样存储的 JSON 文本 */
  text: string
  /** 规范化后的模式（行列、标题都从这里取） */
  pattern: ReturnType<typeof parsePatternFile>['pattern']
  thumbnail: string | null
}

export function parseUpload(body: unknown): ParsedUpload {
  if (typeof body !== 'object' || body === null) throw badRequest('请求体格式不正确')
  const payload = body as Record<string, unknown>
  if (!('data' in payload)) throw badRequest('缺少 data 字段')

  const text =
    typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data)
  if (typeof text !== 'string' || text.length === 0) throw badRequest('缺少 data 字段')

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw badRequest('图纸数据不是合法的 JSON')
  }

  // 先卡上限，再做会分配内存的结构校验
  checkFileShape(raw)

  let parsed: ReturnType<typeof parsePatternFile>
  try {
    parsed = parsePatternFile(text)
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : '图纸数据无效')
  }

  const thumb = parsed.thumbnail
  return {
    text,
    pattern: parsed.pattern,
    thumbnail: typeof thumb === 'string' ? thumb : null,
  }
}

/** 不可猜的分享串；碰撞概率极低，撞了就重试 */
function newShareSlug(): string {
  return randomBytes(16).toString('base64url')
}

export function createPatternHandlers(deps: { db: Db }) {
  const db = deps.db

  return {
    list(ctx: Ctx): void {
      const user = requireUser(ctx)
      const rows = db
        .prepare(
          `SELECT id, title, rows, cols, palette_id, bead_size_mm, thumbnail,
                  share_slug, created_at, updated_at
             FROM patterns WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`,
        )
        .all(user.id) as unknown as Omit<PatternRow, 'data'>[]
      sendJson(ctx.res, 200, { patterns: rows.map(toSummary) })
    },

    create(ctx: Ctx): void {
      const user = requireUser(ctx)
      const upload = parseUpload(ctx.body)

      const count = db
        .prepare('SELECT COUNT(*) AS n FROM patterns WHERE user_id = ?')
        .get(user.id) as { n?: number } | undefined
      if ((count?.n ?? 0) >= LIMITS.patternsPerUser) {
        throw new HttpError(409, `最多保存 ${LIMITS.patternsPerUser} 张图纸，请先删掉一些`)
      }

      const id = randomUUID()
      const now = Date.now()
      db.prepare(
        `INSERT INTO patterns
           (id, user_id, title, rows, cols, palette_id, bead_size_mm, data, thumbnail,
            share_slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        user.id,
        upload.pattern.title,
        upload.pattern.rows,
        upload.pattern.cols,
        null,
        upload.pattern.beadSizeMm,
        upload.text,
        upload.thumbnail,
        now,
        now,
      )

      sendJson(ctx.res, 201, { id })
    },

    get(ctx: Ctx): void {
      const user = requireUser(ctx)
      const row = db
        .prepare('SELECT data FROM patterns WHERE id = ? AND user_id = ?')
        .get(ctx.params.id!, user.id) as { data?: string } | undefined
      // 别人的图纸一律 404：不能让人靠状态码区分"不存在"和"不是你的"
      if (row?.data === undefined) throw new HttpError(404, '图纸不存在')
      sendJson(ctx.res, 200, { data: JSON.parse(row.data) })
    },

    update(ctx: Ctx): void {
      const user = requireUser(ctx)
      const upload = parseUpload(ctx.body)

      const exists = db
        .prepare('SELECT id FROM patterns WHERE id = ? AND user_id = ?')
        .get(ctx.params.id!, user.id)
      if (exists === undefined) throw new HttpError(404, '图纸不存在')

      db.prepare(
        `UPDATE patterns
            SET title = ?, rows = ?, cols = ?, bead_size_mm = ?, data = ?, thumbnail = ?,
                updated_at = ?
          WHERE id = ? AND user_id = ?`,
      ).run(
        upload.pattern.title,
        upload.pattern.rows,
        upload.pattern.cols,
        upload.pattern.beadSizeMm,
        upload.text,
        upload.thumbnail,
        Date.now(),
        ctx.params.id!,
        user.id,
      )
      sendEmpty(ctx.res, 204)
    },

    remove(ctx: Ctx): void {
      const user = requireUser(ctx)
      const result = db
        .prepare('DELETE FROM patterns WHERE id = ? AND user_id = ?')
        .run(ctx.params.id!, user.id)
      if (Number(result.changes) === 0) throw new HttpError(404, '图纸不存在')
      sendEmpty(ctx.res, 204)
    },

    share(ctx: Ctx): void {
      const user = requireUser(ctx)
      const row = db
        .prepare('SELECT share_slug FROM patterns WHERE id = ? AND user_id = ?')
        .get(ctx.params.id!, user.id) as { share_slug?: string | null } | undefined
      if (row === undefined) throw new HttpError(404, '图纸不存在')

      let slug = row.share_slug ?? null
      if (slug === null) {
        for (let attempt = 0; attempt < 5 && slug === null; attempt++) {
          const candidate = newShareSlug()
          try {
            db.prepare('UPDATE patterns SET share_slug = ? WHERE id = ? AND user_id = ?').run(
              candidate,
              ctx.params.id!,
              user.id,
            )
            slug = candidate
          } catch (err) {
            if (!String(err).includes('UNIQUE')) throw err
          }
        }
        if (slug === null) throw new HttpError(500, '生成分享链接失败，请重试')
      }

      sendJson(ctx.res, 200, { slug })
    },

    unshare(ctx: Ctx): void {
      const user = requireUser(ctx)
      const result = db
        .prepare('UPDATE patterns SET share_slug = NULL WHERE id = ? AND user_id = ?')
        .run(ctx.params.id!, user.id)
      if (Number(result.changes) === 0) throw new HttpError(404, '图纸不存在')
      sendEmpty(ctx.res, 204)
    },

    /** 公开读取：不需要登录，只要 slug 对 */
    getShared(ctx: Ctx): void {
      const row = db
        .prepare('SELECT data, title FROM patterns WHERE share_slug = ?')
        .get(ctx.params.slug!) as { data?: string; title?: string } | undefined
      if (row?.data === undefined) throw new HttpError(404, '分享链接不存在或已失效')
      sendJson(ctx.res, 200, { data: JSON.parse(row.data), title: row.title })
    },
  }
}
