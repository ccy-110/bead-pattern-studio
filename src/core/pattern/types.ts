import type { PaletteColor, PaletteColorKind } from '../palette/types'
import type { BeadSize } from '../palette/types'

/**
 * 图纸里记录的颜色信息。
 *
 * 这是 `PaletteColor` 的可序列化子集：去掉了 `rgb`（可由 hex 派生）与
 * `discontinued`（属于色卡的商品信息，不属于图纸）。
 * 其余字段全部保留，因为图纸文件必须**自包含**——
 * 用户三个月后打开旧文件时，即使色卡数据已经改版，也必须能还原出当时的颜色。
 */
export interface PatternColor {
  id: string
  code: string
  name: string
  nameEn?: string
  hex: string
  kind: PaletteColorKind
}

export function toPatternColor(c: PaletteColor): PatternColor {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    ...(c.nameEn !== undefined ? { nameEn: c.nameEn } : {}),
    hex: c.hex,
    kind: c.kind,
  }
}

/** 原图回溯信息，仅用于界面展示，不含像素数据 */
export interface PatternSourceInfo {
  fileName: string
  width: number
  height: number
}

export interface Pattern {
  rows: number
  cols: number
  beadSizeMm: BeadSize
  colors: PatternColor[]
  /** 长度 = rows × cols，行优先。值 = colors 下标，-1 表示空格。 */
  grid: Int16Array
  title: string
  source?: PatternSourceInfo
}

/** 生成这份图纸时用的参数，用于复现与「重新生成」 */
export interface PatternGenerationParams {
  sampleMode: string
  maxColors: number
  minBeads: number
  rows: number
  cols: number
  crop: { x: number; y: number; width: number; height: number }
  backgroundTolerance: number | null
  adjustments: { brightness: number; contrast: number; saturation: number }
}

/** 颜色用量统计的一行 */
export interface ColorStat {
  /** 在 pattern.colors 中的下标 */
  colorIndex: number
  color: PatternColor
  /** 精确需要的颗数 */
  count: number
  /** 建议备货颗数（含损耗） */
  purchase: number
  /** 按整包购买需要几包 */
  packs: number
}

export interface PatternStats {
  /** 豆子总数（不含空格） */
  totalBeads: number
  /** 空格数 */
  emptyCells: number
  /** 用到的颜色数 */
  colorCount: number
  /** 占格率 0~1 */
  fillRatio: number
  /** 按用量从多到少排序 */
  colors: ColorStat[]
  /** 成品物理宽度（毫米） */
  widthMm: number
  /** 成品物理高度（毫米） */
  heightMm: number
}

export interface PurchaseOptions {
  /** 损耗率，0.08 即多备 8%（熨烫失败、掉粒、色差补色） */
  wasteRatio: number
  /** 每包颗数，用于折算整包数 */
  beadsPerPack: number
}

export const DEFAULT_PURCHASE_OPTIONS: PurchaseOptions = {
  wasteRatio: 0.08,
  beadsPerPack: 1000,
}
