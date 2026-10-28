import { cloneImage } from './types'
import type { RasterImage } from './types'

/**
 * 基础影调调节。
 *
 * 三个参数都在 -100 ~ 100，0 表示不变，与常见修图软件的手感一致。
 * 这些调节存在的意义：用户上传的照片/素材图往往偏暗、发灰、背景是白底，
 * 靠算法去救光照是事倍功半的，让用户先手动把图调干净，转出来的图纸质量会好一大截。
 */
export interface Adjustments {
  /** 亮度，-100 ~ 100 */
  brightness: number
  /** 对比度，-100 ~ 100 */
  contrast: number
  /** 饱和度，-100 ~ 100。-100 = 完全灰度 */
  saturation: number
}

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
}

export function hasAdjustments(a: Adjustments): boolean {
  return a.brightness !== 0 || a.contrast !== 0 || a.saturation !== 0
}

/**
 * 亮度与对比度都是**逐通道、与邻域无关**的映射，
 * 因此可以合并成一张 256 项的查找表 —— 无论图多大，实际计算只有 256 次。
 *
 * 映射公式对齐 CSS filter 的语义，保证预览与最终输出一致：
 *   亮度:   v' = v * b
 *   对比度: v' = (v - 0.5) * c + 0.5
 * 其中 v 是归一化到 0~1 的 sRGB 分量。
 */
function buildToneLut(brightness: number, contrast: number): Uint8ClampedArray {
  const b = 1 + brightness / 100
  const c = 1 + contrast / 100
  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    let v = i / 255
    v = v * b
    v = (v - 0.5) * c + 0.5
    lut[i] = Math.round(Math.max(0, Math.min(1, v)) * 255)
  }
  return lut
}

/**
 * Rec.709 亮度权重。
 * 饱和度调节是围绕"该像素的亮度"做线性插值：
 *   s = 1 不变，s = 0 变灰，s > 1 增艳。
 *
 * 这里在 sRGB 空间做（而非线性光空间），与主流修图软件的手感一致 ——
 * 线性空间下把饱和度拉满会显得过曝且色相偏移。
 */
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

function saturationFactor(saturation: number): number {
  return 1 + saturation / 100
}

/**
 * 应用影调调节，返回新图（不修改入参）。
 *
 * 已完全透明的像素会被直接跳过 —— 抠过背景之后再调亮度，
 * 不应该让已抠掉的区域"复活"出颜色。
 */
export function applyAdjustments(
  img: RasterImage,
  adj: Adjustments,
): RasterImage {
  if (!hasAdjustments(adj)) return cloneImage(img)

  const out = cloneImage(img)
  const data = out.data
  const n = img.width * img.height

  const toneLut = buildToneLut(adj.brightness, adj.contrast)
  const needTone = adj.brightness !== 0 || adj.contrast !== 0
  const sat = saturationFactor(adj.saturation)
  const needSat = adj.saturation !== 0

  // Uint8ClampedArray 赋值时自动取整并 clamp 到 0~255，不必手动处理
  for (let p = 0; p < n; p++) {
    const o = p << 2
    if (data[o + 3] === 0) continue

    let r = data[o]!
    let g = data[o + 1]!
    let b = data[o + 2]!

    if (needTone) {
      r = toneLut[r]!
      g = toneLut[g]!
      b = toneLut[b]!
    }

    if (needSat) {
      const y = LUMA_R * r + LUMA_G * g + LUMA_B * b
      r = y + (r - y) * sat
      g = y + (g - y) * sat
      b = y + (b - y) * sat
    }

    data[o] = r
    data[o + 1] = g
    data[o + 2] = b
  }

  return out
}
