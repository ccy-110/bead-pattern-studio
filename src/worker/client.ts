import type { RasterImage } from '../core/imaging/types'
import type { RGB } from '../core/color/types'
import type { PaletteColor } from '../core/palette/types'
import type { WorkerParams, WorkerRequest, WorkerResponse } from './protocol'

/**
 * Worker 的主线程代理。
 *
 * 负责三件事：把请求排队、丢弃过期响应、把进度和错误转成回调。
 *
 * ## 过期响应为什么必须丢
 *
 * 用户拖动滑块时会连续发出十几个请求，Worker 按顺序逐个算完。
 * 如果每个响应都去更新界面，用户看到的就是"回放"——画面从旧状态一路跳到新状态，
 * 而且最后停在的未必是最新的那个参数。因此每个请求带递增 token，
 * 新请求一发出就把旧请求标记作废，客户端只认最新的那个。
 */

export type ProgressStage = 'sampling' | 'matching' | 'reducing'

export interface ProcessRequest {
  params: WorkerParams
  /** 是否执行网格量化。false 时只出预览图，用于拖动滑块时的即时反馈。 */
  quantize: boolean
  /** 预览图最大边长。0 表示不要预览图。 */
  previewMaxDim: number
}

export interface ProcessOutcome {
  pattern: {
    rows: number
    cols: number
    grid: Int16Array
    colors: PaletteColor[]
    rawColorCount: number
    emptyCount: number
  } | null
  preview: RasterImage | null
  backgroundReference: RGB | null
  backgroundConfidence: number
  timings: { adjust: number; background: number; quantize: number; preview: number }
}

export interface BackgroundAnalysisOutcome {
  /** null = 没能从边缘推断出可用的背景色，需要用户用吸管指定 */
  reference: RGB | null
  confidence: number
}

/**
 * 池子里同时躺着 process 和 analyze 两种结果。
 * 内部统一按并集存，两个公开方法各自在出口处收窄 ——
 * 出口的断言是安全的，因为 `process()` 只会发出产生 ProcessOutcome 的消息。
 * 这样比把 resolve 塞成 `any` 或拆成两个 Map 都更诚实。
 */
type WorkerOutcome = ProcessOutcome | BackgroundAnalysisOutcome | null

interface PendingEntry {
  resolve: (value: WorkerOutcome) => void
  reject: (err: Error) => void
}

export class ConvertWorkerClient {
  private worker: Worker | null = null
  private nextToken = 1
  private latestToken = 0
  private pending = new Map<number, PendingEntry>()

  private progressHandler: ((stage: ProgressStage, ratio: number) => void) | null = null

