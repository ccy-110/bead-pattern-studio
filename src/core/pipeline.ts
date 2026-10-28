import type { RGB } from './color/types'
import { applyAdjustments } from './imaging/adjust'
import { analyzeBackground, backgroundModelFrom, removeBackground } from './imaging/background'
import type { BackgroundModel } from './imaging/background'
import { downscaleImage } from './imaging/load'
import type { RasterImage } from './imaging/types'
import { quantize } from './quantize'
import type { PaletteColor } from './palette/types'
import type { CropRect } from './quantize'
import type { SampleMode } from './imaging/sample'

/**
 * 转换管线：调色 → 抠图 → 逐格采样 → 色卡匹配 → 削减颜色。
 *
 * 这段逻辑原先长在 Worker 的 `onmessage` 里，跟 `postMessage`、`self` 混在一起，
 * 想测一下"抠完背景到底还剩几颗豆"都做不到。搬出来之后 Worker 只剩收发消息，
 * 而这条最容易出错的链路可以拿真实像素跑测试。
 *
 * ## 为什么要维护两份工作图
 *
 * 预览**先降采样再调色抠图**，而不是调完再缩。这样拖滑块时的代价从
 * O(1600²) 降到 O(900²)，快三倍多，手感才跟得上。代价是抠图边界与全分辨率
 * 结果有亚像素级差别 —— 降采样保持连通性，背景区域不会因缩小而断开，
 * 所以在预览上看不出来。真正决定成品的量化仍然走全分辨率。
 */

/** 预览图的基础边长。一次降采样到这里，之后按需再缩。 */
export const PREVIEW_BASE = 900

export interface PipelineAdjustments {
  brightness: number
  contrast: number
  saturation: number
}

export interface PipelineParams {
  rows: number
  cols: number
  crop: CropRect
  colors: PaletteColor[]
  sampleMode: SampleMode
  maxColors: number
  minBeads: number
  emptyRatio: number
  alphaThreshold: number
  adjustments: PipelineAdjustments
  /** null 表示不抠背景 */
  backgroundTolerance: number | null
  /** 用户在图上点选的背景色；null 表示交给自动推断 */
  backgroundReference: readonly [number, number, number] | null
}

export interface PipelinePatternData {
  grid: Int16Array
  rows: number
  cols: number
  colors: PaletteColor[]
  rawColorCount: number
  emptyCount: number
}

export interface PipelinePreviewData {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface PipelineTimings {
  adjust: number
  background: number
  quantize: number
  preview: number
}

export interface PipelineResult {
  pattern: PipelinePatternData | null
  preview: PipelinePreviewData | null
  backgroundReference: readonly [number, number, number] | null
  backgroundConfidence: number
  timings: PipelineTimings
}

type ProgressFn = (stage: 'sampling' | 'matching' | 'reducing', ratio: number) => void

function toRgb(v: readonly [number, number, number]): RGB {
  return [v[0], v[1], v[2]]
}

/**
 * 把裁剪矩形夹到图像范围内。
 *
 * 裁剪框是主线程按"工作图"坐标维护的，而抠图之后图像尺寸不变、
 * 尺寸参数又可能来自上一次布局 —— 越界读取会取到 undefined 并静默产出脏数据，
 * 所以这里必须夹紧。
 *
 * 非有限值（NaN / Infinity）也必须在这里挡掉。它们通常来自"图还没加载完、
 * 缩放比还是 0"的拖动，一旦漏过去，`Math.round(NaN)` 会让整个矩形变成 NaN，
 * 接着污染每一格的行列边界，最后产出一张全空的图纸 —— 用户完全无从排查。
 */
export function clampCrop(crop: CropRect, width: number, height: number): CropRect {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))

  const x = clampInt(crop.x, 0, w - 1, 0)
  const y = clampInt(crop.y, 0, h - 1, 0)

  return {
    x,
    y,
    // 宽高缺失时退回"从起点到图边"，而不是 1 像素：
    // NaN 多半意味着界面还没算出裁剪框，这时用户想要的是整张图
    width: clampInt(crop.width, 1, w - x, w - x),
    height: clampInt(crop.height, 1, h - y, h - y),
  }
}

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return Math.max(lo, Math.min(hi, fallback))
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

/**
 * 一次转换会话。
 *
 * 持有工作图与背景分析的缓存。缓存是必须的：拖容差滑块时背景分析的结果
 * 并不变（它只取决于调色参数，与容差无关），但每帧重算纯属浪费。
 */
