import { displayName } from '../../palette/types'
import { computeStats } from '../../pattern/stats'
import { boardsNeeded } from '../../pattern/sizing'
import { contrastTextColor } from '../../pattern/symbols'
import type { Pattern, PatternStats } from '../../pattern/types'
import { DEFAULT_GRID_OPTIONS, computeGridLayout } from '../../render/grid'
import type { GridLayout, GridRenderOptions, GridRegion } from '../../render/grid'
import { planCellLabels } from '../../render/label'
import {
  HEADER_MM,
  PAGE_MARGIN_MM,
  paginatePattern,
  pagesPerSheet,
} from '../page'
import { PdfContent } from './content'
import { PDF_LABELS, embeddedGlyph } from './fonts.generated'
import { loadPdfFonts } from './fonts'
import type { LoadedFont } from './fonts'
import { buildPdf, mmToPt } from './writer'
import type { Bytes, PdfPageSpec } from './writer'

/**
 * 把一张图纸变成 PDF。
 *
 * 版面计算**完全复用**屏幕 / PNG / SVG / 打印那四路用的 `computeGridLayout` 与
 * `planCellLabels`，所以同一张图纸在哪一路输出里格子都一样、标注都一样。
 * 这里只负责把结果翻译成 PDF 的绘制指令。
 *
 * 文档结构：第一页是汇总页（标题、参数、颜色购物清单），后面是图纸页。
 * 打印导出把用色表放在最后，PDF 放在最前 —— 下载下来的文件主要用于在屏幕上
 * 看和转发，先看到清单更自然，参考的那份商业 PDF 也是这么排的。
 */

/** 页面边距，与打印文档的 `@page` 和 `page.ts` 的分页假设一致 */
const MARGIN_MM = PAGE_MARGIN_MM

/**
 * 图纸区内部使用的格子边长（px）。
 *
 * 取 40 和打印路径的 `PAGE_CELL_PX` 一样，是因为 `resolveDetail` 要到 20px 才肯
 * 在格子里写色号 —— 直接拿物理点数当格子大小的话，5mm 的格子只有 14pt，
 * 会掉进"符号层"，于是出现"打印有 A1、PDF 只有符号"的不一致。
 */
const PAGE_CELL_PX = 40

/** 单页模式下每格的目标毫米数（见 clampSingleCellMm） */
const SINGLE_TARGET_MM = 320

export interface PdfPreviewImage {
  width: number
  height: number
  /** 每像素 3 字节，RGB，行优先 */
  rgb: Uint8Array
}

export interface PdfExportOptions {
  /**
   * `paged`：实际尺寸的 A4 分页（打印出来能垫在底板下照着摆）
   * `single`：整张图压进一页，页面尺寸随图纸走（适合屏幕上放大看、方便转发）
   */
  layout: 'paged' | 'single'
  /** 每颗豆的直径，毫米 */
  beadSizeMm: number
  /** 打印倍率：1 表示按实物大小 */
  printScale: number
  showRuler: boolean
  majorEvery: number
  title?: string
  /** 色卡名，写在参数行里（"适配品牌"） */
  paletteName?: string
  boardSize?: number
  stats?: PatternStats | null
  /** 汇总页的预览图。不传就不画 —— 生成函数保持纯函数，测试才好写 */
  preview?: PdfPreviewImage
  /** 可注入，保证测试可复现 */
  createdAt?: Date
  /** 测试用：直接给出字体，避免走动态 import 与网络 */
  fonts?: LoadedFont[]
}

/** 把 `第 {n} / {total} 页` 这类模板填出来 */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) =>
    key in vars ? String(vars[key]) : all,
  )
}

/**
 * 页面上要印的标题。
 *
 * 图纸标题是用户随便输的（"我的猫"、"给妈妈的生日礼物"），而字体子集是**构建期**
 * 定死的，收录不了所有汉字 —— 实测常见的"测试""我""猫"都不在子集里。
 * 画不出来的字不做替换（那会印成「??图纸」，比不印还糟），而是整体退回默认标题。
 *
 * 用户不会因此找不到自己的图纸：**文件名用的是原始标题**
 * （见 `suggestFileName`），PDF 的元数据里也保留原始标题 ——
 * 元数据走 UTF-16BE，不受字形限制。
 */
function pageTitle(options: PdfExportOptions, pattern: Pattern): string {
  const wanted = (options.title ?? pattern.title ?? '').trim()
  if (wanted === '') return PDF_LABELS.defaultTitle
  for (const ch of wanted) {
    if (embeddedGlyph(ch) === null) return PDF_LABELS.defaultTitle
  }
  return wanted
}

