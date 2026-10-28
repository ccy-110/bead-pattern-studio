import type { PatternStats } from '../pattern/types'
import type { Pattern } from '../pattern/types'
import { displayName } from '../palette/types'
import { boardsNeeded } from '../pattern/sizing'
import { symbolFor } from '../pattern/symbols'
import { pagesPerSheet, paginatePattern } from './page'
import { patternToSvg } from './svg'
import type { SvgExportOptions } from './svg'

export interface PrintOptions extends SvgExportOptions {
  stats: PatternStats | null
  boardSize: number
  /**
   * 分页打印。省略时自动判断：整张图纸放不下一张 A4 就分页。
   *
   * 之所以要自动判断，是因为"放不下"这件事用户看不出来 ——
   * 浏览器会把过大的 SVG 静默缩到纸宽，印出来的尺寸就不对了，
   * 而图纸尺寸错了整张图纸就废了。
   */
  paginate?: boolean
}

/**
 * 分页时每格在 SVG 内部用多少像素。
 *
 * 这个值不影响打印出来的物理尺寸（那是由毫米单位决定的），
 * 只决定矢量图内部的分辨率与字号。取 40 是因为
 * `resolveDetail` 在格子 ≥ 20 像素时才肯写色号 ——
 * 分页之后每页格子数不多，完全给得起这个分辨率，
 * 让每一页都能看清色号。
 */
const PAGE_CELL_PX = 40

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

/**
 * 打印图纸。
 *
 * 走的是"新开一个窗口写整份 HTML"这条路，而不是在当前页面上做 print 样式。
 * 原因很直接：打印稿需要的是**图纸 + 图例 + 参数摘要**这一份自成一体的文档，
 * 而应用界面里有滚动容器、固定定位的侧栏、深色主题 —— 为了打印把它们全部
 * 覆盖掉，写出来的 CSS 比重新生成一份文档还多，还容易被后续改动破坏。
 *
 * 图例不是可选项。图纸上每格只有色号或符号，没有对照表就完全没法用：
 * 用户拿着打印稿，需要知道"△ 是 P17 柠檬黄，要 236 颗"。
 *
 * @returns 是否成功。弹窗被拦截时返回 false，由调用方提示用户。
 */
export function printPattern(pattern: Pattern, options: PrintOptions): boolean {
  const win = window.open('', '_blank')
  if (!win) {
    return false
  }

  const { stats } = options
  const boards = boardsNeeded(pattern.rows, pattern.cols, options.boardSize)

  const metaParts = [
    `${pattern.cols} × ${pattern.rows} 格`,
    `成品约 ${(stats?.widthMm ?? pattern.cols * pattern.beadSizeMm).toFixed(0)} × ${(
      stats?.heightMm ?? pattern.rows * pattern.beadSizeMm
    ).toFixed(0)} 毫米`,
    `${pattern.beadSizeMm} 毫米豆`,
    stats ? `共 ${stats.totalBeads} 颗豆` : '',
    stats ? `${stats.colorCount} 种颜色` : '',
    `底板 ${boards.across} × ${boards.down} = ${boards.total} 块（${options.boardSize}×${options.boardSize}）`,
  ].filter(Boolean)

  // ---- 图纸：先定下分几页，再逐页生成 ----
  const perSheet = pagesPerSheet({
    beadSizeMm: pattern.beadSizeMm,
    printScale: options.printScale,
    showRuler: options.showRuler,
  })
  const pages = paginatePattern(
    pattern.rows,
    pattern.cols,
    perSheet.rowsPerPage,
    perSheet.colsPerPage,
  )

  // paginatePattern 在放得下时必然只返回一页，所以页数本身就是"放不放得下"
  const paginate = options.paginate ?? pages.length > 1

  const multi = pages.length > 1

  const gridHtml = paginate
    ? pages
        .map((page, i) => {
          const svg = patternToSvg(pattern, {
            ...options,
            cellSize: Math.max(options.cellSize, PAGE_CELL_PX),
            region: page,
            // 只有一页时不写页眉：没有第二页要对位，"第 1/1 页"纯属噪音
            ...(multi
              ? {
                  caption:
                    `第 ${i + 1}/${pages.length} 页　·　` +
                    `行 ${page.rowStart + 1}–${page.rowEnd}　·　列 ${page.colStart + 1}–${page.colEnd}　·　` +
                    `相邻页重叠 1 格，照重叠的那一行对齐`,
                }
              : {}),
          })
          return `<div class="page">${svg}</div>`
        })
        .join('')
    : `<div class="sheet">${patternToSvg(pattern, options)}</div>`

  // ---- 图例 ----
  const legendHtml = buildLegend(stats)

  const doc = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(pattern.title || '拼豆图纸')}</title>
