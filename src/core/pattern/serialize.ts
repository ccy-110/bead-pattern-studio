import type { BeadSize, PaletteColorKind } from '../palette/types'
import type {
  Pattern,
  PatternColor,
  PatternGenerationParams,
  PatternSourceInfo,
} from './types'

export const PATTERN_FORMAT = 'beadpattern'
export const PATTERN_VERSION = 1

// 必须与 PaletteColorKind 保持同步：不在这个白名单里的类别在读盘时会被
// **静默降级成 'solid'**，于是同一个颜色出现「存盘前不可用、重开后变成可用候选」
// 这种前后不一致的行为。
const VALID_KINDS: readonly PaletteColorKind[] = [
  'solid',
  'metallic',
  'pearl',
  'transparent',
  'glow',
  'glitter',
  'neon',
  'thermo',
  'uv',
]

const VALID_BEAD_SIZES: readonly number[] = [2.6, 5, 10]

/**
 * 图纸文件的磁盘格式。
 *
 * 设计要点：
 *
 * - **版本号从第一天就写进文件**。没有它，将来任何格式调整都会让老用户的
 *   存档全部报废。有了它，老文件永远可以被迁移读入。
 *
 * - **颜色信息内嵌，不引用色卡 ID**。图纸必须自包含：三个月后色卡数据
 *   修订了色号或 RGB，用户的旧图纸仍要能原样还原。代价是每个文件多几 KB，
 *   完全值得。
 *
 * - **网格用二维数组而不是扁平数组**。文件体积略大，但用文本编辑器打开时
 *   行列对齐、肉眼可读可改。图纸文件是用户会长期保存的东西，
 *   可读性比省那几 KB 重要。
 */
export interface PatternFileV1 {
  format: typeof PATTERN_FORMAT
  version: 1
  createdAt: string
  title: string
  beadSizeMm: number
  colors: PatternColor[]
  /** 每行一个数组，值 = colors 下标，-1 表示空格 */
  grid: number[][]
  source?: PatternSourceInfo
  /** 原图缩略图（data URL），仅用于界面展示 */
  thumbnail?: string
  /** 生成参数，用于复现与「重新生成」 */
  generation?: PatternGenerationParams
}

export interface SerializeExtras {
  thumbnail?: string
  generation?: PatternGenerationParams
}

/** 序列化成 JSON 文本 */
export function serializePattern(
  pattern: Pattern,
  extras: SerializeExtras = {},
): string {
  const grid: number[][] = new Array(pattern.rows)
  for (let r = 0; r < pattern.rows; r++) {
    const row: number[] = new Array(pattern.cols)
    for (let c = 0; c < pattern.cols; c++) {
      row[c] = pattern.grid[r * pattern.cols + c]!
    }
    grid[r] = row
  }

  const file: PatternFileV1 = {
    format: PATTERN_FORMAT,
    version: PATTERN_VERSION,
    createdAt: new Date().toISOString(),
    title: pattern.title,
    beadSizeMm: pattern.beadSizeMm,
    colors: pattern.colors,
    grid,
    ...(pattern.source !== undefined ? { source: pattern.source } : {}),
    ...(extras.thumbnail !== undefined ? { thumbnail: extras.thumbnail } : {}),
    ...(extras.generation !== undefined ? { generation: extras.generation } : {}),
  }

  return JSON.stringify(file)
}

export class PatternParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatternParseError'
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseColor(raw: unknown, index: number): PatternColor {
  if (!isPlainObject(raw)) {
    throw new PatternParseError(`第 ${index + 1} 个颜色不是对象`)
  }
  const { id, code, name, nameEn, hex, kind } = raw

  if (typeof id !== 'string' || id === '') {
    throw new PatternParseError(`第 ${index + 1} 个颜色缺少 id`)
  }
  if (typeof code !== 'string' || code === '') {
    throw new PatternParseError(`第 ${index + 1} 个颜色缺少色号`)
  }
  if (typeof name !== 'string') {
    throw new PatternParseError(`第 ${index + 1} 个颜色缺少名称`)
  }
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new PatternParseError(
      `第 ${index + 1} 个颜色（${code}）的颜色值非法：${String(hex)}`,
    )
  }

  const resolvedKind: PaletteColorKind =
    typeof kind === 'string' && (VALID_KINDS as readonly string[]).includes(kind)
      ? (kind as PaletteColorKind)
      : 'solid'

  return {
    id,
    code,
    name,
    ...(typeof nameEn === 'string' ? { nameEn } : {}),
    hex: hex.toLowerCase(),
    kind: resolvedKind,
  }
}