const INK = '#1a1a1a'
const INK_DIM = '#5b6470'
const INK_FAINT = '#8b929e'
/**
 * 购物清单每张卡片的底色。
 *
 * 不是装饰：颗数是右对齐到卡片右边缘的，没有底色时它会紧贴在**下一张卡片**
 * 的色块左边，看上去像是下一张卡片的数字。参考的那份商业 PDF 也给了卡片底色，
 * 解决的正是这个问题。
 */
const CARD_BG = '#f5f6f8'
const EMPTY_CELL = DEFAULT_GRID_OPTIONS.emptyColor
const GRID_LINE = '#c8ccd0'
const GRID_LINE_MAJOR = '#495057'

function gridOptions(
  cellSize: number,
  majorEvery: number,
  showRuler: boolean,
): GridRenderOptions {
  return {
    ...DEFAULT_GRID_OPTIONS,
    cellSize,
    majorEvery,
    showRuler,
    detail: 'auto',
  }
}

/** 一页图纸在 px 空间里需要多大，以及它的格内标注是什么 */
interface GridBlock {
  layout: GridLayout
  labels: readonly string[]
  detail: 'none' | 'symbol' | 'code'
  /** 格内文字的字号（px） */
  fontSize: number
}

function planGridBlock(
  pattern: Pattern,
  region: GridRegion | null,
  cellSize: number,
  majorEvery: number,
  showRuler: boolean,
): GridBlock {
  const viewRows = region ? region.rowEnd - region.rowStart : pattern.rows
  const viewCols = region ? region.colEnd - region.colStart : pattern.cols
  const layout = computeGridLayout(
    viewRows,
    viewCols,
    gridOptions(cellSize, majorEvery, showRuler),
  )
  const plan = planCellLabels(
    layout.cellSize,
    layout.detail,
    'color',
    pattern.colors.map((c) => c.code),
  )
  return {
    layout,
    labels: plan.labels,
    detail: plan.detail,
    fontSize: plan.fontSize,
  }
}

/** 标尺上每隔几格标一个号：按**物理尺寸**决定，太小就稀一点 */
function rulerStep(mmPerCell: number): number {
  if (mmPerCell >= 6) return 1
  if (mmPerCell >= 3) return 5
  return 10
}

/**
 * 画一页图纸（不含页眉）。
 *
 * `originXPt / originYPt` 是内容原点在页面上的位置，**单位 pt，原点在左下角**
 * （PDF 的坐标系就是这样）。网格用 px 空间绘制，由 `userSpace` 统一缩放到物理尺寸。
 */
