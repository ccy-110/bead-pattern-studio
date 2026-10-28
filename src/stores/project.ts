import { computed, reactive, ref, shallowRef } from 'vue'

import type { RGB } from '@/core/color/types'
import { DEFAULT_ADJUSTMENTS } from '@/core/imaging/adjust'
import type { Adjustments } from '@/core/imaging/adjust'
import { loadImageFile } from '@/core/imaging/load'
import type { SampleMode } from '@/core/imaging/sample'
import type { RasterImage } from '@/core/imaging/types'
import {
  DEFAULT_PALETTE_ID,
  createPaletteFilter,
  getPalette,
  selectColors,
} from '@/core/palette'
import type { BeadSize, PaletteColor, PaletteColorKind } from '@/core/palette'
import {
  DEFAULT_BOARD_SIZE,
  DEFAULT_CELLS,
  DEFAULT_PURCHASE_OPTIONS,
  clampCells,
  computeStats,
  parsePatternFile,
  resolveSize,
  snapToBoard,
  toPatternColor,
} from '@/core/pattern'
import type {
  CellSize,
  Pattern,
  PatternColor,
  PatternGenerationParams,
  PatternStats,
  PurchaseOptions,
  SizeDriver,
} from '@/core/pattern'
import { DEFAULT_QUANTIZE_OPTIONS } from '@/core/quantize'
import type { CropRect } from '@/core/quantize'
import { ConvertWorkerClient } from '@/worker/client'
import type { WorkerParams } from '@/worker/protocol'

/**
 * 全局项目状态。
 *
 * 这是个单文档工具（一次处理一张图），所以用模块级单例而不是 Pinia ——
 * 少一层依赖，而且那些**不能被 Vue 深度代理**的大数组能更直白地控制住。
 *
 * ## 重数据为什么不放进 reactive
 *
 * 网格动辄十几万到几十万个元素。`reactive()` 会把每个元素递归包成响应式代理，
 * 几十万次代理创建足以让界面卡死。所以网格和像素缓冲都放在 `shallowRef` 里
 * 整体替换，原地修改后手动 bump 版本号让画布重绘。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 预览图的最大边长，与 Worker 侧的 PREVIEW_BASE 对齐 */
export const PREVIEW_MAX_DIM = 900

/** 参数变化后延迟多久才跑完整量化。太短浪费算力，太长显得迟钝。 */
const PATTERN_DEBOUNCE_MS = 220

const HISTORY_LIMIT = 60

/** 同一个 key 的连续参数改动在这个时间内合并成一步撤销 */
const HISTORY_COALESCE_MS = 900

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export interface ProjectState {
  // ---- 源图 ----
  fileName: string
  originalWidth: number
  originalHeight: number
  /** 工作图尺寸。裁剪框与预览坐标都以它为准。 */
  workingWidth: number
  workingHeight: number

  // ---- 影调与抠图 ----
  adjustments: Adjustments
  bgEnabled: boolean
  bgTolerance: number
  /** 用户用吸管显式指定的背景色。null = 交给自动推断。 */
  bgReference: RGB | null

  // ---- 尺寸 ----
  rows: number
  cols: number
  sizeDriver: SizeDriver
  lockAspect: boolean
  beadSizeMm: BeadSize
  boardSize: number
  /** 裁剪区（工作图像素坐标）。null = 使用整张图。 */
  crop: CropRect | null

  // ---- 色卡 ----
  paletteId: string
  activeKinds: PaletteColorKind[]
  excludedIds: string[]
  excludeDiscontinued: boolean

  // ---- 量化参数 ----
  sampleMode: SampleMode
  maxColors: number
  minBeads: number
  emptyRatio: number
  alphaThreshold: number

  // ---- 输出 ----
  title: string
  purchase: PurchaseOptions

  // ---- 运行时 ----
  busy: 'idle' | 'preview' | 'pattern'
  progress: number
  progressStage: string
  error: string | null
  /** 自动推断出的背景色，仅用于提示，不参与计算 */
  detectedReference: RGB | null
  detectedConfidence: number
  timings: { adjust: number; background: number; quantize: number; preview: number } | null
}

