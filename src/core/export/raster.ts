import type { Pattern } from '../pattern/types'
import { computeGridLayout, renderPattern } from '../render/grid'
import type { GridMode, GridRenderOptions } from '../render/grid'

export interface RasterExportOptions {
  mode: GridMode
  showRuler: boolean
  majorEvery: number
  showCode: boolean
  /** 每格多少像素。不传则按 targetWidth 反推。 */
  cellSize?: number
  /** 目标总宽度（像素），仅在未指定 cellSize 时生效 */
  targetWidth?: number
  /** 单格像素上限，防止 200×200 的图导出成 12800px 的画布 */
  maxCellSize?: number
}

/** 单张画布的像素上限。各浏览器不一致，1.6 亿像素在多数设备上还算安全。 */
const MAX_PIXELS = 160_000_000

/**
 * 把图纸画到离屏画布。
 *
 * 导出与屏幕预览共用 `renderPattern`，这是刻意的：
 * 布局逻辑一旦有两份实现，导出的图和屏幕上看到的会慢慢长歪，
 * 而用户是照着导出的图去摆豆子的。
 */
export function renderToCanvas(
  pattern: Pattern,
  options: RasterExportOptions,
): HTMLCanvasElement {
  const cellSize = resolveExportCellSize(pattern.rows, pattern.cols, options)

  const gridOpts: GridRenderOptions = {
    cellSize,
    mode: options.mode,
    showRuler: options.showRuler,
    majorEvery: options.majorEvery,
    detail: options.showCode ? 'auto' : 'none',
    emptyColor: '#ffffff',
    backgroundColor: '#ffffff',
    highlight: null,
    highlightColor: '#e8590c',
  }

  const layout = computeGridLayout(pattern.rows, pattern.cols, gridOpts)
  const canvas = document.createElement('canvas')
  canvas.width = layout.totalWidth
  canvas.height = layout.totalHeight

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文，可能是显存不足')

  // 导出图不需要 devicePixelRatio 缩放，一个画布像素就是一个导出像素
  renderPattern(ctx, pattern, { ...gridOpts, detail: layout.detail })
  return canvas
}

/**
 * 决定导出时每格多少像素。
 *
 * 独立出来是为了能单独测试 —— 这里有两个容易被忽略的硬约束：
 * 格子上限（太大没意义）和**总像素上限**。
 * 后者是真会出事的：200×200 的图纸在 64px/格下是 1.6 亿像素，
 * 超出部分浏览器会静默产出一张全白画布，用户拿到一张白图还不知道为什么。
 */
export function resolveExportCellSize(
  rows: number,
  cols: number,
  options: Pick<RasterExportOptions, 'cellSize' | 'targetWidth' | 'maxCellSize'> = {},
): number {
  const maxCell = options.maxCellSize ?? 64
  const raw =
    options.cellSize !== undefined ? options.cellSize : (options.targetWidth ?? 2400) / cols
  return clampCell(raw, rows, cols, maxCell)
}

export function clampCell(
  cell: number,
  rows: number,
  cols: number,
  maxCell = 64,
): number {
  if (!Number.isFinite(cell) || cell <= 0) return 8

  // 一律取整：格子尺寸带小数会让每条网格线落在半个像素上，
  // 导出的图整体发虚，而且越往右下累积偏移越大
  const size = Math.max(2, Math.floor(Math.min(maxCell, cell)))

  const pixels = rows * cols * size * size
  if (pixels <= MAX_PIXELS) return size

  return Math.max(2, Math.floor(Math.sqrt(MAX_PIXELS / (rows * cols))))
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('导出 PNG 失败，图片可能超出了浏览器的大小限制'))
    }, 'image/png')
  })
}

/** 画布转 data URL，用于图纸文件内嵌缩略图 */
export function canvasToThumbnail(canvas: HTMLCanvasElement, maxDim = 240): string | null {
  try {
    const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height))
    if (scale >= 1) return canvas.toDataURL('image/png')

    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.round(canvas.width * scale))
    small.height = Math.max(1, Math.round(canvas.height * scale))
    const ctx = small.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(canvas, 0, 0, small.width, small.height)
    return small.toDataURL('image/png')
  } catch {
    // 缩略图只是锦上添花，失败不该影响保存主流程
    return null
  }
}