function drawGridBlock(
  content: PdfContent,
  pattern: Pattern,
  region: GridRegion | null,
  block: GridBlock,
  scale: number,
  originXPt: number,
  originYPt: number,
  mmPerCell: number,
  majorEvery: number,
): void {
  const { layout } = block
  const { cellSize, ruler, originX, originY, totalWidth, totalHeight } = layout
  const { cols, grid } = pattern

  const rowStart = region ? region.rowStart : 0
  const colStart = region ? region.colStart : 0
  const rowEnd = region ? region.rowEnd : pattern.rows
  const colEnd = region ? region.colEnd : pattern.cols
  const viewRows = rowEnd - rowStart
  const viewCols = colEnd - colStart

  content.save()
  content.userSpace(scale, originXPt, originYPt)

  // 背景
  content.fillColor('#ffffff').rect(0, 0, totalWidth, totalHeight)

  // ---- 格子填充：按颜色分组 + 行内合并连续同色，减少指令数 ----
  // 一格一条指令的话，104×104 就是一万多条；合并之后通常只有几千条。
  const runs = new Map<number, { x: number; y: number; w: number }[]>()
  for (let r = rowStart; r < rowEnd; r++) {
    let c = colStart
    while (c < colEnd) {
      const v = grid[r * cols + c]!
      let c2 = c + 1
      while (c2 < colEnd && grid[r * cols + c2] === v) c2++
      const list = runs.get(v) ?? []
      list.push({
        x: originX + (c - colStart) * cellSize,
        y: originY + (r - rowStart) * cellSize,
        w: (c2 - c) * cellSize,
      })
      runs.set(v, list)
      c = c2
    }
  }

  for (const [value, list] of runs) {
    const hex = value < 0 ? EMPTY_CELL : (pattern.colors[value]?.hex ?? EMPTY_CELL)
    content.fillColor(hex)
    for (const run of list) {
      content.rect(run.x, run.y, run.w, cellSize)
    }
  }

  // ---- 网格线：所有细线走一条路径，加粗线再走一条 ----
  const gx0 = originX
  const gy0 = originY
  const gx1 = originX + viewCols * cellSize
  const gy1 = originY + viewRows * cellSize

  content.strokeColor(GRID_LINE).lineWidth(0.6).beginPath()
  for (let c = 0; c <= viewCols; c++) {
    const x = gx0 + c * cellSize
    content.moveTo(x, gy0).lineTo(x, gy1)
  }
  for (let r = 0; r <= viewRows; r++) {
    const y = gy0 + r * cellSize
    content.moveTo(gx0, y).lineTo(gx1, y)
  }
  content.stroke()

  if (majorEvery > 0) {
    content.strokeColor(GRID_LINE_MAJOR).lineWidth(1.4).beginPath()
    for (let c = colStart; c <= colEnd; c++) {
      if ((c - 0) % majorEvery !== 0) continue
      const x = gx0 + (c - colStart) * cellSize
      content.moveTo(x, gy0).lineTo(x, gy1)
    }
    for (let r = rowStart; r <= rowEnd; r++) {
      if ((r - 0) % majorEvery !== 0) continue
      const y = gy0 + (r - rowStart) * cellSize
      content.moveTo(gx0, y).lineTo(gx1, y)
    }
    content.stroke()
  }

  // ---- 格内标注（色号或符号）----
  if (block.detail !== 'none' && block.labels.length > 0) {
    const size = block.fontSize
    for (let i = 0; i < pattern.colors.length; i++) {
      const text = block.labels[i] ?? ''
      if (text === '') continue
      const ink = contrastTextColor(pattern.colors[i]!.hex)
      for (let r = rowStart; r < rowEnd; r++) {
        for (let c = colStart; c < colEnd; c++) {
          if (grid[r * cols + c] !== i) continue
          content.text(
            originX + (c - colStart) * cellSize + cellSize / 2,
            originY + (r - rowStart) * cellSize + cellSize / 2,
            text,
            { size, color: ink, align: 'center' },
          )
        }
      }
    }
  }

  // ---- 标尺 ----
  if (ruler > 0) {
    const step = rulerStep(mmPerCell)
    const size = Math.max(7, Math.min(11, Math.round(cellSize * 0.45)))
    const ink = '#c92a2a'

    // 标注范围是半开区间的**实际存在的格子**（r < rowEnd），
    // 用 <= 会把不存在的第 rowEnd+1 行也标出来，还会和相邻的列号撞在一起
    for (let c = colStart; c < colEnd; c++) {
      if (c % step !== 0) continue
      const x = originX + (c - colStart) * cellSize + cellSize / 2
      content.text(x, originY - ruler / 2, String(c + 1), {
        size,
        color: ink,
        align: 'center',
      })
      content.text(x, originY + viewRows * cellSize + ruler / 2 + 4, String(c + 1), {
        size,
        color: ink,
        align: 'center',
      })
    }
    for (let r = rowStart; r < rowEnd; r++) {
      if (r % step !== 0) continue
      const y = originY + (r - rowStart) * cellSize + cellSize / 2
      content.text(originX - ruler / 2, y, String(r + 1), {
        size,
        color: ink,
        align: 'center',
      })
      content.text(originX + viewCols * cellSize + ruler / 2 + 8, y, String(r + 1), {
        size,
        color: ink,
        align: 'center',
      })
    }
  }

  content.restore()
}

/** 页眉：第 N/M 页 + 行列范围。画在 pt 空间，保证字号不随图纸大小变 */
function drawCaption(
  content: PdfContent,
  pageHeightPt: number,
  text: string,
): void {
  content.save()
  content.userSpace(1, 0, pageHeightPt)
  const margin = mmToPt(MARGIN_MM)
  content.text(margin, margin + mmToPt(HEADER_MM) / 2, text, {
    size: 9,
    color: INK_DIM,
  })
  content.restore()
}

/**
 * 汇总页：标题、参数、颜色购物清单。
 *
 * 排成 A4 横向 —— 清单要横向铺开才好看，而图纸页是纵向的 A4。
 * 一页里纸张方向不一致在 PDF 里完全合法（每页有自己的 MediaBox）。
 */
