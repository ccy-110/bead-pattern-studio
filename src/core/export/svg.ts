import type { Pattern } from '../pattern/types'
import { contrastTextColor } from '../pattern/symbols'
import { computeGridLayout } from '../render/grid'
import { planCellLabels } from '../render/label'
import type { GridMode, GridRenderOptions } from '../render/grid'

/** 图纸的一块矩形区域。半开区间，行列都是从 0 开始的绝对下标。 */
export interface SvgRegion {
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}

export interface SvgExportOptions {
  mode: GridMode
  showRuler: boolean
  majorEvery: number
  showCode: boolean
  cellSize: number
  /**
   * 打印倍率：图纸上的 1 格 = 实物 1 颗豆，倍率决定印出来放大多少。
   *
   * 1 倍即实际大小，可以把它直接垫在底板下面照着摆。
   * 但 5mm 豆的格子印出来只有 5mm 见方，里面塞不下色号，
   * 所以看色号要用 1.5~2 倍印。
   */
  printScale: number
  /**
   * 只导出这块区域，其余不画。省略或为 null 表示整张。
   *
   * 分页打印靠它：每页各画一块，但**格子尺寸必须由调用方统一给定**，
   * 否则各页会各自去适配纸张，导致同一条边在两页上对不上。
   */
  region?: SvgRegion | null
  /** 画在图纸上方的说明文字（页码之类）。省略则不画。 */
  caption?: string
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

/** 数字保留两位小数，去掉多余的 0 —— 几十万个数字下来能省不少体积 */
function n(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '')
}

/** 说明文字占用的高度 */
const CAPTION_HEIGHT = 22

function normalizeRegion(
  region: SvgRegion | null | undefined,
  rows: number,
  cols: number,
): SvgRegion {
  if (!region) return { rowStart: 0, rowEnd: rows, colStart: 0, colEnd: cols }

  const rowStart = Math.max(0, Math.min(rows, Math.floor(region.rowStart)))
  const colStart = Math.max(0, Math.min(cols, Math.floor(region.colStart)))

  return {
    rowStart,
    colStart,
    // 至少留一行一列。写 max(rowStart, …) 是不够的：
    // 结束值算出比开始值小时，那正好得到空区间，于是整页全白 ——
    // 而白页是最难排查的一种故障，用户只会看到"打印出来是空的"。
    rowEnd: Math.min(rows, Math.max(rowStart + 1, Math.ceil(region.rowEnd))),
    colEnd: Math.min(cols, Math.max(colStart + 1, Math.ceil(region.colEnd))),
  }
}

/**
 * 生成 SVG 图纸。
 *
 * 相比 PNG 的两点好处：
 *
 * 1. **放大不失真**。图纸经常要放大到几倍去看某一格，PNG 一放大就糊，
 *    而看错一格意味着摆错一颗豆子。
 * 2. **文件小得多**。同色相邻的格子会合并成一条水平线段再写进 `d`，
 *    一张 5000 颗豆的图纸往往只有几十 KB。
 *
 * 物理尺寸直接写进 `width`/`height` 的毫米单位，浏览器打印时会**按真实尺寸**输出。
 * 这是拼豆图纸最要紧的一点：用户打印出来是要垫在底板下面照着摆的，
 * 尺寸差一点整张图就废了。
 */
