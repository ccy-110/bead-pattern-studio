import { linearToSrgbComponent, srgbToLinear } from '../color'
import type { RGB } from '../color/types'
import type { RasterImage } from './types'

/**
 * 区域取色策略。这决定了"一张图缩成 50×50 个格子"时，
 * 每个格子到底取什么颜色 —— 是本项目**输出质量的分水岭**。
 *
 * - `mode`（默认）：取区域内**出现次数最多**的颜色。
 * - `average`：取区域均值，但在线性光空间做。
 * - `median`：逐通道取中位数，抗噪。
 * - `auto`：按区域"单一色占比"自动在 mode 与 average 之间选。
 */
export type SampleMode = 'auto' | 'mode' | 'average' | 'median'

export const SAMPLE_MODE_LABEL: Record<SampleMode, string> = {
  auto: '自动（推荐）',
  mode: '主色（卡通/线稿最佳）',
  average: '平均（照片更柔和）',
  median: '中位数（抗噪）',
}

/**
 * 自动模式判定阈值：区域里最大单色占比低于此值时，认为该区域色彩杂乱
 * （典型是照片的细节区），改用平均值，避免主色法在噪声里随机跳动产生麻点。
 */
const AUTO_DOMINANCE_THRESHOLD = 0.3

const BUCKET_SHIFT = 3 // 每通道取高 5 位
const NUM_BUCKETS = 1 << 15 // 32×32×32

/**
 * 采样用的可复用缓冲区。
 *
 * 逐格分配数组会让 GC 成为主要瓶颈（10 万格就是 10 万次分配），
 * 所以把所有临时状态放进这个对象反复使用，
 * 并用 `touched` 列表只清理**用过的**桶，而不是每格把 32768 个桶全部清零。
 */
export interface SampleScratch {
  readonly bucketCount: Int32Array
  readonly bucketSumR: Float32Array
  readonly bucketSumG: Float32Array
  readonly bucketSumB: Float32Array
  /** 本次采样中被写入过的桶下标，长度由 touchedCount 给出 */
  readonly touched: Int32Array
  /** touched 的有效长度。跨调用保留，这样切换采样模式时也能正确清理。 */
  touchedCount: number
  readonly histR: Int32Array
  readonly histG: Int32Array
  readonly histB: Int32Array
}

export function createSampleScratch(): SampleScratch {
  return {
    bucketCount: new Int32Array(NUM_BUCKETS),
    bucketSumR: new Float32Array(NUM_BUCKETS),
    bucketSumG: new Float32Array(NUM_BUCKETS),
    bucketSumB: new Float32Array(NUM_BUCKETS),
    touched: new Int32Array(NUM_BUCKETS),
    touchedCount: 0,
    histR: new Int32Array(256),
    histG: new Int32Array(256),
    histB: new Int32Array(256),
  }
}

export interface RegionSample {
  /** 代表色。`count === 0` 时无意义。 */
  rgb: RGB
  /** 区域内有效（未透明）的像素数 */
  count: number
  /** 区域总像素数 */
  total: number
  /** 最大单色占比 0~1，反映区域"纯净度" */
  dominance: number
}

/** 逐通道中位数：直方图累积计数走到一半即为中位 */
function histogramMedian(hist: Int32Array, total: number): number {
  const half = total >> 1
  let acc = 0
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!
    if (acc > half) return i
  }
  return 255
}

/**
 * 格子不到一个像素时的兜底：取格子中心最近的那个像素。
 *
 * 裁一小块区域却要很多格子时（比如 20 像素宽要 48 列），每个格子只有 0.4 像素，
 * `Math.floor` 会把一部分格子的左右边界压成同一个值，一整个像素都采不到。
 * 这些格子原先直接算作空 —— 结果是一张规律排列着空洞的图纸：
 * 用户要的是 48 列，拿到的是 24 列豆子加 24 列空白，而且完全看不出原因。
 *
 * 格子再小也总有中心点，取离中心最近的那个像素，至少让每一格都有颜色。
 * 采样模式在这里无需区分：只有一个像素时，主色、均值、中位数都是它自己。
 */
function sampleNearest(
  img: RasterImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  alphaThreshold: number,
): RegionSample {
  const { width: w, height: h, data } = img

  const x = Math.max(0, Math.min(w - 1, Math.floor((x0 + x1) / 2)))
  const y = Math.max(0, Math.min(h - 1, Math.floor((y0 + y1) / 2)))
  const o = (y * w + x) << 2

  const rgb: RGB = [data[o]!, data[o + 1]!, data[o + 2]!]

  // total 记 1：这一格只有一个采样点，是透明还是实心全由它自己说了算，
  // 上层据此算出的透明占比不是 0 就是 1，正好对应"留白"与"放豆"
  if (data[o + 3]! < alphaThreshold) {
    return { rgb, count: 0, total: 1, dominance: 0 }
  }
  return { rgb, count: 1, total: 1, dominance: 1 }
}

/**
 * 清理上一轮采样留下的状态。
 *
 * touchedCount 跨调用保留，这一点很重要：如果某一轮不需要联合直方图，
 * 那它的计数就原封不动地留着，下一轮需要时仍能凭这份清单精确清干净。
 * 若在这里把清单重置掉，残留的非零计数会导致下一轮"以为桶是空的"而漏加进 touched，
 * 结果就是脏数据被累加进去。
 */