<style>
  @page { margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 12px/1.5 "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #212529;
    background: #fff;
  }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .meta { color: #6c757d; font-size: 11px; margin-bottom: 10px; }
  .meta span { margin-right: 14px; white-space: nowrap; }
  .sheet { text-align: center; }
  .sheet svg { max-width: 100%; height: auto; }

  /*
   * 分页的图纸**绝不能**加 max-width:100%。
   * 每页都是按纸张算好尺寸的，一旦允许缩放，浏览器就会悄悄缩小它，
   * 于是"按真实尺寸打印"这条保证失效 —— 用户拿尺子一比才发现差了一截。
   * 宁可让内容溢出（看得见的错），也不要静默改尺寸（看不见的错）。
   */
  .page { page-break-after: always; break-after: page; }
  .page:last-of-type { page-break-after: auto; break-after: auto; }
  .page svg { display: block; max-width: none; }

  /*
   * 用色表另起一页。跟图纸挤在同一页时，它要么被压到页脚的一角，
   * 要么正好被分页线切开 —— 而这张表是买东西时唯一要看的东西。
   */
  .legend { page-break-before: always; break-before: page; }
  .legend h2 { font-size: 13px; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border-bottom: 1px solid #dee2e6; padding: 2px 6px; text-align: left; }
  th { background: #f1f3f5; font-weight: 600; }
  td.num, th.num { text-align: right; width: 56px; }
  td.sym { width: 22px; text-align: center; font-weight: 700; }
  /* 色号宽度随品牌变化很大（MARD 是 A1，Perler 是 80-19001），
     固定列宽会让长色号折行、把该行撑高并与右侧数字错位 */
  td.code { white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.sw { width: 26px; }
  td.sw span {
    display: inline-block; width: 18px; height: 18px;
    border: 1px solid #ced4da; border-radius: 3px; vertical-align: middle;
  }
  .tip { margin-top: 10px; color: #868e96; font-size: 10px; }
  @media print { .tip { color: #adb5bd; } }
</style>
</head>
<body>
  <h1>${esc(pattern.title || '拼豆图纸')}</h1>
  <div class="meta">${metaParts.map((p) => `<span>${esc(p)}</span>`).join('')}</div>
  ${gridHtml}
  ${legendHtml}
</body>
</html>`

  win.document.open()
  win.document.write(doc)
  win.document.close()

  // 等 SVG 与字体排完版再唤起打印框，否则可能印出空白页
  win.addEventListener('load', () => {
    win.focus()
    win.print()
  })

  return true
}

/** 用色表。排版上另起一页，见上面 CSS 里的说明。 */
function buildLegend(stats: PatternStats | null): string {
  const rows = stats?.colors ?? []
  if (rows.length === 0) return ''

  // 大部分国产品牌（MARD、COCO、漫漫、盼盼、咪小窝）没有颜色名，数据里 name 就是色号。
  // 这时名称列整列都是重复信息（「A1 A1」），索性不渲染，把宽度让给色号。
  const hasNames = rows.some((row) => displayName(row.color) !== '')

  const body = rows
    .map(
      (row) => `
      <tr>
        <td class="sw"><span style="background:${esc(row.color.hex)}"></span></td>
        <td class="sym">${esc(symbolFor(row.colorIndex))}</td>
        <td class="code">${esc(row.color.code)}</td>
        ${hasNames ? `<td class="name">${esc(row.color.name)}</td>` : ''}
        <td class="num">${row.count}</td>
        <td class="num">${row.purchase}</td>
        <td class="num">${row.packs}</td>
      </tr>`,
    )
    .join('')

  return `<div class="legend">
    <h2>用色表</h2>
    <table>
      <thead>
        <tr>
          <th colspan="${hasNames ? 4 : 3}">颜色</th>
          <th class="num">需要</th>
          <th class="num">备货</th>
          <th class="num">包数</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
    <div class="tip">「备货」已含损耗余量，按此数量购买可避免中途缺色。包数按整包折算。</div>
  </div>`
}