export const state = reactive<ProjectState>({
  fileName: '',
  originalWidth: 0,
  originalHeight: 0,
  workingWidth: 0,
  workingHeight: 0,

  adjustments: { ...DEFAULT_ADJUSTMENTS },
  bgEnabled: false,
  bgTolerance: 32,
  bgReference: null,

  rows: DEFAULT_CELLS,
  cols: DEFAULT_CELLS,
  sizeDriver: 'cols',
  lockAspect: true,
  beadSizeMm: 5,
  boardSize: DEFAULT_BOARD_SIZE,
  crop: null,

  paletteId: DEFAULT_PALETTE_ID,
  activeKinds: ['solid'],
  excludedIds: [],
  excludeDiscontinued: false,

  sampleMode: DEFAULT_QUANTIZE_OPTIONS.sampleMode,
  maxColors: 24,
  minBeads: DEFAULT_QUANTIZE_OPTIONS.minBeads,
  emptyRatio: DEFAULT_QUANTIZE_OPTIONS.emptyRatio,
  alphaThreshold: DEFAULT_QUANTIZE_OPTIONS.alphaThreshold,

  title: '',
  purchase: { ...DEFAULT_PURCHASE_OPTIONS },

  busy: 'idle',
  progress: 0,
  progressStage: '',
  error: null,
  detectedReference: null,
  detectedConfidence: 0,
  timings: null,
})

/** 工作图。只用来取尺寸和驱动裁剪框，真正的像素处理都在 Worker 里。 */
export const sourceImage = shallowRef<RasterImage | null>(null)

/** 当前图纸。整体替换。 */
export const pattern = shallowRef<Pattern | null>(null)

/** 调色 + 抠图之后的预览图 */
export const previewImage = shallowRef<RasterImage | null>(null)

/** 网格被原地修改后自增，供画布侦听重绘 */
export const gridVersion = ref(0)

/** 预览图被替换后自增 */
export const previewVersion = ref(0)

// ---------------------------------------------------------------------------
// 派生状态
// ---------------------------------------------------------------------------

export const activePalette = computed(() => getPalette(state.paletteId))

export const paletteFilter = computed(() =>
  createPaletteFilter({
    activeKinds: state.activeKinds,
    excludedIds: state.excludedIds,
    excludeDiscontinued: state.excludeDiscontinued,
  }),
)

/** 参与自动配色的候选色。量化器绝不会产出这个集合之外的颜色。 */
export const candidateColors = computed<PaletteColor[]>(() =>
  selectColors(activePalette.value, paletteFilter.value),
)

export const candidateCount = computed(() => candidateColors.value.length)

/** 全图范围，作为「未裁剪」时的默认裁剪区 */
export const fullCrop = computed<CropRect>(() => ({
  x: 0,
  y: 0,
  width: state.workingWidth,
  height: state.workingHeight,
}))

export const effectiveCrop = computed<CropRect>(() => state.crop ?? fullCrop.value)

export const aspect = computed(() => {
  const c = effectiveCrop.value
  return c.height > 0 ? c.width / c.height : 1
})

export const stats = computed<PatternStats | null>(() => {
  const p = pattern.value
  if (!p) return null
  try {
    return computeStats(p, state.purchase)
  } catch {
    // 数据损坏时不要让整个界面崩掉，交给错误提示去说明
    return null
  }
})

export const hasImage = computed(() => sourceImage.value !== null)

/** 图纸里实际用到的颜色，供图例和替换颜色下拉使用 */
export const usedColors = computed(() => {
  const p = pattern.value
  if (!p) return []
  const used = new Set<number>()
  for (let i = 0; i < p.grid.length; i++) {
    const v = p.grid[i]!
    if (v >= 0) used.add(v)
  }
  return [...used]
    .sort((a, b) => a - b)
    .map((index) => ({ index, color: p.colors[index]! }))
})

// ---------------------------------------------------------------------------
// Worker 调度
// ---------------------------------------------------------------------------

let client: ConvertWorkerClient | null = null
let running = false
let pendingPreview = false
let pendingPattern = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function ensureClient(): ConvertWorkerClient | null {
  if (client) return client
  const img = sourceImage.value
  if (!img) return null

  try {
    const c = new ConvertWorkerClient()
    c.start()
    // init 会拷贝一份图给 Worker，主线程的图仍然可用
    c.init(img)
    c.onProgress((stage, ratio) => {
      state.progress = ratio
      state.progressStage = stage
    })
    client = c
    return c
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
    return null
  }
}

/**
 * 组装传给 Worker 的参数。
 *
 * **每一处都不能直接引用 `state` 里的对象。** `state` 是 `reactive` 的，
 * 取嵌套对象拿到的是 Proxy，而 Proxy 不能被结构化克隆 ——
 * postMessage 会直接抛 "could not be cloned"。
 *
 * 这个坑很阴：`state.crop` 初始是 null，走的是另一个分支，
 * 所以**第一张图能正常转换**，等用户动过裁剪框之后才开始每次都失败，
 * 看起来就像偶发的。
 *
 * 导出这个函数是为了能测 —— 「参数可以被结构化克隆」这条约束
 * 只有真的调一次 `structuredClone` 才验得出来，光看代码看不出来。
 */
