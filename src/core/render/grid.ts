import type { Pattern } from '../pattern/types'
import { contrastTextColor } from '../pattern/symbols'
import { planCellLabels } from './label'

/** 渲染模式 */
export type GridMode =
  /** 彩色图纸：格子填色 + 可选色号/符号 */
  | 'color'
  /** 黑白符号图纸：白底 + 符号，专供黑白打印 */
  | 'symbol'
  /** 线稿图纸：白底 + 网格线，供对照数格 */
  | 'outline'

export type CellDetail = 'none' | 'symbol' | 'code' | 'auto'

/**
 * 图纸的一个矩形子区域，区间为半开 `[start, end)`。
 *
 * 两个地方要用到它：打印分页（把大图切成若干页），
 * 以及屏幕上的视口裁剪（只画看得见的那部分）。
 */
export interface GridRegion {
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}

export interface GridRenderOptions {
  /** 单格边长（CSS 像素） */
  cellSize: number
  mode: GridMode
  /** 每隔几格画一条加粗线。0 表示不加粗。默认 5。 */
  majorEvery: number
  /** 是否绘制行列标尺 */
  showRuler: boolean
  /** 格子里显示什么 */
  detail: CellDetail
  /** 空格子的填充色 */
  emptyColor: string
  /** 背景色 */
  backgroundColor: string
  /** 高亮的格子（悬停/选中） */
  highlight?: { row: number; col: number } | null
  /** 高亮色 */
  highlightColor: string
  /** 用色号还是符号做图例编号，仅影响 detail = 'code' 时的回退 */
  title?: string
  /**
   * 只绘制这个区域内的内容，其余跳过。省略则画全图。
   *
   * 屏幕上必须传它：100×100 的图纸是 10000 个 `fillRect`，
   * 300×300 就是 90000 个 —— 即使绝大部分落在画布外被裁掉，
   * JS 这一侧的调用开销依然要几十毫秒，涂抹时会明显跟手不上。
   * 只遍历可见的那几十行几十列，代价就与图纸总尺寸无关了。
   *
   * 注意绘制坐标仍是**图纸绝对坐标**，调用方要靠 ctx 变换把它移到视口里。
   */
  region?: GridRegion
}

/** 把区域夹到图纸范围内，顺便处理取整 */
function clampRegion(
  region: GridRegion | undefined,
  rows: number,
  cols: number,
): GridRegion {
  if (!region) return { rowStart: 0, rowEnd: rows, colStart: 0, colEnd: cols }
  return {
    rowStart: Math.max(0, Math.min(rows, Math.floor(region.rowStart))),
    rowEnd: Math.max(0, Math.min(rows, Math.ceil(region.rowEnd))),
    colStart: Math.max(0, Math.min(cols, Math.floor(region.colStart))),
    colEnd: Math.max(0, Math.min(cols, Math.ceil(region.colEnd))),
  }
}

export const DEFAULT_GRID_OPTIONS: GridRenderOptions = {
  cellSize: 24,
  mode: 'color',
  majorEvery: 5,
  showRuler: true,
  detail: 'auto',
  emptyColor: '#f1f3f5',
  backgroundColor: '#ffffff',
  highlight: null,
  highlightColor: '#e8590c',
}

/**
 * 计算画布布局。
 *
 * 导出功能必须先调用它拿到总尺寸再去创建画布 ——
 * 布局逻辑必须只有这一处实现，否则屏幕预览与导出图会慢慢长歪。
 */
export interface GridLayout {
  cellSize: number
  /** 标尺占用的宽度/高度（含行列号），不显示标尺时为 0 */
  ruler: number
  originX: number
  originY: number
  gridWidth: number
  gridHeight: number
  totalWidth: number
  totalHeight: number
  detail: Exclude<CellDetail, 'auto'>
}

export function computeGridLayout(
  rows: number,
  cols: number,
  opts: GridRenderOptions,
): GridLayout {
  const cellSize = Math.max(1, opts.cellSize)
  const ruler = opts.showRuler ? Math.max(14, Math.round(cellSize * 0.9)) : 0
  const gridWidth = cols * cellSize
  const gridHeight = rows * cellSize

  return {
    cellSize,
    ruler,
    originX: ruler,
    originY: ruler,
    gridWidth,
    gridHeight,
    totalWidth: gridWidth + ruler,
    totalHeight: gridHeight + ruler,
    detail: resolveDetail(cellSize, opts.detail, opts.mode),
  }
}

/**
 * 根据格子大小决定能显示多少信息。
 *
 * 格子里塞不下字是拼豆图纸的固有问题：一格里写"P17"至少需要 20px 见方，
 * 而 A4 纸打 29×29 的图时每格只有 6~7mm（约 25px @96dpi）。
 * 所以只能分级降级：能写色号就写色号，写不下就退成单字符符号，
 * 再小就留空、靠图例对照。
 */
