import type { SvgRegion } from './svg'

/**
 * 分页打印。
 *
 * ## 为什么非要分页
 *
 * 图纸的物理尺寸是硬的：300 格 × 5 毫米 = 1.5 米宽，A4 纸横着也放不下。
 * 不分页时浏览器只能把整张 SVG 缩到纸宽，于是"按真实尺寸打印"这条保证就没了 ——
 * 用户以为印出来能垫在底板下面照着摆，实际每格只有 1 毫米，
 * 尺寸全错，而且错得看不出来。分页是唯一能同时保住尺寸和可读性的做法。
 *
 * ## 为什么页与页要重叠
 *
 * 拼到页边界时，用户需要知道"这一页的第一行接的是上一页的哪一行"。
 * 若两页严丝合缝地切开，交界处就只有各自孤零零的一行，对不上号；
 * 让相邻页重叠 1 行/列，边界那一格在前后两页上都能看到，
 * 照着它对齐即可。多印的那一行不会让人多拼一颗豆 —— 页眉里写明了行号范围。
 */

/** 一页在整张图纸里的位置，附带它在分页矩阵中的行列号 */
export interface PageRegion extends SvgRegion {
  /** 从 1 开始 */
  pageRow: number
  pageCol: number
}

/** 相邻页之间重叠的行列数 */
export const PAGE_OVERLAP = 1

/**
 * 把图纸切成打印页。
 *
 * @param rows 图纸总行数
 * @param cols 图纸总列数
 * @param rowsPerPage 每页最多几行
 * @param colsPerPage 每页最多几列
 */
export function paginatePattern(
  rows: number,
  cols: number,
  rowsPerPage: number,
  colsPerPage: number,
): PageRegion[] {
  const totalRows = Math.max(1, Math.floor(rows))
  const totalCols = Math.max(1, Math.floor(cols))

  // 每页至少 1 格，且步进至少要 1，否则下面的循环不会前进
  const rpp = Math.min(totalRows, Math.max(1, Math.floor(rowsPerPage)))
  const cpp = Math.min(totalCols, Math.max(1, Math.floor(colsPerPage)))
  const rStep = Math.max(1, rpp - PAGE_OVERLAP)
  const cStep = Math.max(1, cpp - PAGE_OVERLAP)

  const rowStarts: number[] = []
  for (let r = 0; r < totalRows; r += rStep) {
    rowStarts.push(r)
    if (r + rpp >= totalRows) break
  }

  const colStarts: number[] = []
  for (let c = 0; c < totalCols; c += cStep) {
    colStarts.push(c)
    if (c + cpp >= totalCols) break
  }

  const pages: PageRegion[] = []
  for (let pr = 0; pr < rowStarts.length; pr++) {
    for (let pc = 0; pc < colStarts.length; pc++) {
      const rowStart = rowStarts[pr]!
      const colStart = colStarts[pc]!
      pages.push({
        rowStart,
        colStart,
        rowEnd: Math.min(totalRows, rowStart + rpp),
        colEnd: Math.min(totalCols, colStart + cpp),
        pageRow: pr + 1,
        pageCol: pc + 1,
      })
    }
  }

  return pages
}

/**
 * A4 纸扣掉页边距之后的可用区域（毫米）。
 *
 * 页边距按 12 毫米算（与打印文档里的 `@page` 一致），再各留 2 毫米余量。
 * 这 2 毫米不是可有可无的：打印机的非打印区、用户在打印对话框里
 * 选了别的页边距，都会吃掉一点空间。宁可偶尔多分一页，
 * 也不要让最后一列豆子被裁掉 —— 裁掉的那一列用户往往拼到一半才发现，
 * 而且他手里那张图纸看不出少了一列。
 */
export const A4_CONTENT_MM = { width: 182, height: 269 }

/** 页眉（"第 2/6 页 · 行 26–50"那行字）占用的高度，单位毫米 */
export const HEADER_MM = 7

/** 打印页边距，与打印文档的 `@page { margin }` 是同一个数 */
export const PAGE_MARGIN_MM = 12

/**
 * 按纸张算一页能放多少格。
 *
 * 格子大小由"实际尺寸 × 打印倍率"决定，跟图纸总大小无关 ——
 * 所以每页能放几格也是定值，不随图纸变化。
 * 比如 5 毫米豆按 1.5 倍印，一格 7.5 毫米，A4 上一页正好 24 列 × 35 行。
 */
export function pagesPerSheet(options: {
  beadSizeMm: number
  printScale: number
  showRuler: boolean
}): { rowsPerPage: number; colsPerPage: number } {
  const mmPerCell = Math.max(0.5, options.beadSizeMm * options.printScale)
  // 标尺按格子尺寸成比例占位，宽度约等于 0.9 格
  const rulerMm = options.showRuler ? mmPerCell * 0.9 : 0

  return {
    colsPerPage: Math.max(
      1,
      Math.floor((A4_CONTENT_MM.width - rulerMm) / mmPerCell),
    ),
    rowsPerPage: Math.max(
      1,
      Math.floor((A4_CONTENT_MM.height - rulerMm - HEADER_MM) / mmPerCell),
    ),
  }
}