export function buildParams(): WorkerParams | null {
  if (!sourceImage.value) return null
  const colors = candidateColors.value
  if (colors.length === 0) return null

  const crop = effectiveCrop.value
  const ref = state.bgReference

  return {
    rows: state.rows,
    cols: state.cols,
    // 逐字段拷成普通对象，别传 Proxy
    crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
    colors,
    sampleMode: state.sampleMode,
    maxColors: state.maxColors,
    minBeads: state.minBeads,
    emptyRatio: state.emptyRatio,
    alphaThreshold: state.alphaThreshold,
    adjustments: { ...state.adjustments },
    backgroundTolerance: state.bgEnabled ? state.bgTolerance : null,
    backgroundReference: ref ? [ref[0], ref[1], ref[2]] : null,
  }
}

/**
 * 调度器。
 *
 * 关键约束：**Worker 同时只处理一件事**。用户拖动滑块会每秒触发几十次重算，
 * 每次都投递的话任务会排成长队，用户松手后还要等好几秒才看到最终结果 ——
 * 中间那些结果全是废的。
 *
 * 所以这里只保留"最新的一次请求"：正在跑时新请求只做标记，
 * 跑完立刻拿最新参数再来一次。完整量化优先于预览，因为量化本来就会顺带产出预览。
 */
function pump(): void {
  if (running) return
  if (!client) return

  running = true
  void (async () => {
    try {
      while (pendingPreview || pendingPattern) {
        const wantPattern = pendingPattern
        pendingPattern = false
        pendingPreview = false
        await execute(wantPattern)
      }
    } finally {
      running = false
    }
  })()
}

async function execute(wantPattern: boolean): Promise<void> {
  const c = client
  const params = buildParams()

  if (!c || !params) {
    if (candidateColors.value.length === 0) {
      state.error = '当前没有可用的颜色，请在「配色」里至少启用一个颜色类别'
    }
    state.busy = 'idle'
    return
  }

  state.busy = wantPattern ? 'pattern' : 'preview'
  if (wantPattern) {
    state.progress = 0
    state.progressStage = 'sampling'
  }

  try {
    const outcome = await c.process({
      params,
      quantize: wantPattern,
      previewMaxDim: PREVIEW_MAX_DIM,
    })

    // null 表示这次请求已被更新的请求取代，结果作废
    if (!outcome) return

    if (outcome.preview) {
      previewImage.value = outcome.preview
      previewVersion.value++
    }

    state.detectedConfidence = outcome.backgroundConfidence
    if (outcome.backgroundReference) {
      state.detectedReference = outcome.backgroundReference
    }
    state.timings = outcome.timings

    if (wantPattern && outcome.pattern) {
      const next: Pattern = {
        rows: outcome.pattern.rows,
        cols: outcome.pattern.cols,
        beadSizeMm: state.beadSizeMm,
        colors: outcome.pattern.colors.map(toPatternColor),
        grid: outcome.pattern.grid,
        title: state.title,
        source: {
          fileName: state.fileName,
          width: state.originalWidth,
          height: state.originalHeight,
        },
      }
      pattern.value = next
      gridVersion.value++
    }

    state.error = null
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  } finally {
    if (!pendingPreview && !pendingPattern) state.busy = 'idle'
  }
}

/** 请求一次完整量化（防抖） */
export function schedulePattern(delay = PATTERN_DEBOUNCE_MS): void {
  pendingPattern = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    pump()
  }, delay)
}

/** 请求一次仅预览的重算（立即），用于拖动滑块时的即时反馈 */
export function schedulePreview(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingPreview = true
  pump()
}

/** 立刻跑完整量化，不等防抖 */
export function regenerateNow(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingPattern = true
  pump()
}

// ---------------------------------------------------------------------------
// 源图
// ---------------------------------------------------------------------------

export async function openImageFile(file: File): Promise<void> {
  state.error = null
  try {
    const loaded = await loadImageFile(file)
    adoptImage(loaded.working, loaded.fileName, loaded.originalWidth, loaded.originalHeight)
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  }
}

function adoptImage(
  img: RasterImage,
  fileName: string,
  originalWidth: number,
  originalHeight: number,
): void {
  // 换图必须重建 Worker：旧图像还留在里面，参数一改就会算出上一张图的结果
  client?.dispose()
  client = null

  sourceImage.value = img
  state.fileName = fileName
  state.originalWidth = originalWidth
  state.originalHeight = originalHeight
  state.workingWidth = img.width
  state.workingHeight = img.height
  state.title = fileName.replace(/\.[^.]+$/, '') || '拼豆图纸'

  resetHistory()
  pattern.value = null
  previewImage.value = null

  state.crop = null
  state.bgReference = null
  state.detectedReference = null
  state.detectedConfidence = 0
  state.adjustments = { ...DEFAULT_ADJUSTMENTS }
  state.error = null

  state.rows = DEFAULT_CELLS
  state.cols = DEFAULT_CELLS
  state.sizeDriver = 'cols'
  applySize()

  ensureClient()
  // 首屏必须给完整结果而不是只给预览 —— 用户上传后要立刻看到图纸
  regenerateNow()
}

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