function clearScratch(s: SampleScratch, needJoint: boolean, needChannel: boolean): void {
  if (needJoint) {
    for (let i = 0; i < s.touchedCount; i++) {
      const b = s.touched[i]!
      s.bucketCount[b] = 0
      s.bucketSumR[b] = 0
      s.bucketSumG[b] = 0
      s.bucketSumB[b] = 0
    }
    s.touchedCount = 0
  }
  if (needChannel) {
    s.histR.fill(0)
    s.histG.fill(0)
    s.histB.fill(0)
  }
}

/**
 * 对源图的一个矩形区域取代表色。
 *
 * 矩形是半开区间 `[x0, x1) × [y0, y1)`。
 *
 * **为什么默认用主色而不是平均值**：
 * 平均值会造出原图里根本不存在的中间色。黑白交界处的格子取平均会得到灰色，
 * 而灰色既不是黑也不是白 —— 映射到色卡后就是一个"错误"的颜色，
 * 在成品上表现为边缘一圈脏兮兮的过渡色。主色法则永远返回区域里真实存在的颜色，
 * 边缘保持锐利。
 *
 * 平均值的另一个问题在深色区域尤其明显：sRGB 空间的算术平均会系统性地偏亮，
 * 所以这里的 average 模式改在**线性光空间**累加，这才是物理正确的平均方式。
 */
export function sampleRegion(
  img: RasterImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  mode: SampleMode,
  alphaThreshold: number,
  scratch: SampleScratch,
): RegionSample {
  const { width: w, data } = img

  const left = Math.max(0, Math.min(w, Math.floor(x0)))
  const right = Math.max(0, Math.min(w, Math.floor(x1)))
  const top = Math.max(0, Math.floor(y0))
  const bottom = Math.floor(y1)

  const total = Math.max(0, right - left) * Math.max(0, bottom - top)
  if (total === 0) return sampleNearest(img, x0, y0, x1, y1, alphaThreshold)

  const needJoint = mode === 'mode' || mode === 'auto'
  const needChannel = mode === 'median'
  // auto 需要在线性空间再算一份，作为主色法失效时的兜底
  const needLinear = mode === 'average' || mode === 'auto'

  clearScratch(scratch, needJoint, needChannel)

  let count = 0
  let linR = 0
  let linG = 0
  let linB = 0

  for (let y = top; y < bottom; y++) {
    let o = (y * w + left) << 2
    for (let x = left; x < right; x++, o += 4) {
      const a = data[o + 3]!
      if (a < alphaThreshold) continue // 透明像素不参与取色

      const r = data[o]!
      const g = data[o + 1]!
      const b = data[o + 2]!
      count++

      if (needLinear) {
        linR += srgbToLinear(r)
        linG += srgbToLinear(g)
        linB += srgbToLinear(b)
      }

      if (needJoint) {
        const bucket =
          ((r >> BUCKET_SHIFT) << 10) | ((g >> BUCKET_SHIFT) << 5) | (b >> BUCKET_SHIFT)
        if (scratch.bucketCount[bucket]! === 0) {
          scratch.touched[scratch.touchedCount++] = bucket
        }
        scratch.bucketCount[bucket]!++
        scratch.bucketSumR[bucket]! += r
        scratch.bucketSumG[bucket]! += g
        scratch.bucketSumB[bucket]! += b
      }

      if (needChannel) {
        scratch.histR[r]!++
        scratch.histG[g]!++
        scratch.histB[b]!++
      }
    }
  }

  if (count === 0) {
    return { rgb: [255, 255, 255], count: 0, total, dominance: 0 }
  }

  // ---- 均值（线性光空间）----
  const averageRgb: RGB = [
    Math.round(linearToSrgbComponent(linR / count)),
    Math.round(linearToSrgbComponent(linG / count)),
    Math.round(linearToSrgbComponent(linB / count)),
  ]

  if (mode === 'average') {
    return { rgb: averageRgb, count, total, dominance: 0 }
  }

  if (mode === 'median') {
    return {
      rgb: [
        histogramMedian(scratch.histR, count),
        histogramMedian(scratch.histG, count),
        histogramMedian(scratch.histB, count),
      ],
      count,
      total,
      dominance: 0,
    }
  }

  // ---- 主色：找像素数最多的桶，并取该桶内的均值作为代表色 ----
  // 用桶内均值而非桶中心，是为了把 5 位量化丢掉的精度找回来。
  let bestBucket = scratch.touched[0]!
  let bestCount = 0
  for (let i = 0; i < scratch.touchedCount; i++) {
    const b = scratch.touched[i]!
    const c = scratch.bucketCount[b]!
    if (c > bestCount) {
      bestCount = c
      bestBucket = b
    }
  }

  const dominance = bestCount / count
  const modeRgb: RGB = [
    Math.round(scratch.bucketSumR[bestBucket]! / bestCount),
    Math.round(scratch.bucketSumG[bestBucket]! / bestCount),
    Math.round(scratch.bucketSumB[bestBucket]! / bestCount),
  ]

  if (mode === 'mode') {
    return { rgb: modeRgb, count, total, dominance }
  }

  // ---- auto：区域够"纯"就用主色，太杂就退回均值 ----
  return {
    rgb: dominance >= AUTO_DOMINANCE_THRESHOLD ? modeRgb : averageRgb,
    count,
    total,
    dominance,
  }
}