function resolveDetail(
  cellSize: number,
  requested: CellDetail,
  mode: GridMode,
): Exclude<CellDetail, 'auto'> {
  if (mode === 'outline') return 'none'
  if (requested !== 'auto') return requested
  if (cellSize >= 20) return 'code'
  if (cellSize >= 9) return 'symbol'
  return 'none'
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * 绘制图纸。
 *
 * 性能上有一点值得说明：**按颜色分组绘制**。
 * 逐格切换 `fillStyle` 的开销远大于 `fillRect` 本身，
 * 100×100 的图纸就是一万次样式切换，会明显卡顿。
 * 先按颜色把格子分组，每种颜色只设置一次样式，是这里的关键优化。
 *
 * @param ctx 目标上下文。调用方负责处理 devicePixelRatio 缩放。
 */
export function renderPattern(
  ctx: Ctx2D,
  pattern: Pattern,
  options: Partial<GridRenderOptions> = {},
): GridLayout {
  const opts: GridRenderOptions = { ...DEFAULT_GRID_OPTIONS, ...options }
  const { rows, cols, colors, grid } = pattern
  const layout = computeGridLayout(rows, cols, opts)
  const { cellSize, originX, originY, detail } = layout

  const isSymbolMode = opts.mode === 'symbol'
  const region = clampRegion(opts.region, rows, cols)

  // ---- 背景 ----
  ctx.fillStyle = opts.backgroundColor
  ctx.fillRect(0, 0, layout.totalWidth, layout.totalHeight)

  // ---- 按颜色分组 ----
  // 每组记录该颜色的所有格子下标；空格单独一组。
  // 只遍历可见区域，因此这张表的规模与图纸总大小无关。
  const groups: number[][] = Array.from({ length: colors.length }, () => [])
  const empties: number[] = []

  for (let r = region.rowStart; r < region.rowEnd; r++) {
    const base = r * cols
    for (let c = region.colStart; c < region.colEnd; c++) {
      const v = grid[base + c]!
      if (v === -1) empties.push(base + c)
      else if (v >= 0 && v < colors.length) groups[v]!.push(base + c)
    }
  }

  // ---- 填充格子 ----
  for (let i = 0; i < colors.length; i++) {
    const cells = groups[i]!
    if (cells.length === 0) continue

    const color = colors[i]!
    // 符号模式下一律白底 —— 黑白打印时颜色只会变成深浅不一的灰，
    // 反而让符号看不清
    ctx.fillStyle = isSymbolMode ? '#ffffff' : opts.mode === 'outline' ? '#ffffff' : color.hex
    for (const idx of cells) {
      const r = (idx / cols) | 0
      const c = idx % cols
      ctx.fillRect(originX + c * cellSize, originY + r * cellSize, cellSize, cellSize)
    }
  }

  if (empties.length > 0) {
    ctx.fillStyle = opts.emptyColor
    for (const idx of empties) {
      const r = (idx / cols) | 0
      const c = idx % cols
      ctx.fillRect(originX + c * cellSize, originY + r * cellSize, cellSize, cellSize)
    }
  }

  // ---- 格内文字（色号或符号）----
  // 排布交给 label.ts 统一决定：那里的字号是按本张图纸最长的色号反算的，
  // 放不下会退成符号，绝不截断色号。
  const plan = planCellLabels(
    cellSize,
    detail,
    opts.mode,
    colors.map((c) => c.code),
  )

  if (plan.detail !== 'none') {
    ctx.font = `${plan.detail === 'code' ? '' : 'bold '}${plan.fontSize}px "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    for (let i = 0; i < colors.length; i++) {
      const cells = groups[i]!
      if (cells.length === 0) continue

      const color = colors[i]!
      const text = plan.labels[i] ?? ''

      // 彩色模式下按底色明暗自动切黑/白字，保证对比度
      ctx.fillStyle = isSymbolMode || opts.mode === 'outline'
        ? '#000000'
        : contrastTextColor(color.hex)

      for (const idx of cells) {
        const r = (idx / cols) | 0
        const c = idx % cols
        ctx.fillText(
          text,
          originX + c * cellSize + cellSize / 2,
          originY + r * cellSize + cellSize / 2,
        )
      }
    }
  }

  // ---- 网格线 ----
  drawGridLines(ctx, layout, rows, cols, opts, region)

  // ---- 标尺 ----
  if (opts.showRuler) {
    drawRuler(ctx, layout, rows, cols, opts, region)
  }

  // ---- 高亮 ----
  if (opts.highlight) {
    const { row, col } = opts.highlight
    if (row >= 0 && row < rows && col >= 0 && col < cols) {
      ctx.strokeStyle = opts.highlightColor
      ctx.lineWidth = 2
      ctx.strokeRect(
        originX + col * cellSize + 1,
        originY + row * cellSize + 1,
        cellSize - 2,
        cellSize - 2,
      )
    }
  }

  return layout
}

/**
 * 绘制网格线。
 *
 * **每 5 格一条加粗线**是必须的，不是美化：一张 50×50 的图纸有 2500 格，
 * 全靠数格子定位会数瞎，出错率极高。加粗线提供视觉锚点，
 * "从第 3 条粗线往右数 2 格"这种定位方式才能可靠工作。
 */
function drawGridLines(
  ctx: Ctx2D,
  layout: GridLayout,
  rows: number,
  cols: number,
  opts: GridRenderOptions,
  region: GridRegion,
): void {
  const { cellSize, originX, originY, gridWidth, gridHeight } = layout
  const major = opts.majorEvery

  // 线的**长度**仍按整幅图给（画到画布外由浏览器裁掉，不花钱），
  // 但**条数**只按可见区域算 —— 这才是省时间的地方。
  ctx.beginPath()
  ctx.strokeStyle = '#c8ccd0'
  ctx.lineWidth = 1

  for (let c = region.colStart; c <= region.colEnd; c++) {
    if (major > 0 && c % major === 0 && c !== 0 && c !== cols) continue
    const x = originX + c * cellSize
    // +0.5 让 1px 线条落在像素中心，避免渲染成 2px 的模糊线
    ctx.moveTo(x + 0.5, originY)
    ctx.lineTo(x + 0.5, originY + gridHeight)
  }
  for (let r = region.rowStart; r <= region.rowEnd; r++) {
    if (major > 0 && r % major === 0 && r !== 0 && r !== rows) continue
    const y = originY + r * cellSize
    ctx.moveTo(originX, y + 0.5)
    ctx.lineTo(originX + gridWidth, y + 0.5)
  }
  ctx.stroke()

  if (major > 0) {
    ctx.beginPath()
    ctx.strokeStyle = '#495057'
    ctx.lineWidth = 2

    const firstMajorCol = Math.max(major, Math.ceil(region.colStart / major) * major)
    for (let c = firstMajorCol; c < Math.min(cols, region.colEnd + 1); c += major) {
      const x = originX + c * cellSize
      ctx.moveTo(x, originY)
      ctx.lineTo(x, originY + gridHeight)
    }

    const firstMajorRow = Math.max(major, Math.ceil(region.rowStart / major) * major)
    for (let r = firstMajorRow; r < Math.min(rows, region.rowEnd + 1); r += major) {
      const y = originY + r * cellSize
      ctx.moveTo(originX, y)
      ctx.lineTo(originX + gridWidth, y)
    }
    ctx.stroke()
  }
}

/**
 * 绘制行列标尺。
 *
 * 小格子时每格都标数字会糊成一团，所以按格子大小决定标注间隔：
 * 格子够大就逐格标，否则每 5 格标一次（与加粗线对齐）。
 */
function drawRuler(
  ctx: Ctx2D,
  layout: GridLayout,
  rows: number,
  cols: number,
  opts: GridRenderOptions,
  region: GridRegion,
): void {
  const { cellSize, originX, originY, ruler } = layout

  ctx.fillStyle = '#f8f9fa'
  ctx.fillRect(0, 0, layout.totalWidth, ruler)
  ctx.fillRect(0, 0, ruler, layout.totalHeight)

  const step = cellSize >= 16 ? 1 : opts.majorEvery > 0 ? opts.majorEvery : 5
  const fontSize = Math.max(7, Math.min(11, Math.round(cellSize * 0.45)))

  ctx.fillStyle = '#495057'
  ctx.font = `${fontSize}px "Helvetica Neue", Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 数字**始终标绝对行列号**，不随视口滚动而重新编号 ——
  // 标成"1"会让用户把它和图纸真正的第一行搞混。这里只在可见范围内标。
  for (let c = region.colStart; c < region.colEnd; c++) {
    if (c % step !== 0 && c !== cols - 1) continue
    ctx.fillText(
      String(c + 1),
      originX + c * cellSize + cellSize / 2,
      ruler / 2,
    )
  }

  for (let r = region.rowStart; r < region.rowEnd; r++) {
    if (r % step !== 0 && r !== rows - 1) continue
    ctx.fillText(String(r + 1), ruler / 2, originY + r * cellSize + cellSize / 2)
  }

  // 标尺与网格的分隔线
  ctx.beginPath()
  ctx.strokeStyle = '#adb5bd'
  ctx.lineWidth = 1
  ctx.moveTo(0, ruler + 0.5)
  ctx.lineTo(layout.totalWidth, ruler + 0.5)
  ctx.moveTo(ruler + 0.5, 0)
  ctx.lineTo(ruler + 0.5, layout.totalHeight)
  ctx.stroke()
}

/**
 * 计算"刚好铺满给定画布"的格子边长。
 *
 * 导出时用来决定 cellSize：给定目标纸张尺寸，反推出每格多少像素。
 */
export function fitCellSize(
  rows: number,
  cols: number,
  availWidth: number,
  availHeight: number,
  showRuler: boolean,
  maxCellSize = 64,
): number {
  // 标尺按 cellSize 的比例占位，所以先忽略标尺估算，再迭代收敛一两次
  let cell = Math.min(availWidth / cols, availHeight / rows)
  for (let i = 0; i < 3; i++) {
    const ruler = showRuler ? Math.max(14, Math.round(cell * 0.9)) : 0
    cell = Math.min(
      (availWidth - ruler) / cols,
      (availHeight - ruler) / rows,
    )
  }
  return Math.max(2, Math.min(maxCellSize, Math.floor(cell)))
}