/** 按当前宽高比重新解算行列数 */
function applySize(): void {
  const next: CellSize = resolveSize(
    { rows: state.rows, cols: state.cols },
    aspect.value,
    state.sizeDriver,
  )
  state.rows = next.rows
  state.cols = next.cols
}

/**
 * 参数类改动的统一入口。
 *
 * **必须在修改之前捕获还原点。** 曾把捕获放在防抖后的量化回调里，
 * 那时 `state` 上的参数早就变了，快照会变成「旧网格 + 新参数」这种
 * 自相矛盾的状态 —— 撤销回去既不还原网格也不还原参数。
 */
function paramEdit(
  label: string,
  key: string,
  mutate: () => void,
  opts: { regen?: boolean; needsPreview?: boolean; coalesce?: boolean } = {},
): void {
  const snap = captureSnapshot()
  mutate()
  if (snap) pushEntry(snap, label, key, opts.needsPreview ?? false, opts.coalesce ?? true)
  if (opts.regen ?? true) schedulePattern()
}

export function setCells(driver: SizeDriver, value: number): void {
  paramEdit('改变尺寸', 'size', () => {
    state.sizeDriver = driver
    if (driver === 'cols') state.cols = clampCells(value)
    else state.rows = clampCells(value)

    if (state.lockAspect) {
      applySize()
    } else {
      // 解锁后两维各自独立，但仍要夹到合法区间
      state.cols = clampCells(state.cols)
      state.rows = clampCells(state.rows)
    }
  })
}

export function setLockAspect(locked: boolean): void {
  if (state.lockAspect === locked) return
  paramEdit('改变尺寸', 'size', () => {
    state.lockAspect = locked
    if (locked) applySize()
  })
}

export function setBeadSize(mm: BeadSize): void {
  if (state.beadSizeMm === mm) return
  // 豆径只影响物理尺寸与图例，网格本身不变，所以不需要重算量化
  paramEdit(
    '改变豆径',
    'beadSize',
    () => {
      state.beadSizeMm = mm
      const p = pattern.value
      if (p) {
        pattern.value = { ...p, beadSizeMm: mm }
        gridVersion.value++
      }
    },
    { regen: false },
  )
}

/** 把格数吸附到底板的整数倍 */
export function snapSizeToBoard(): void {
  paramEdit('对齐底板', 'size', () => {
    state.sizeDriver = 'cols'
    state.cols = snapToBoard(state.cols, state.boardSize)
    if (state.lockAspect) applySize()
    else state.rows = snapToBoard(state.rows, state.boardSize)
  })
}

export function setCrop(rect: CropRect | null): void {
  paramEdit(
    '裁剪',
    'crop',
    () => {
      state.crop = rect
      // 裁剪改的是宽高比，锁定时行数要跟着新比例走
      if (state.lockAspect) applySize()
    },
    { needsPreview: true, coalesce: false },
  )
}

export function resetCrop(): void {
  setCrop(null)
}

// ---------------------------------------------------------------------------
// 影调 / 抠图 / 色卡
// ---------------------------------------------------------------------------

export function setAdjustments(next: Partial<Adjustments>): void {
  paramEdit(
    '调整影调',
    'adjust',
    () => {
      Object.assign(state.adjustments, next)
    },
    { needsPreview: true },
  )
}

export function resetAdjustments(): void {
  paramEdit(
    '重置影调',
    'adjust',
    () => {
      state.adjustments = { ...DEFAULT_ADJUSTMENTS }
    },
    { needsPreview: true, coalesce: false },
  )
}

/**
 * 滑块的「拖动中」与「松手」两段式处理。
 *
 * 拖动滑块每秒会触发几十次变化。每次都走 `paramEdit` 会有两个问题：
 * 一是每次都跑完整量化，任务排队排到用户松手之后；二是每次都记一个还原点，
 * 撤销时要按几十次才能退回去。
 *
 * 所以拆成两段：拖动中只改参数 + 重画预览（预览图小、算得快，够用户看清效果），
 * 松手时才记一个还原点并跑完整量化。还原点由 `beginLive` 在**第一次**拖动时
 * 捕获，也就是整段拖动之前的状态 —— 撤销一步退回拖动前。
 */
let liveSnapshot: Snapshot | null = null

function beginLive(): void {
  if (!liveSnapshot) liveSnapshot = captureSnapshot()
}