/**
 * 从 JSON 文本解析图纸。
 *
 * 校验做得很严 —— 图纸文件是用户会手工备份、跨设备传输的东西，
 * 出问题时给出**具体到哪一行哪一格**的错误信息，比笼统的"文件损坏"有用得多。
 */
export function parsePatternFile(text: string): {
  pattern: Pattern
  thumbnail?: string
  generation?: PatternGenerationParams
} {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PatternParseError('文件不是合法的 JSON，可能已损坏')
  }

  if (!isPlainObject(raw)) {
    throw new PatternParseError('文件内容不是一个对象')
  }

  if (raw.format !== PATTERN_FORMAT) {
    throw new PatternParseError(
      `这不是拼豆图纸文件（format = ${String(raw.format)}）`,
    )
  }

  const version = raw.version
  if (typeof version !== 'number') {
    throw new PatternParseError('文件缺少版本号')
  }
  if (version > PATTERN_VERSION) {
    throw new PatternParseError(
      `文件版本为 v${version}，当前版本只支持到 v${PATTERN_VERSION}，请升级后再打开`,
    )
  }
  if (version < 1) {
    throw new PatternParseError(`不支持的版本号 v${version}`)
  }

  // ---- 颜色表 ----
  if (!Array.isArray(raw.colors) || raw.colors.length === 0) {
    throw new PatternParseError('文件里没有任何颜色')
  }
  const colors = raw.colors.map((c, i) => parseColor(c, i))

  // ---- 网格 ----
  if (!Array.isArray(raw.grid) || raw.grid.length === 0) {
    throw new PatternParseError('文件里没有图纸网格')
  }
  const rows = raw.grid.length
  const firstRow = raw.grid[0]
  if (!Array.isArray(firstRow) || firstRow.length === 0) {
    throw new PatternParseError('图纸网格的第一行为空')
  }
  const cols = firstRow.length

  const grid = new Int16Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    const row = raw.grid[r]
    if (!Array.isArray(row)) {
      throw new PatternParseError(`图纸第 ${r + 1} 行不是数组`)
    }
    if (row.length !== cols) {
      throw new PatternParseError(
        `图纸第 ${r + 1} 行有 ${row.length} 格，与第一行的 ${cols} 格不一致`,
      )
    }
    for (let c = 0; c < cols; c++) {
      const v = row[c]
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new PatternParseError(`图纸第 ${r + 1} 行第 ${c + 1} 格不是整数`)
      }
      if (v !== -1 && (v < 0 || v >= colors.length)) {
        throw new PatternParseError(
          `图纸第 ${r + 1} 行第 ${c + 1} 格的色号下标 ${v} 超出范围（共 ${colors.length} 种颜色）`,
        )
      }
      grid[r * cols + c] = v
    }
  }

  // ---- 豆子规格 ----
  const beadSizeRaw = raw.beadSizeMm
  const beadSizeMm = (
    typeof beadSizeRaw === 'number' && VALID_BEAD_SIZES.includes(beadSizeRaw)
      ? beadSizeRaw
      : 5
  ) as BeadSize

  const source = isPlainObject(raw.source) &&
    typeof raw.source.fileName === 'string' &&
    typeof raw.source.width === 'number' &&
    typeof raw.source.height === 'number'
    ? {
        fileName: raw.source.fileName,
        width: raw.source.width,
        height: raw.source.height,
      }
    : undefined

  const pattern: Pattern = {
    rows,
    cols,
    beadSizeMm,
    colors,
    grid,
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : '未命名图纸',
    ...(source !== undefined ? { source } : {}),
  }

  return {
    pattern,
    ...(typeof raw.thumbnail === 'string' ? { thumbnail: raw.thumbnail } : {}),
    ...(isPlainObject(raw.generation)
      ? { generation: raw.generation as unknown as PatternGenerationParams }
      : {}),
  }
}

/** 生成一个带时间戳的默认文件名 */
export function suggestFileName(pattern: Pattern, ext: string): string {
  const base = (pattern.title || '拼豆图纸').replace(/[\\/:*?"<>|]/g, '_')
  return `${base}_${pattern.cols}x${pattern.rows}.${ext}`
}