function buildSummaryPage(
  pattern: Pattern,
  options: PdfExportOptions,
  stats: PatternStats | null,
  labelsForCells: readonly string[],
): PdfPageSpec {
  const widthPt = mmToPt(297)
  const heightPt = mmToPt(210)
  const margin = mmToPt(MARGIN_MM)
  const content = new PdfContent()

  content.save()
  content.userSpace(1, 0, heightPt)

  // ---- 标题与参数 ----
  content.text(margin, margin + 12, pageTitle(options, pattern), { size: 20, color: INK })

  const lines: string[] = []
  if (options.paletteName) {
    lines.push(fill(PDF_LABELS.brandLine, { name: options.paletteName }))
  }
  lines.push(
    fill(PDF_LABELS.gridLine, { w: pattern.cols, h: pattern.rows }),
  )
  if (stats) {
    lines.push(fill(PDF_LABELS.totalLine, { n: stats.totalBeads }))
    lines.push(
      fill(PDF_LABELS.finishedLine, {
        w: Math.round(stats.widthMm),
        h: Math.round(stats.heightMm),
      }),
    )
    if (options.boardSize) {
      const boards = boardsNeeded(pattern.rows, pattern.cols, options.boardSize)
      lines.push(
        fill(PDF_LABELS.boardLine, {
          across: boards.across,
          down: boards.down,
          total: boards.total,
          size: options.boardSize,
        }),
      )
    }
  }

  let y = margin + 36
  for (const line of lines) {
    content.text(margin, y, line, { size: 9.5, color: INK_DIM })
    y += 13
  }

  content.text(margin, y + 4, PDF_LABELS.denseHint, { size: 8, color: INK_FAINT })

  // ---- 颜色购物清单 ----
  const rows = stats?.colors ?? []
  const headY = margin + 116
  content.text(
    margin,
    headY,
    fill(PDF_LABELS.colorListWithCount, { n: rows.length }),
    { size: 12, color: INK },
  )
  content.text(margin, headY + 15, PDF_LABELS.symbolHint, {
    size: 7.5,
    color: INK_FAINT,
  })

  // 卡片栏数与高度随颜色数自适应：颜色多就压矮卡片、必要时加一栏，
  // 而不是让清单溢出到页面外面
  const listTop = headY + 26
  const listBottom = heightPt - margin - 16
  const availH = listBottom - listTop
  let columns = 4
  let cardH = 24
  for (let attempt = 0; attempt < 4; attempt++) {
    const needRows = Math.ceil(rows.length / columns)
    cardH = Math.min(24, Math.floor(availH / Math.max(1, needRows)))
    if (cardH >= 15) break
    columns++
  }
  const colGap = 12
  const cardW = (widthPt - margin * 2 - colGap * (columns - 1)) / columns

  rows.forEach((row, i) => {
    const col = i % columns
    const line = Math.floor(i / columns)
    const x = margin + col * (cardW + colGap)
    const top = listTop + line * cardH
    if (top + cardH > listBottom + cardH) return

    content.fillColor(CARD_BG).rect(x - 3, top + 1, cardW + 6, cardH - 2)

    // 色块。格内标注与色号不同时（也就是用了符号），把符号印在色块里 ——
    // 用户是拿着格子里的标注来找色号的
    const sw = Math.min(16, cardH - 6)
    const swY = top + (cardH - sw) / 2
    content.fillColor(row.color.hex).rect(x, swY, sw, sw)
    content.strokeColor('#ced4da').lineWidth(0.5).rectStroke(x, swY, sw, sw)

    const cellLabel = labelsForCells[row.colorIndex] ?? ''
    if (cellLabel !== '' && cellLabel !== row.color.code) {
      content.text(x + sw / 2, swY + sw / 2, cellLabel, {
        size: sw * 0.62,
        color: contrastTextColor(row.color.hex),
        align: 'center',
      })
    }

    const textX = x + sw + 6
    const name = displayName(row.color)
    const midY = top + cardH / 2
    if (name !== '') {
      content.text(textX, midY - 4.5, row.color.code, { size: 8.5, color: INK })
      content.text(textX, midY + 4.5, name, { size: 7, color: INK_FAINT })
    } else {
      content.text(textX, midY, row.color.code, { size: 9, color: INK })
    }

    // 右侧两个数：上面是实际颗数，下面是备货（含损耗）
    const rightX = x + cardW
    content.text(rightX, midY - 4, String(row.count), {
      size: 9.5,
      color: INK,
      align: 'right',
    })
    content.text(rightX, midY + 4.5, fill(PDF_LABELS.purchaseLine, { n: row.purchase }), {
      size: 6.5,
      color: INK_FAINT,
      align: 'right',
    })
  })

  content.text(margin, heightPt - margin - 4, PDF_LABELS.colorDisclaimer, {
    size: 7,
    color: INK_FAINT,
  })

  content.restore()

  return { widthPt, heightPt, content: content.build() }
}

/** 单页模式的格子毫米数：让整页边长落在合理范围内 */
function clampSingleCellMm(pattern: Pattern): number {
  const longest = Math.max(pattern.rows, pattern.cols, 1)
  const byTarget = SINGLE_TARGET_MM / longest
  return Math.max(1.6, Math.min(6, byTarget))
}