function commitLive(label: string, key: string): void {
  const snap = liveSnapshot
  liveSnapshot = null
  if (snap) pushEntry(snap, label, key, true, false)
  schedulePattern(0)
}

/** 丢弃未提交的拖动快照（撤销/重做/换图时必须调用） */
function dropLive(): void {
  liveSnapshot = null
}

function clampRange(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.max(lo, Math.min(hi, v))
}

export function previewAdjustments(next: Partial<Adjustments>): void {
  beginLive()
  Object.assign(state.adjustments, next)
  schedulePreview()
}

export function previewBackgroundTolerance(value: number): void {
  beginLive()
  state.bgTolerance = clampRange(Math.round(value), 0, 255, 32)
  schedulePreview()
}

export function previewQuantizeParams(next: {
  maxColors?: number
  minBeads?: number
  emptyRatio?: number
  alphaThreshold?: number
}): void {
  beginLive()
  if (next.maxColors !== undefined) {
    state.maxColors = clampRange(Math.round(next.maxColors), 2, 64, 24)
  }
  if (next.minBeads !== undefined) {
    state.minBeads = clampRange(Math.round(next.minBeads), 1, 10000, 1)
  }
  if (next.emptyRatio !== undefined) {
    state.emptyRatio = clampRange(next.emptyRatio, 0, 1, 0)
  }
  if (next.alphaThreshold !== undefined) {
    state.alphaThreshold = clampRange(Math.round(next.alphaThreshold), 0, 255, 128)
  }
  schedulePreview()
}

export function commitAdjustments(label = '调整影调'): void {
  commitLive(label, 'adjust')
}

export function commitQuantize(): void {
  commitLive('调整配色', 'quantize')
}

export function commitBackground(): void {
  commitLive('背景容差', 'background')
}

export function setBackground(enabled: boolean): void {
  paramEdit(
    '去背景',
    'background',
    () => {
      state.bgEnabled = enabled
    },
    { needsPreview: true, coalesce: false },
  )
}

export function setBackgroundTolerance(value: number): void {
  paramEdit(
    '背景容差',
    'background',
    () => {
      state.bgTolerance = Math.max(0, Math.min(255, Math.round(value)))
    },
    { needsPreview: true },
  )
}

/** 吸管选色。传 null 恢复自动推断。 */
export function setBackgroundReference(rgb: RGB | null): void {
  paramEdit(
    '指定背景色',
    'background',
    () => {
      state.bgReference = rgb
      if (rgb && !state.bgEnabled) state.bgEnabled = true
    },
    { needsPreview: true, coalesce: false },
  )
}

export function setPalette(id: string): void {
  if (state.paletteId === id) return
  paramEdit(
    '切换色卡',
    'palette',
    () => {
      state.paletteId = id
      // 各色卡的色号体系不通用，手动排除项必须清掉
      state.excludedIds = []

      // 各色卡有的类别不一样（MARD 291 有温变/光变，其余都没有）。
      // 不清理的话，新色卡上没有的类别会继续留在 activeKinds 里：
      // 界面上那个类别 chip 消失了，但过滤条件还在，用户看到的可用色数
      // 会比他自己数出来的少，且无从解释。
      const available = new Set(getPalette(id).colors.map((c) => c.kind))
      state.activeKinds = state.activeKinds.filter((k) => available.has(k))
      // 兜底：一个都不剩就等于没有候选色，用户会拿到一张空图纸
      if (state.activeKinds.length === 0) state.activeKinds = ['solid']
    },
    { coalesce: false },
  )
}

export function setActiveKinds(kinds: PaletteColorKind[]): void {
  paramEdit(
    '启用颜色类别',
    'kinds',
    () => {
      state.activeKinds = [...kinds]
    },
    { coalesce: false },
  )
}

export function toggleKind(kind: PaletteColorKind): void {
  const set = new Set(state.activeKinds)
  if (set.has(kind)) set.delete(kind)
  else set.add(kind)
  setActiveKinds([...set])
}

export function toggleExcluded(colorId: string): void {
  const set = new Set(state.excludedIds)
  if (set.has(colorId)) set.delete(colorId)
  else set.add(colorId)
  setExcludedIds([...set])
}

export function setExcludedIds(ids: string[]): void {
  paramEdit(
    '排除颜色',
    'excluded',
    () => {
      state.excludedIds = [...ids]
    },
    { coalesce: false },
  )
}

export function setQuantizeParams(next: {
  sampleMode?: SampleMode
  maxColors?: number
  minBeads?: number
  emptyRatio?: number
  alphaThreshold?: number
}): void {
  paramEdit('调整配色', 'quantize', () => {
    Object.assign(state, next)
  })
}

export function setPurchase(next: Partial<PurchaseOptions>): void {
  Object.assign(state.purchase, next)
}