export class ConversionPipeline {
  readonly full: RasterImage
  readonly small: RasterImage

  private analysis: BackgroundModel | null = null
  private analysisKey = ''

  constructor(image: RasterImage) {
    this.full = image
    this.small = downscaleImage(image, PREVIEW_BASE)
  }

  /**
   * 定下背景模型。
   *
   * 预览和全分辨率量化**必须共用同一个模型**。曾经让 `removeBackground`
   * 在里面各自自动分析一次，两次结果可能不一致，用户就会看到
   * "预览里背景抠掉了、成品里还在"这种没法解释的现象。
   *
   * 只分析预览图：背景推断是对边缘像素取众数，本就是统计量，
   * 900px 的边缘样本足够，没必要为它去扫全分辨率的四条边。
   *
   * 缓存只按调色参数失效，不含容差 —— 模型描述的是"边缘上有哪几种背景色"，
   * 与容差无关。这样拖容差滑块时模型恒定，结果才是单调变化的。
   */
  resolveBackground(
    adj: PipelineAdjustments,
    explicit: readonly [number, number, number] | null,
  ): BackgroundModel {
    // 吸管指定了就只认它，不再自动扩展参考色 —— 用户的意图是明确且单一的
    if (explicit) return backgroundModelFrom(toRgb(explicit))

    const key = `${adj.brightness}|${adj.contrast}|${adj.saturation}`
    if (this.analysis && this.analysisKey === key) return this.analysis

    this.analysis = analyzeBackground(applyAdjustments(this.small, adj))
    this.analysisKey = key
    return this.analysis
  }

  /** 单独跑一次背景分析（吸管之外，UI 想提前知道背景色时用） */
  analyze(adj: PipelineAdjustments): BackgroundModel {
    return this.resolveBackground(adj, null)
  }

  run(
    params: PipelineParams,
    wantQuantize: boolean,
    previewMaxDim: number,
    onProgress?: ProgressFn,
  ): PipelineResult {
    let preview: PipelinePreviewData | null = null
    let previewMs = 0

    const model = this.resolveBackground(params.adjustments, params.backgroundReference)

    // ---- 预览（始终走小图，与是否量化无关，因此延迟恒定）----
    if (previewMaxDim > 0 || wantQuantize) {
      const t = performance.now()

      const adjusted = applyAdjustments(this.small, params.adjustments)
      const withBg =
        params.backgroundTolerance === null
          ? adjusted
          : removeBackground(adjusted, {
              model,
              tolerance: params.backgroundTolerance,
            })

      if (previewMaxDim > 0) {
        preview =
          previewMaxDim >= withBg.width && previewMaxDim >= withBg.height
            ? withBg
            : downscaleImage(withBg, previewMaxDim)
      }

      previewMs = performance.now() - t
    }

    // ---- 全分辨率量化 ----
    let pattern: PipelinePatternData | null = null
    let adjustMs = 0
    let backgroundMs = 0
    let quantizeMs = 0

    if (wantQuantize) {
      const t0 = performance.now()
      const adjusted = applyAdjustments(this.full, params.adjustments)
      const t1 = performance.now()

      const prepared =
        params.backgroundTolerance === null
          ? adjusted
          : removeBackground(adjusted, {
              model,
              tolerance: params.backgroundTolerance,
            })
      const t2 = performance.now()

      const result = quantize(
        prepared,
        {
          rows: params.rows,
          cols: params.cols,
          crop: clampCrop(params.crop, prepared.width, prepared.height),
          colors: params.colors,
          sampleMode: params.sampleMode,
          maxColors: params.maxColors,
          minBeads: params.minBeads,
          emptyRatio: params.emptyRatio,
          alphaThreshold: params.alphaThreshold,
        },
        onProgress,
      )
      const t3 = performance.now()

      adjustMs = t1 - t0
      backgroundMs = t2 - t1
      quantizeMs = t3 - t2

      pattern = {
        grid: result.grid,
        rows: result.rows,
        cols: result.cols,
        colors: result.colors,
        rawColorCount: result.rawColorCount,
        emptyCount: result.emptyCount,
      }
    }

    return {
      pattern,
      preview,
      backgroundReference: model.reference,
      backgroundConfidence: model.confidence,
      timings: {
        adjust: adjustMs,
        background: backgroundMs,
        quantize: quantizeMs,
        preview: previewMs,
      },
    }
  }
}
