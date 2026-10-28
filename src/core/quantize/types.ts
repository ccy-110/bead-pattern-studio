import type { SampleMode } from '../imaging/sample'
import type { PaletteColor } from '../palette/types'

/** 工作图上的取图区域（像素坐标） */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface QuantizeOptions {
  rows: number
  cols: number
  /** 候选颜色。调用方需在此之前完成筛选（排除特殊色、排除用户没有的颜色）。 */
  colors: readonly PaletteColor[]
  sampleMode: SampleMode

  /**
   * 颜色数上限。0 表示不限制。
   *
   * 这是**购买成本**的直接控制手段：一张照片直接转能出上百种颜色，
   * 意味着用户要买上百包豆子。限制到 20 色以内才是可接受的。
   */
  maxColors: number

  /**
   * 少于这么多颗的颜色会被合并到最接近的保留色。
   *
   * 存在的理由很实际：拼豆按包卖，一包通常 1000 颗起。
   * 如果一张图纸里某个颜色只用 2 颗，用户却要为此买一整包 —— 必须合并掉。
   * 设为 1 表示不合并。
   */
  minBeads: number

  /** 区域中透明像素占比达到此值即视为空格，0~1。默认 0.5（多数透明才算空）。 */
  emptyRatio: number

  /** alpha 低于此值视为透明像素，0~255 */
  alphaThreshold: number

  /** 在工作图中的取图区域 */
  crop: CropRect
}

export interface QuantizeResult {
  rows: number
  cols: number
  /**
   * 长度 = rows × cols，行优先。
   * 值 = `colors` 数组下标；`-1` 表示该格不放豆子。
   */
  grid: Int16Array
  /** 实际用到的颜色，已去重压缩，与 grid 中的值一一对应 */
  colors: PaletteColor[]
  /** 合并前的原始颜色数，用于向用户展示"合并了多少" */
  rawColorCount: number
  /** 空格数（不放豆子的格数） */
  emptyCount: number
}

export const DEFAULT_QUANTIZE_OPTIONS: Omit<QuantizeOptions, 'colors' | 'crop'> = {
  rows: 29,
  cols: 29,
  sampleMode: 'auto',
  maxColors: 24,
  minBeads: 5,
  emptyRatio: 0.5,
  alphaThreshold: 128,
}