export function setTitle(title: string): void {
  state.title = title
  const p = pattern.value
  if (p) pattern.value = { ...p, title }
}

export function setBoardSize(size: number): void {
  state.boardSize = Math.max(2, Math.round(size))
}

// ---------------------------------------------------------------------------
// 网格编辑
// ---------------------------------------------------------------------------

export type EditTool = 'brush' | 'fill' | 'erase'

export const tool = ref<EditTool>('brush')

/**
 * 画笔颜色，存 `PaletteColor.id` 而不是下标 ——
 * 下标会随颜色增减漂移，用户拖一次画笔就可能画错颜色。
 */
export const brushColorId = ref<string | null>(null)

/** 给每次笔画一个唯一 key，两笔之间永不被合并 */
let strokeSeq = 0

/** 找到某个颜色在图纸里的下标，没有就追加进去 */
function ensureColorIndex(color: PatternColor): number {
  const p = pattern.value
  if (!p) return -1

  const found = p.colors.findIndex((c) => c.id === color.id)
  if (found >= 0) return found

  p.colors.push({ ...color })
  return p.colors.length - 1
}

/** 找到画笔指向的颜色在图纸里的下标，必要时把该颜色加入图纸 */
export function resolveBrush(): { color: PatternColor; index: number } | null {
  const p = pattern.value
  const id = brushColorId.value
  if (!p || !id) return null

  const existing = p.colors.findIndex((c) => c.id === id)
  if (existing >= 0) return { color: p.colors[existing]!, index: existing }

  const candidate = candidateColors.value.find((c) => c.id === id)
  if (!candidate) return null

  const color = toPatternColor(candidate)
  return { color, index: ensureColorIndex(color) }
}

export function paintCell(row: number, col: number): void {
  const p = pattern.value
  if (!p) return
  if (row < 0 || col < 0 || row >= p.rows || col >= p.cols) return

  const i = row * p.cols + col

  if (tool.value === 'erase') {
    if (p.grid[i] === -1) return
    p.grid[i] = -1
    gridVersion.value++
    return
  }

  const brush = resolveBrush()
  if (!brush) return
  if (p.grid[i] === brush.index) return

  p.grid[i] = brush.index
  gridVersion.value++
}

/**
 * 油漆桶填充。
 *
 * 用显式栈而不是递归：300×300 的图纸全填时递归深度会到几万层，必然爆栈。
 * 四邻域而不是八邻域 —— 八邻域会从对角线的缝隙漏出去，在一格宽的细线上表现很怪。
 */
export function fillCells(row: number, col: number): void {
  const p = pattern.value
  if (!p) return
  if (row < 0 || col < 0 || row >= p.rows || col >= p.cols) return

  const target = p.grid[row * p.cols + col]!
  const replacement = tool.value === 'erase' ? -1 : resolveBrush()?.index ?? null
  if (replacement === null || target === replacement) return

  const stack: number[] = [row * p.cols + col]
  const seen = new Uint8Array(p.rows * p.cols)

  while (stack.length > 0) {
    const i = stack.pop()!
    if (seen[i]) continue
    seen[i] = 1
    if (p.grid[i] !== target) continue

    p.grid[i] = replacement

    const r = (i / p.cols) | 0
    const c = i % p.cols
    if (r > 0) stack.push(i - p.cols)
    if (r < p.rows - 1) stack.push(i + p.cols)
    if (c > 0) stack.push(i - 1)
    if (c < p.cols - 1) stack.push(i + 1)
  }

  gridVersion.value++
}

/** 把图纸里某个颜色整体换成另一个颜色；toColorId 为 null 表示清除 */
export function replaceColor(fromIndex: number, toColorId: string | null): void {
  const p = pattern.value
  if (!p) return

  let to = -1
  if (toColorId !== null) {
    const candidate = candidateColors.value.find((c) => c.id === toColorId)
    if (candidate) {
      to = ensureColorIndex(toPatternColor(candidate))
    } else {
      to = p.colors.findIndex((c) => c.id === toColorId)
      if (to < 0) return
    }
  }
  if (fromIndex === to) return

  for (let i = 0; i < p.grid.length; i++) {
    if (p.grid[i] === fromIndex) p.grid[i] = to
  }
  gridVersion.value++
}

/** 清空所有格子（保留颜色表） */
export function clearAll(): void {
  const p = pattern.value
  if (!p) return
  p.grid.fill(-1)
  gridVersion.value++
}

/**
 * 一笔的起止。
 *
 * 拖动涂抹过程中 `paintCell` 会被调用几十上百次，每次都记一步撤销的话
 * 用户要按上百次 Ctrl+Z 才能退回原状。所以整笔只在**按下时**记一个还原点、
 * **抬起时**压入历史。
 */
let strokeSnapshot: Snapshot | null = null