  /** 启动 Worker。失败时抛出的错误已经是可以直接展示给用户的中文文案。 */
  start(): void {
    if (this.worker) return

    try {
      this.worker = new Worker(new URL('./convert.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      throw new Error(
        '当前浏览器不支持 Web Worker（或处于受限的隐私模式），无法进行图像处理。',
      )
    }

    this.worker.onmessage = (e: MessageEvent) =>
      this.handleMessage(e.data as WorkerResponse)

    this.worker.onerror = () => {
      this.rejectAll(new Error('图像处理线程异常退出，请刷新页面重试'))
    }
  }

  /**
   * 送入工作图。会拷贝一份再转移给 Worker，
   * 因此调用方可以继续持有原图（预览缩放、裁剪框都要用它的尺寸）。
   */
  init(image: RasterImage): void {
    if (!this.worker) throw new Error('Worker 尚未启动')
    const payload: WorkerRequest = {
      type: 'init',
      data: image.data.slice().buffer,
      width: image.width,
      height: image.height,
    }
    this.worker.postMessage(payload)
  }

  onProgress(handler: ((stage: ProgressStage, ratio: number) => void) | null): void {
    this.progressHandler = handler
  }

  /**
   * 发起一次处理。
   *
   * 被更新的请求超越时返回 `null`（而不是抛错）——
   * 调用方只需 `if (!outcome) return`，不必写 try/catch。
   */
  process(req: ProcessRequest): Promise<ProcessOutcome | null> {
    return this.send({
      type: 'process',
      token: 0,
      params: req.params,
      quantize: req.quantize,
      previewMaxDim: req.previewMaxDim,
    }) as Promise<ProcessOutcome | null>
  }

  /** 只重新推断背景色，不跑量化 */
  analyzeBackground(
    adjustments: WorkerParams['adjustments'],
  ): Promise<BackgroundAnalysisOutcome | null> {
    return this.send({
      type: 'analyze',
      token: 0,
      adjustments,
    }) as Promise<BackgroundAnalysisOutcome | null>
  }

  /** 作废所有在途请求：调用方的 promise 会以 `null` 结束 */
  cancelPending(): void {
    this.rejectAll(null)
  }

  dispose(): void {
    this.rejectAll(null)
    this.worker?.terminate()
    this.worker = null
  }

  private send(msg: WorkerRequest): Promise<WorkerOutcome> {
    if (!this.worker) return Promise.reject(new Error('Worker 尚未启动'))

    const token = this.nextToken++

    // 先作废旧请求再登记新请求：旧请求的 promise 以 null 结束，
    // 调用方据此知道"这次的结果不用管了"
    this.rejectAll(null)
    this.latestToken = token

    return new Promise<WorkerOutcome>((resolve, reject) => {
      this.pending.set(token, { resolve, reject })
      try {
        this.worker!.postMessage({ ...msg, token })
      } catch (err) {
        // 结构化克隆失败，最常见的原因是参数里混进了 Vue 的 reactive 代理。
        // 浏览器原生的报错是 "could not be cloned"，用户看了完全不知道发生了什么；
        // 而且必须在这里自己收尾 —— 待决项不清掉的话，调用方会永远等不到结果，
        // 界面就卡在"正在生成"上了。
        console.error('[worker] 参数无法结构化克隆，检查是否传入了响应式对象', err)
        this.pending.delete(token)
        reject(new Error('处理参数异常，本次转换没有执行。请刷新页面后重试。'))
      }
    })
  }

  private handleMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'progress':
        if (msg.token === this.latestToken) {
          this.progressHandler?.(msg.stage, msg.ratio)
        }
        return

      case 'error': {
        const entry = this.pending.get(msg.token)
        this.pending.delete(msg.token)
        entry?.reject(new Error(msg.message))
        return
      }

      case 'result': {
        const entry = this.take(msg.token)
        if (!entry) return

        entry.resolve({
          pattern: msg.pattern
            ? {
                rows: msg.pattern.rows,
                cols: msg.pattern.cols,
                grid: new Int16Array(msg.pattern.grid),
                colors: msg.pattern.colors,
                rawColorCount: msg.pattern.rawColorCount,
                emptyCount: msg.pattern.emptyCount,
              }
            : null,
          preview: msg.preview
            ? {
                width: msg.preview.width,
                height: msg.preview.height,
                data: new Uint8ClampedArray(msg.preview.data),
              }
            : null,
          backgroundReference: toRgb(msg.backgroundReference),
          backgroundConfidence: msg.backgroundConfidence,
          timings: msg.timings,
        })
        return
      }

      case 'analyzeResult': {
        const entry = this.take(msg.token)
        if (!entry) return

        // 推断不出来也要 resolve：直接 return 会让调用方的 promise 永远悬着，
        // 界面就卡在"正在识别背景"上了
        entry.resolve({
          reference: toRgb(msg.backgroundReference),
          confidence: msg.backgroundConfidence,
        })
        return
      }
    }
  }

  /** 取出待决项。过期结果返回 null，调用方据此忽略。 */
  private take(token: number): PendingEntry | null {
    const entry = this.pending.get(token)
    this.pending.delete(token)
    if (!entry) return null
    if (token !== this.latestToken) {
      entry.resolve(null)
      return null
    }
    return entry
  }

  private rejectAll(err: Error | null): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (err) entry.reject(err)
      else entry.resolve(null)
    }
  }
}

function toRgb(v: readonly [number, number, number] | null): RGB | null {
  return v ? [v[0], v[1], v[2]] : null
}
