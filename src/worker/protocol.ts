import type { PaletteColor } from '../core/palette/types'
import type { CropRect } from '../core/quantize/types'
import type { SampleMode } from '../core/imaging/sample'

/**
 * 主线程与 Worker 之间的通信协议。
 *
 * ## 为什么原图只传一次
 *
 * 工作图是 1600×1600 的 RGBA 缓冲（约 10MB）。如果每次调参都重传，
 * 光结构化克隆的开销就超过计算本身。所以拆成两条指令：
 *   `init`    —— 传入工作图，Worker 常驻保存
 *   `process` —— 只传参数（几百字节），Worker 用保存的图重新计算
 * 拖动滑块时走的全是 `process`。
 *
 * ## 为什么预览和量化在同一个请求里
 *
 * 两者共用同一段前置管线（调色 → 抠图 → 降采样），拆成两次请求会重复算一遍。
 * 但两者代价差两个数量级：预览是 O(像素/缩放比)，量化还要额外做逐格采样和匹配。
 * 所以用 `quantize` 开关控制：拖背景容差滑块时只出预览（几毫秒），
 * 松手后才跑完整的网格量化。
 */

export interface WorkerAdjustments {
  brightness: number
  contrast: number
  saturation: number
}

/** 传给 Worker 的完整参数。必须可结构化克隆，因此不含任何函数。 */
export interface WorkerParams {
  rows: number
  cols: number
  /** 裁剪区（工作图像素坐标）。全图时是 { x:0, y:0, width, height } */
  crop: CropRect

  /** 已按用户勾选筛选过的候选色卡 */
  colors: PaletteColor[]
  sampleMode: SampleMode
  maxColors: number
  minBeads: number
  emptyRatio: number
  alphaThreshold: number

  adjustments: WorkerAdjustments

  /** 去背景容差。null 表示不做抠图。 */
  backgroundTolerance: number | null
  /**
   * 去背景的参考色。null 时由 Worker 从图像边缘自动推断。
   * 注意参考色是**调色之后**的颜色空间 —— 用户是在调完色的预览图上吸的管。
   */
  backgroundReference: readonly [number, number, number] | null
}

export interface WorkerInitMessage {
  type: 'init'
  data: ArrayBuffer
  width: number
  height: number
}

export interface WorkerProcessMessage {
  type: 'process'
  /** 递增序号。只接受最新序号的响应，旧响应直接丢弃。 */
  token: number
  params: WorkerParams
  /** 是否执行网格量化。false 时只算预览图。 */
  quantize: boolean
  /** 附带预览图的最大边长。0 表示不要预览图。 */
  previewMaxDim: number
}

/** 请求单独重新分析背景（用户换了裁剪区，或点了"重新识别背景"） */
export interface WorkerAnalyzeMessage {
  type: 'analyze'
  token: number
  adjustments: WorkerAdjustments
}

export type WorkerRequest =
  | WorkerInitMessage
  | WorkerProcessMessage
  | WorkerAnalyzeMessage

export interface WorkerPatternData {
  grid: ArrayBuffer
  rows: number
  cols: number
  colors: PaletteColor[]
  rawColorCount: number
  emptyCount: number
}

export interface WorkerPreviewData {
  data: ArrayBuffer
  width: number
  height: number
}

export interface WorkerResultMessage {
  type: 'result'
  token: number
  /** `quantize: false` 时为 null */
  pattern: WorkerPatternData | null
  /** `previewMaxDim: 0` 时为 null */
  preview: WorkerPreviewData | null
  /** 本次实际使用的背景参考色（自动推断或用户指定） */
  backgroundReference: readonly [number, number, number] | null
  /** 背景推断可信度 0~1。用户显式指定参考色时为 1。 */
  backgroundConfidence: number
  /** 各阶段耗时（毫秒），用于性能诊断 */
  timings: { adjust: number; background: number; quantize: number; preview: number }
}

export interface WorkerAnalyzeResultMessage {
  type: 'analyzeResult'
  token: number
  /**
   * 推断出的背景色。**可能为 null** ——
   * 照片类素材常常四条边各有各的颜色，找不到一个可用的众数，
   * 这时如实返回 null，由界面提示用户用吸管手动指定，
   * 比硬塞一个不靠谱的颜色让用户纳闷为什么抠不干净要好。
   */
  backgroundReference: readonly [number, number, number] | null
  backgroundConfidence: number
}

export interface WorkerProgressMessage {
  type: 'progress'
  token: number
  stage: 'sampling' | 'matching' | 'reducing'
  ratio: number
}

export interface WorkerErrorMessage {
  type: 'error'
  token: number
  message: string
}

export type WorkerResponse =
  | WorkerResultMessage
  | WorkerAnalyzeResultMessage
  | WorkerProgressMessage
  | WorkerErrorMessage