export function beginStroke(): void {
  strokeSnapshot = captureSnapshot()
}

export function endStroke(): void {
  if (strokeSnapshot) {
    pushEntry(strokeSnapshot, describeStroke(), `stroke:${++strokeSeq}`, false, false)
  }
  strokeSnapshot = null
}

/** 放弃当前这一笔的还原点（例如按下后没做任何修改） */
export function cancelStroke(): void {
  strokeSnapshot = null
}

function describeStroke(): string {
  if (tool.value === 'erase') return '擦除'
  if (tool.value === 'fill') return '填充'
  return '上色'
}

// ---------------------------------------------------------------------------
// 历史（撤销 / 重做）
// ---------------------------------------------------------------------------

interface ParamSnapshot {
  rows: number
  cols: number
  beadSizeMm: BeadSize
  paletteId: string
  activeKinds: PaletteColorKind[]
  excludedIds: string[]
  excludeDiscontinued: boolean
  sampleMode: SampleMode
  maxColors: number
  minBeads: number
  emptyRatio: number
  alphaThreshold: number
  adjustments: Adjustments
  bgEnabled: boolean
  bgTolerance: number
  bgReference: RGB | null
  crop: CropRect | null
}

/** 一份完整可还原的状态 */
interface Snapshot {
  grid: Int16Array
  colors: PatternColor[]
  rows: number
  cols: number
  params: ParamSnapshot
}

interface HistoryEntry extends Snapshot {
  label: string
  key: string
  at: number
  /** 还原后是否需要重刷预览（影调/抠图/裁剪类改动需要，纯笔刷不需要） */
  needsPreview: boolean
}

/**
 * 历史里存的是**改动之前**的状态。
 *
 * 这样撤销 = 把栈顶那一步的"之前"取出来还原，语义直接。
 * 反过来存"之后"的话，第一次编辑就没有可回退的目标，
 * 用户会发现第一笔画错了撤不掉。
 */
const past = shallowRef<HistoryEntry[]>([])
const future = shallowRef<HistoryEntry[]>([])

/**
 * 压入一个还原点。
 *
 * @param coalesce 连续的同类改动是否合并。拖滑块时每秒会触发几十次参数变化，
 *                 不合并的话松下手指就要按几十次撤销才能退回去。
 *                 合并的做法是**保留更早的那个还原点**，直接丢弃新的 ——
 *                 因为更早的那个才真正代表"这轮改动之前"。
 */
function pushEntry(
  snap: Snapshot,
  label: string,
  key: string,
  needsPreview: boolean,
  coalesce: boolean,
): void {
  const top = past.value[past.value.length - 1]
  const now = Date.now()

  if (coalesce && top && top.key === key && now - top.at < HISTORY_COALESCE_MS) {
    return
  }

  const entry: HistoryEntry = { ...snap, label, key, at: now, needsPreview }
  const next = [...past.value, entry]
  past.value = next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next

  // 任何新操作都会清空重做栈，这是编辑器的通行语义
  if (future.value.length > 0) future.value = []
}

export const canUndo = computed(() => past.value.length > 0)
export const canRedo = computed(() => future.value.length > 0)
export const undoLabel = computed(() => past.value[past.value.length - 1]?.label ?? '')
export const redoLabel = computed(() => future.value[future.value.length - 1]?.label ?? '')

function snapshotParams(): ParamSnapshot {
  return {
    rows: state.rows,
    cols: state.cols,
    beadSizeMm: state.beadSizeMm,
    paletteId: state.paletteId,
    activeKinds: [...state.activeKinds],
    excludedIds: [...state.excludedIds],
    excludeDiscontinued: state.excludeDiscontinued,
    sampleMode: state.sampleMode,
    maxColors: state.maxColors,
    minBeads: state.minBeads,
    emptyRatio: state.emptyRatio,
    alphaThreshold: state.alphaThreshold,
    adjustments: { ...state.adjustments },
    bgEnabled: state.bgEnabled,
    bgTolerance: state.bgTolerance,
    bgReference: state.bgReference ? ([...state.bgReference] as RGB) : null,
    crop: state.crop ? { ...state.crop } : null,
  }
}

/** 捕获当前状态。没有图纸时返回 null —— 那种状态下没什么可还原的。 */
function captureSnapshot(): Snapshot | null {
  const p = pattern.value
  if (!p) return null
  return {
    grid: new Int16Array(p.grid),
    colors: p.colors.map((c) => ({ ...c })),
    rows: p.rows,
    cols: p.cols,
    params: snapshotParams(),
  }
}