export function patternToSvg(pattern: Pattern, options: SvgExportOptions): string {
  const gridOpts: GridRenderOptions = {
    cellSize: options.cellSize,
    mode: options.mode,
    showRuler: options.showRuler,
    majorEvery: options.majorEvery,
    detail: options.showCode ? 'auto' : 'none',
    emptyColor: '#ffffff',
    backgroundColor: '#ffffff',
    highlight: null,
    highlightColor: '#e8590c',
  }

  const { rows, cols, colors, grid } = pattern
  const region = normalizeRegion(options.region, rows, cols)

  const viewRows = region.rowEnd - region.rowStart
  const viewCols = region.colEnd - region.colStart

  // 版面按**区域**尺寸算，但格子大小是调用方给定的，
  // 所以同一张图纸的各页格子一样大，拼起来才严丝合缝
  const layout = computeGridLayout(viewRows, viewCols, gridOpts)
  const { cellSize, ruler, detail } = layout

  const captionH = options.caption ? CAPTION_HEIGHT : 0
  const originX = layout.originX
  const originY = layout.originY + captionH
  const totalWidth = layout.totalWidth
  const totalHeight = layout.totalHeight + captionH

  // 1 格 = 1 颗豆 = beadSizeMm 毫米，乘上打印倍率就是纸上的实际尺寸
  const mmPerCell = pattern.beadSizeMm * options.printScale
  const pxToMm = mmPerCell / cellSize
  const mmW = totalWidth * pxToMm
  const mmH = totalHeight * pxToMm

  const isSymbol = options.mode === 'symbol'
  const isOutline = options.mode === 'outline'

  /** 区域内某一格在图上的左上角坐标 */
  const cellX = (c: number): number => originX + (c - region.colStart) * cellSize
  const cellY = (r: number): number => originY + (r - region.rowStart) * cellSize

  const out: string[] = []

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(totalWidth)} ${n(totalHeight)}" ` +
      `width="${n(mmW)}mm" height="${n(mmH)}mm" shape-rendering="crispEdges">`,
  )

  // 背景必须显式画出来：SVG 默认透明，打印时会变成纸色，
  // 但屏幕上预览是灰的，不一致会让用户以为哪里出错了
  out.push(
    `<rect width="${n(totalWidth)}" height="${n(totalHeight)}" fill="#ffffff"/>`,
  )

  // ---- 说明文字 ----
  if (options.caption) {
    out.push(
      `<text x="${n(originX)}" y="${n(captionH * 0.7)}" font-size="12" fill="#495057" ` +
        `font-family="Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif">` +
        `${esc(options.caption)}</text>`,
    )
  }

  // ---- 颜色分组 ----
  const runs: string[][] = Array.from({ length: colors.length }, () => [])
  const empties: string[] = []
  /** 每格的区域坐标，供文字层复用 */
  const byColor: { r: number; c: number }[][] = Array.from(
    { length: colors.length },
    () => [],
  )

  for (let r = region.rowStart; r < region.rowEnd; r++) {
    const base = r * cols
    let c = region.colStart
    while (c < region.colEnd) {
      const v = grid[base + c]!
      const start = c
      // 同色水平连续段合并成一条，这是 SVG 体积能压下来的关键
      while (c < region.colEnd && grid[base + c] === v) c++

      const x = cellX(start)
      const y = cellY(r)
      const w = (c - start) * cellSize

      if (v === -1) {
        empties.push(`M${n(x)} ${n(y)}h${n(w)}v${n(cellSize)}h${n(-w)}z`)
      } else if (v >= 0 && v < colors.length) {
        runs[v]!.push(`M${n(x)} ${n(y)}h${n(w)}v${n(cellSize)}h${n(-w)}z`)
        for (let k = start; k < c; k++) byColor[v]!.push({ r, c: k })
      }
    }
  }

  const fill = (i: number): string =>
    isSymbol || isOutline ? '#ffffff' : colors[i]!.hex

  for (let i = 0; i < colors.length; i++) {
    const d = runs[i]!.join('')
    if (d === '') continue
    out.push(`<path fill="${fill(i)}" d="${d}"/>`)
  }

  if (empties.length > 0) {
    out.push(`<path fill="#ffffff" d="${empties.join('')}"/>`)
  }

  // ---- 网格线 ----
  const major = options.majorEvery
  const thin: string[] = []
  const thick: string[] = []

  const gridLeft = cellX(region.colStart)
  const gridRight = cellX(region.colEnd)
  const gridTop = cellY(region.rowStart)
  const gridBottom = cellY(region.rowEnd)

  for (let c = region.colStart; c <= region.colEnd; c++) {
    // 加粗与否只看**绝对**列号：同一条分区线在两页上都该是粗的，
    // 用户正是靠它对位，若随分页变粗细就会以为接错了
    const isMajor = major > 0 && c % major === 0 && c !== 0 && c !== cols
    const d = `M${n(cellX(c))} ${n(gridTop)}V${n(gridBottom)}`
    if (isMajor) thick.push(d)
    else thin.push(d)
  }
  for (let r = region.rowStart; r <= region.rowEnd; r++) {
    const isMajor = major > 0 && r % major === 0 && r !== 0 && r !== rows
    const d = `M${n(gridLeft)} ${n(cellY(r))}H${n(gridRight)}`
    if (isMajor) thick.push(d)
    else thin.push(d)
  }

  out.push(`<path fill="none" stroke="#c8ccd0" stroke-width="1" d="${thin.join('')}"/>`)
  if (thick.length > 0) {
    out.push(
      `<path fill="none" stroke="#495057" stroke-width="2" d="${thick.join('')}"/>`,
    )
  }

  // ---- 格内文字 ----
  // 与画布渲染共用同一份排布逻辑，否则预览和导出会出现两套不同的标注
  const plan = planCellLabels(cellSize, detail, options.mode, colors.map((c) => c.code))

  if (plan.detail !== 'none') {
    const fontSize = plan.fontSize
    const family = 'Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif'
    const weight = plan.detail === 'code' ? '' : ' font-weight="bold"'

    for (let i = 0; i < colors.length; i++) {
      const cells = byColor[i]!
      if (cells.length === 0) continue

      const color = colors[i]!
      const text = plan.labels[i] ?? ''

      const ink = isSymbol || isOutline ? '#000000' : contrastTextColor(color.hex)
      const parts: string[] = []
      for (const { r, c } of cells) {
        parts.push(
          `<text x="${n(cellX(c) + cellSize / 2)}" ` +
            `y="${n(cellY(r) + cellSize / 2)}">${esc(text)}</text>`,
        )
      }
      out.push(
        `<g fill="${ink}" font-size="${fontSize}" font-family="${family}"${weight} ` +
          `text-anchor="middle" dominant-baseline="central">${parts.join('')}</g>`,
      )
    }
  }

  // ---- 标尺 ----
  // 编号一律用**全图绝对行列号**（从 1 开始）。分页之后这一点尤其要紧：
  // 每页都从 1 重新数的话，用户根本不知道该从底板的哪一行接下去。
  if (options.showRuler) {
    out.push(
      `<path fill="#f8f9fa" d="M0 0h${n(totalWidth)}v${n(ruler)}h${n(-totalWidth)}z"/>`,
    )
    out.push(
      `<path fill="#f8f9fa" d="M0 0h${n(ruler)}v${n(totalHeight)}h${n(-ruler)}z"/>`,
    )

    const step = cellSize >= 16 ? 1 : major > 0 ? major : 5
    const fs = Math.max(7, Math.min(11, Math.round(cellSize * 0.45)))
    const parts: string[] = []

    for (let c = region.colStart; c < region.colEnd; c++) {
      // 区域的头尾一定标出来，否则看不出这页管的是哪一段
      if (c % step !== 0 && c !== region.colStart && c !== region.colEnd - 1) continue
      parts.push(
        `<text x="${n(cellX(c) + cellSize / 2)}" y="${n(captionH + ruler / 2)}">${c + 1}</text>`,
      )
    }
    for (let r = region.rowStart; r < region.rowEnd; r++) {
      if (r % step !== 0 && r !== region.rowStart && r !== region.rowEnd - 1) continue
      parts.push(
        `<text x="${n(ruler / 2)}" y="${n(cellY(r) + cellSize / 2)}">${r + 1}</text>`,
      )
    }

    out.push(
      `<g fill="#495057" font-size="${fs}" font-family="Helvetica Neue, Arial, sans-serif" ` +
        `text-anchor="middle" dominant-baseline="central">${parts.join('')}</g>`,
    )

    out.push(
      `<path fill="none" stroke="#adb5bd" stroke-width="1" ` +
        `d="M0 ${n(captionH + ruler + 0.5)}H${n(totalWidth)}` +
        `M${n(ruler + 0.5)} 0V${n(totalHeight)}"/>`,
    )
  }

  out.push('</svg>')
  return out.join('')
}
