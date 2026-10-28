import { ConversionPipeline } from '../core/pipeline'
import type { RasterImage } from '../core/imaging/types'
import type { WorkerRequest, WorkerResponse } from './protocol'

/**
 * 量化 Worker。
 *
 * 把整条转换管线搬离主线程，否则 1600×1600 的图每调一次参数就会卡住界面
 * 一两百毫秒，滑滑块时手感会非常糟。
 *
 * 这个文件只做两件事：收发消息、把 ArrayBuffer 转成管线要的形态。
 * **所有实际计算都在 `core/pipeline` 里**，那样才测得动 ——
 * 逻辑长在 `onmessage` 里的时候，连"抠完背景还剩几颗豆"都验证不了。
 */

interface DedicatedWorkerScope {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const worker = self as unknown as DedicatedWorkerScope

let pipeline: ConversionPipeline | null = null

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  worker.postMessage(msg, transfer)
}

function fail(token: number, err: unknown): void {
  post({ type: 'error', token, message: err instanceof Error ? err.message : String(err) })
}

function handleProcess(msg: Extract<WorkerRequest, { type: 'process' }>): void {
  const { token, params, quantize, previewMaxDim } = msg

  if (!pipeline) throw new Error('尚未接收图像数据，请先发送 init')

  const result = pipeline.run(params, quantize, previewMaxDim, (stage, ratio) =>
    post({ type: 'progress', token, stage, ratio }),
  )

  // Transferable 会转移所有权，所以栅格和预览缓冲必须是独立的一份，
  // 不能是管线内部还在用的数组 —— 转移之后那边就变成空的了。
  const gridBuf = result.pattern ? new Int16Array(result.pattern.grid).buffer : null
  const previewBuf = result.preview
    ? new Uint8ClampedArray(result.preview.data).buffer
    : null

  const transfer: Transferable[] = []
  if (gridBuf) transfer.push(gridBuf)
  if (previewBuf) transfer.push(previewBuf)

  post(
    {
      type: 'result',
      token,
      pattern:
        result.pattern && gridBuf
          ? {
              grid: gridBuf,
              rows: result.pattern.rows,
              cols: result.pattern.cols,
              colors: result.pattern.colors,
              rawColorCount: result.pattern.rawColorCount,
              emptyCount: result.pattern.emptyCount,
            }
          : null,
      preview:
        result.preview && previewBuf
          ? {
              data: previewBuf,
              width: result.preview.width,
              height: result.preview.height,
            }
          : null,
      backgroundReference: result.backgroundReference,
      backgroundConfidence: result.backgroundConfidence,
      timings: result.timings,
    },
    transfer,
  )
}

worker.onmessage = (e: MessageEvent) => {
  const msg = e.data as WorkerRequest

  try {
    switch (msg.type) {
      case 'init': {
        const data = new Uint8ClampedArray(msg.data)
        const image: RasterImage = { width: msg.width, height: msg.height, data }
        // 换图就整体重建：旧图的背景分析缓存留着会算出上一张图的结果
        pipeline = new ConversionPipeline(image)
        break
      }

      case 'analyze': {
        if (!pipeline) throw new Error('尚未接收图像数据，请先发送 init')
        const a = pipeline.analyze(msg.adjustments)
        post({
          type: 'analyzeResult',
          token: msg.token,
          backgroundReference: a.reference,
          backgroundConfidence: a.confidence,
        })
        break
      }

      case 'process': {
        handleProcess(msg)
        break
      }
    }
  } catch (err) {
    fail('token' in msg ? msg.token : 0, err)
  }
}