function applySnapshot(s: Snapshot): void {
  const p = pattern.value
  const params = s.params

  state.rows = params.rows
  state.cols = params.cols
  state.beadSizeMm = params.beadSizeMm
  state.paletteId = params.paletteId
  state.activeKinds = [...params.activeKinds]
  state.excludedIds = [...params.excludedIds]
  state.excludeDiscontinued = params.excludeDiscontinued
  state.sampleMode = params.sampleMode
  state.maxColors = params.maxColors
  state.minBeads = params.minBeads
  state.emptyRatio = params.emptyRatio
  state.alphaThreshold = params.alphaThreshold
  state.adjustments = { ...params.adjustments }
  state.bgEnabled = params.bgEnabled
  state.bgTolerance = params.bgTolerance
  state.bgReference = params.bgReference ? ([...params.bgReference] as RGB) : null
  state.crop = params.crop ? { ...params.crop } : null

  if (p) {
    pattern.value = {
      rows: s.rows,
      cols: s.cols,
      beadSizeMm: params.beadSizeMm,
      colors: s.colors.map((c) => ({ ...c })),
      grid: new Int16Array(s.grid),
      title: state.title,
      source: p.source,
    }
    gridVersion.value++
  }
}

export function undo(): void {
  const stack = past.value
  if (stack.length === 0) return

  const entry = stack[stack.length - 1]!
  const current = captureSnapshot()

  past.value = stack.slice(0, -1)
  if (current) {
    future.value = [...future.value, { ...current, label: entry.label, key: entry.key, at: Date.now(), needsPreview: entry.needsPreview }]
  }
  cancelStroke()
  dropLive()
  applySnapshot(entry)
  // 影调/抠图类改动还原的是参数，预览图得跟着回去；纯笔刷不需要重算
  if (entry.needsPreview) schedulePreview()
}

export function redo(): void {
  const stack = future.value
  if (stack.length === 0) return

  const entry = stack[stack.length - 1]!
  const current = captureSnapshot()

  future.value = stack.slice(0, -1)
  if (current) {
    past.value = [...past.value, { ...current, label: entry.label, key: entry.key, at: Date.now(), needsPreview: entry.needsPreview }]
  }
  cancelStroke()
  dropLive()
  applySnapshot(entry)
  if (entry.needsPreview) schedulePreview()
}

export function resetHistory(): void {
  past.value = []
  future.value = []
  cancelStroke()
  dropLive()
}

// ---------------------------------------------------------------------------
// 图纸文件（保存 / 打开）
// ---------------------------------------------------------------------------

/**
 * 打开一份图纸文件。
 *
 * 打开的是**已经画好的成品**，不是待转换的原图，所以要把 Worker 和源图
 * 全部清掉 —— 否则用户打开旧图纸后再动一下尺寸滑块，界面会突然跳回
 * 那张早就换掉的原图，非常费解。
 *
 * 颜色表直接来自文件本身而不是查色卡：图纸必须自包含，
 * 就算色卡数据以后改了版，用户三个月前存的图纸也要原样打开。
 */
export function loadPatternFile(text: string): void {
  state.error = null
  try {
    const parsed = parsePatternFile(text)

    client?.dispose()
    client = null

    sourceImage.value = null
    previewImage.value = null
    state.fileName = ''
    state.workingWidth = 0
    state.workingHeight = 0
    state.originalWidth = parsed.pattern.source?.width ?? 0
    state.originalHeight = parsed.pattern.source?.height ?? 0
    state.crop = null
    state.detectedReference = null
    state.detectedConfidence = 0
    state.timings = null
    state.busy = 'idle'

    state.rows = parsed.pattern.rows
    state.cols = parsed.pattern.cols
    state.beadSizeMm = parsed.pattern.beadSizeMm
    state.title = parsed.pattern.title
    state.sizeDriver = 'cols'

    if (parsed.generation) {
      const g = parsed.generation
      state.sampleMode = g.sampleMode as SampleMode
      state.maxColors = g.maxColors
      state.minBeads = g.minBeads
      state.adjustments = { ...g.adjustments }
    }

    resetHistory()
    pattern.value = parsed.pattern
    gridVersion.value++
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 当前图纸的生成参数快照。
 *
 * 本地下载与云端保存都要把它写进工程文件，这样图纸能"复现"；
 * 两处各写一遍迟早会对不上，所以只留这一个出口。
 */
export function generationParams(): PatternGenerationParams | undefined {
  const p = pattern.value
  if (p === null) return undefined
  return {
    sampleMode: state.sampleMode,
    maxColors: state.maxColors,
    minBeads: state.minBeads,
    rows: p.rows,
    cols: p.cols,
    crop: state.crop ?? {
      x: 0,
      y: 0,
      width: state.workingWidth,
      height: state.workingHeight,
    },
    backgroundTolerance: state.bgEnabled ? state.bgTolerance : null,
    adjustments: { ...state.adjustments },
  }
}
