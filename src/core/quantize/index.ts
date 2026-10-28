import { rgbToLabInto } from '../color'
import { createSampleScratch, sampleRegion } from '../imaging/sample'
import type { RasterImage } from '../imaging/types'
import { PaletteMatcher } from '../palette/matcher'
import type { PaletteColor } from '../palette/types'
import type { QuantizeOptions, QuantizeResult } from './types'

export type { QuantizeOptions, QuantizeResult, CropRect } from './types'
export { DEFAULT_QUANTIZE_OPTIONS } from './types'

export interface QuantizeProgress {
  (stage: 'sampling' | 'matching' | 'reducing', ratio: number): void
}

/** 值为 -1 表示空格 */
export const EMPTY_CELL = -1

/**
 * 把一张位图转换成拼豆网格。
 *
 * 完整流程：
 *
 *  1. **逐格采样**（sampleRegion）
 *     每个格子对应源图的一小块区域，从中取出一个**真实存在于原图**的代表色。
 *     默认用主色法而不是平均值 —— 这是避免边缘出现"脏色"的关键。
 *
 *  2. **色卡匹配**（PaletteMatcher）
 *     把代表色映射到色卡中真实存在的某个色号。
 *     距离用 CIEDE2000，与 RGB 欧氏距离相比能避免深蓝被判成黑色这类错误。
 *     整个过程中**绝不会产生色卡之外的颜色**。
 *
 *  3. **颜色数削减**（reduce）
 *     先合并"颗数过少不值得单独买一包"的颜色，再按上限削减总颜色数。
 *     每次合并后都重新统计 —— 因为合并会让目标色的颗数增加，
 *     可能让它从"稀有"变成"常见"，顺序反过来会误删高频色。
 *
 * @param img 工作图（已调色、已抠图）
 */
export function quantize(
  img: RasterImage,
  options: QuantizeOptions,
  onProgress?: QuantizeProgress,
): QuantizeResult {
  const { rows, cols, colors, sampleMode, crop } = options

  if (rows < 1 || cols < 1) throw new Error('图纸行列数必须至少为 1')
  if (colors.length === 0) throw new Error('候选颜色为空，请至少选择一种豆子颜色')

  const matcher = new PaletteMatcher(colors)
  const scratch = createSampleScratch()

  const cellCount = rows * cols
  const grid = new Int16Array(cellCount)

  // 单元格在源图上的尺寸。用浮点边界逐格取整，
  // 避免 (c * cw) / cols 这种写法在除不尽时产生累积偏移。
  const cw = crop.width / cols
  const ch = crop.height / rows

  const alphaThreshold = options.alphaThreshold
  const emptyRatio = options.emptyRatio

  // ---- 阶段一：逐格采样并匹配到色卡 ----
  const progressStride = Math.max(1, Math.floor(cellCount / 100))

  for (let r = 0; r < rows; r++) {
    const y0 = crop.y + r * ch
    const y1 = crop.y + (r + 1) * ch

    for (let c = 0; c < cols; c++) {
      const x0 = crop.x + c * cw
      const x1 = crop.x + (c + 1) * cw

      const sample = sampleRegion(img, x0, y0, x1, y1, sampleMode, alphaThreshold, scratch)

      const idx = r * cols + c

      if (sample.count === 0) {
        grid[idx] = EMPTY_CELL
        continue
      }

      // 透明像素占比过高 → 这一格留空，不放豆子
      const transparentRatio = 1 - sample.count / sample.total
      if (transparentRatio >= emptyRatio) {
        grid[idx] = EMPTY_CELL
        continue
      }

      grid[idx] = matcher.findNearest(sample.rgb[0], sample.rgb[1], sample.rgb[2])
    }

    if (onProgress && (r % progressStride === 0 || r === rows - 1)) {
      onProgress('sampling', (r + 1) / rows)
    }
  }

  // ---- 阶段二：削减颜色数 ----
  const labs = computeLabs(colors)
  const rawColorCount = countDistinct(grid, colors.length)

  const mapping = reduceColors(grid, colors.length, labs, {
    maxColors: options.maxColors,
    minBeads: options.minBeads,
    onProgress: onProgress ? (ratio) => onProgress('reducing', ratio) : undefined,
  })

  // ---- 阶段三：应用映射并压缩颜色表 ----
  const remap = new Int32Array(colors.length).fill(-1)
  const usedColors: PaletteColor[] = []

  for (let i = 0; i < cellCount; i++) {
    const g = grid[i]!
    if (g === EMPTY_CELL) continue
    const target = mapping[g]!
    let slot = remap[target]!
    if (slot < 0) {
      slot = usedColors.length
      remap[target] = slot
      usedColors.push(colors[target]!)
    }
    grid[i] = slot
  }

  let emptyCount = 0
  for (let i = 0; i < cellCount; i++) {
    if (grid[i] === EMPTY_CELL) emptyCount++
  }

  return {
    rows,
    cols,
    grid,
    colors: usedColors,
    rawColorCount,
    emptyCount,
  }
}