export async function patternToPdf(
  pattern: Pattern,
  options: PdfExportOptions,
): Promise<Bytes> {
  const fonts = options.fonts ?? (await loadPdfFonts())
  const stats =
    options.stats === undefined ? computeStats(pattern, undefined) : options.stats

  const pages: PdfPageSpec[] = []

  // 分页模式与单页模式共用同一套版面计算，区别只在"一格多大"：
  // 分页模式按豆子的真实尺寸（打印出来能垫在底板下），
  // 单页模式则反过来——**格子大小迁就图纸**，好让整张图落在一页里。
  const paged = options.layout === 'paged'
  const mmPerCell = paged
    ? Math.max(0.5, options.beadSizeMm * options.printScale)
    : clampSingleCellMm(pattern)
  const { rowsPerPage, colsPerPage } = pagesPerSheet({
    beadSizeMm: options.beadSizeMm,
    printScale: options.printScale,
    showRuler: options.showRuler,
  })
  const regions: (GridRegion | null)[] = paged
    ? paginatePattern(pattern.rows, pattern.cols, rowsPerPage, colsPerPage)
    : [null]

  // 单页模式下让内部 px 跟着物理尺寸走（10px = 1mm），这样标尺、格内标注的
  // 字号在换算成毫米之后仍然可读；分页模式则固定用 PAGE_CELL_PX，与打印一致
  const cellSizePx = paged ? PAGE_CELL_PX : Math.round(mmPerCell * 10)

  const blocks = regions.map((region) =>
    planGridBlock(pattern, region, cellSizePx, options.majorEvery, options.showRuler),
  )

  // 汇总页要用"格子里实际印的是什么"，所以从第一个图纸块里取
  const firstBlock = blocks[0]
  const cellLabels = firstBlock?.labels ?? []

  pages.push(buildSummaryPage(pattern, options, stats, cellLabels))

  const marginPt = mmToPt(MARGIN_MM)

  regions.forEach((region, index) => {
    const block = blocks[index]!
    const { layout } = block

    // px → pt 的缩放：让一格正好等于 mmPerCell 毫米
    const scale = mmToPt(mmPerCell) / layout.cellSize
    const contentW = layout.totalWidth * scale
    const contentH = layout.totalHeight * scale

    let pageW: number
    let pageH: number
    if (paged) {
      pageW = mmToPt(210)
      pageH = mmToPt(297)
    } else {
      pageW = contentW + marginPt * 2
      pageH = contentH + marginPt * 2
    }

    const content = new PdfContent()
    const caption = paged
      ? fill(PDF_LABELS.pageCaption, {
          n: index + 1,
          total: regions.length,
          r1: (region?.rowStart ?? 0) + 1,
          r2: region?.rowEnd ?? pattern.rows,
          c1: (region?.colStart ?? 0) + 1,
          c2: region?.colEnd ?? pattern.cols,
        })
      : fill(PDF_LABELS.sizeLine, { w: pattern.cols, h: pattern.rows })

    const captionH = mmToPt(HEADER_MM)
    drawCaption(content, pageH, caption)

    // 注意 PDF 的原点在**左下角**：userSpace 的 originY 要按"从底部算"给，
    // 而我们的版面是按"距顶部多少"想的，所以要翻一次（曾因此把整张网格画到页脚）
    drawGridBlock(
      content,
      pattern,
      region,
      block,
      scale,
      marginPt,
      pageH - marginPt - captionH,
      mmPerCell,
      options.majorEvery,
    )

    pages.push({ widthPt: pageW, heightPt: pageH, content: content.build() })
  })

  return buildPdf({
    pages,
    embeddedFonts: fonts,
    // 元数据里用**原始标题**：它走 UTF-16BE，不受字体字形限制，
    // 所以哪怕页面上画不出来，文件的属性里仍然认得出这是哪张图纸
    title: (options.title ?? pattern.title ?? '').trim() || PDF_LABELS.defaultTitle,
    creator: PDF_LABELS.appName,
    createdAt: options.createdAt,
  })
}

/** 供界面提示用：这个排版会出几页 */
export function estimatePdfPages(
  pattern: Pattern,
  options: Pick<PdfExportOptions, 'layout' | 'beadSizeMm' | 'printScale' | 'showRuler'>,
): number {
  if (options.layout === 'single') return 2
  const { rowsPerPage, colsPerPage } = pagesPerSheet(options)
  return paginatePattern(pattern.rows, pattern.cols, rowsPerPage, colsPerPage).length + 1
}