/** 预计算候选色的 Lab，供合并阶段反复使用 */
function computeLabs(colors: readonly PaletteColor[]): Float64Array {
  const labs = new Float64Array(colors.length * 3)
  for (let i = 0; i < colors.length; i++) {
    const rgb = colors[i]!.rgb
    rgbToLabInto(rgb[0], rgb[1], rgb[2], labs, i * 3)
  }
  return labs
}

function countDistinct(grid: Int16Array, colorCount: number): number {
  const seen = new Uint8Array(colorCount)
  let n = 0
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i]!
    if (g >= 0 && !seen[g]) {
      seen[g] = 1
      n++
    }
  }
  return n
}

/** Lab 空间下 b 相对 a 的平方距离 */
function labDist2(labs: Float64Array, a: number, b: number): number {
  const dL = labs[a * 3]! - labs[b * 3]!
  const da = labs[a * 3 + 1]! - labs[b * 3 + 1]!
  const db = labs[a * 3 + 2]! - labs[b * 3 + 2]!
  return dL * dL + da * da + db * db
}

interface ReduceParams {
  maxColors: number
  minBeads: number
  onProgress?: (ratio: number) => void
}

/**
 * 计算"每个候选色最终归并到哪个候选色"的映射表。
 *
 * 归并顺序很讲究：**必须先处理低频色，再处理超限**。
 * 如果反过来先按上限砍，会把"颗数不多但很关键"的颜色（比如眼睛的高光点）
 * 直接砍掉；而先合并低频色时，这些关键色如果颗数够就自然保留下来。
 *
 * 另外每次合并后都必须**重新统计**：合并会让目标色颗数上涨，
 * 可能使原本"稀有"的颜色脱离阈值，也可能让某个色一下子变成高频色。
 * 一次性算好再批量合并会得到错误的结果。
 */
function reduceColors(
  grid: Int16Array,
  colorCount: number,
  labs: Float64Array,
  params: ReduceParams,
): Int32Array {
  const { maxColors, minBeads } = params

  const mapping = new Int32Array(colorCount)
  for (let i = 0; i < colorCount; i++) mapping[i] = i

  const applyMerge = (from: number, to: number) => {
    for (let i = 0; i < colorCount; i++) {
      if (mapping[i] === from) mapping[i] = to
    }
  }

  const aggregate = (): { counts: Int32Array; active: number[] } => {
    const counts = new Int32Array(colorCount)
    for (let i = 0; i < grid.length; i++) {
      const g = grid[i]!
      if (g < 0) continue
      const t = mapping[g]!
      counts[t] = counts[t]! + 1
    }
    const active: number[] = []
    for (let i = 0; i < colorCount; i++) {
      if (counts[i]! > 0) active.push(i)
    }
    return { counts, active }
  }

  const nearestActive = (from: number, active: readonly number[]): number => {
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < active.length; i++) {
      const cand = active[i]!
      if (cand === from) continue
      const d = labDist2(labs, from, cand)
      if (d < bestDist) {
        bestDist = d
        best = cand
      }
    }
    return best
  }

  // ---- 第一轮：合并颗数不足的颜色 ----
  // 上限设为一个足够大的迭代次数，正常情况远达不到，只作为死循环保险。
  const maxIterations = colorCount + 8

  if (minBeads > 1) {
    for (let iter = 0; iter < maxIterations; iter++) {
      const { counts, active } = aggregate()
      if (active.length <= 1) break

      // 每次只合并"最稀有"的那一个，然后重新统计
      let rarest = -1
      let rarestCount = Infinity
      for (const i of active) {
        const c = counts[i]!
        if (c < minBeads && c < rarestCount) {
          rarestCount = c
          rarest = i
        }
      }
      if (rarest < 0) break

      const target = nearestActive(rarest, active)
      if (target < 0) break
      applyMerge(rarest, target)
      params.onProgress?.((iter + 1) / maxIterations)
    }
  }

  // ---- 第二轮：按上限削减颜色总数 ----
  if (maxColors > 0) {
    for (let iter = 0; iter < maxIterations; iter++) {
      const { counts, active } = aggregate()
      if (active.length <= maxColors || active.length <= 1) break

      let least = active[0]!
      let leastCount = counts[least]!
      for (const i of active) {
        const c = counts[i]!
        if (c < leastCount) {
          leastCount = c
          least = i
        }
      }

      const target = nearestActive(least, active)
      if (target < 0) break
      applyMerge(least, target)
      params.onProgress?.((iter + 1) / maxIterations)
    }
  }

  return mapping
}
