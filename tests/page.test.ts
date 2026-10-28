import { describe, expect, it } from 'vitest'

import { PAGE_OVERLAP, pagesPerSheet, paginatePattern } from '../src/core/export/page'
import { patternToSvg } from '../src/core/export/svg'
import { toPatternColor } from '../src/core/pattern/types'
import type { Pattern, PatternColor } from '../src/core/pattern/types'
import type { PaletteColor } from '../src/core/palette/types'

/**
 * 分页与分页后的图纸渲染。
 *
 * 这里守的是一条容易被忽略、代价又很高的保证：**印出来必须是真实尺寸**。
 * 图纸放不下时浏览器会默默把 SVG 缩到纸宽，尺寸就不对了，
 * 而用户是拿它垫在底板下面照着摆的 —— 差一点整张图就废了，
 * 而且不拿尺子量根本发现不了。
 */

function color(code: string, hex: string): PatternColor {
  const palette: PaletteColor = {
    id: `test.${code}`,
    code,
    name: code,
    hex,
    rgb: [0, 0, 0],
    kind: 'solid',
  }
  return toPatternColor(palette)
}

const RED = color('T01', '#ff0000')
const BLUE = color('T02', '#0000ff')

/** 交替填色，让每一格都能被单独辨认出来 */
function makePattern(rows: number, cols: number, beadSizeMm: 2.6 | 5 | 10 = 5): Pattern {
  const grid = new Int16Array(rows * cols)
  for (let i = 0; i < grid.length; i++) grid[i] = i % 2
  return { rows, cols, beadSizeMm, colors: [RED, BLUE], grid, title: '分页测试' }
}

const OPTS = {
  mode: 'color' as const,
  showRuler: true,
  majorEvery: 5,
  showCode: true,
  cellSize: 40,
  printScale: 1.5,
}

/** 每格多少毫米：5mm 的豆按 1.5 倍印 */
const MM_PER_CELL = 5 * 1.5
/**
 * 标尺占的毫米数。cellSize=40 时标尺是 round(40*0.9)=36 像素，
 * 而 40 像素恰好对应 7.5 毫米，所以是 36 * 7.5 / 40 = 6.75 毫米。
 */
const RULER_MM = 6.75

/** 读 svg 根元素上的毫米尺寸 */
function mmOf(svg: string, name: 'width' | 'height'): number {
  const at = svg.indexOf(`${name}="`) + name.length + 2
  // 一定要从 at 往后找，否则会匹配到前面那个属性的 "mm"
  return Number(svg.slice(at, svg.indexOf('mm"', at)))
}

describe('分页切分', () => {
  it('放得下时只有一页', () => {
    expect(paginatePattern(10, 10, 20, 20)).toHaveLength(1)
  })

  it('页数与每页格数的关系正确', () => {
    // 100 列、每页 20 列、重叠 1 → 起点 0,19,38,57,76,95（共 6 页）
    const pages = paginatePattern(10, 100, 20, 20)
    const cols = [...new Set(pages.map((p) => p.colStart))]
    expect(cols).toEqual([0, 19, 38, 57, 76, 95])
  })

  it('相邻页之间重叠 1 行/列，方便对齐', () => {
    const pages = paginatePattern(100, 100, 20, 20)
    const first = pages[0]!
    expect(first.rowStart).toBe(0)
    expect(first.rowEnd).toBe(20)

    // 同一条行带里的下一页：与第一页的最后一列重叠
    const nextCol = pages.find((p) => p.pageRow === 1 && p.pageCol === 2)!
    expect(nextCol.colStart).toBe(first.colEnd - PAGE_OVERLAP)

    // 下一条行带的第一页：与第一页的最后一行重叠
    const nextRow = pages.find((p) => p.pageRow === 2 && p.pageCol === 1)!
    expect(nextRow.rowStart).toBe(first.rowEnd - PAGE_OVERLAP)
  })

  it('每一页都覆盖到最后一行/列，不会漏掉边缘', () => {
    const pages = paginatePattern(97, 53, 20, 20)
    const maxRow = Math.max(...pages.map((p) => p.rowEnd))
    const maxCol = Math.max(...pages.map((p) => p.colEnd))
    expect(maxRow).toBe(97)
    expect(maxCol).toBe(53)
  })

  it('每页的范围都不越界', () => {
    for (const p of paginatePattern(97, 53, 20, 20)) {
      expect(p.rowStart).toBeGreaterThanOrEqual(0)
      expect(p.colStart).toBeGreaterThanOrEqual(0)
      expect(p.rowEnd).toBeLessThanOrEqual(97)
      expect(p.colEnd).toBeLessThanOrEqual(53)
      expect(p.rowEnd).toBeGreaterThan(p.rowStart)
      expect(p.colEnd).toBeGreaterThan(p.colStart)
    }
  })

  it('页码从 1 开始，且按先行后列编号', () => {
    const pages = paginatePattern(100, 100, 20, 20)
    expect(pages[0]!.pageRow).toBe(1)
    expect(pages[0]!.pageCol).toBe(1)
    // 第一个换行的那一页
    const perRow = pages.filter((p) => p.pageRow === 1).length
    expect(pages[perRow]!.pageRow).toBe(2)
    expect(pages[perRow]!.pageCol).toBe(1)
  })

  it('每页只有 1 格也不会卡死', () => {
    const pages = paginatePattern(3, 3, 1, 1)
    // 1 格一页且重叠 1 → 重叠即整页，步进会被兜到 1，所以每行 3 页
    expect(pages.length).toBe(9)
    expect(pages.every((p) => p.rowEnd - p.rowStart === 1)).toBe(true)
  })

  it('退化输入不产生零页或死循环', () => {
    expect(paginatePattern(0, 0, 10, 10).length).toBeGreaterThanOrEqual(1)
    expect(paginatePattern(5, 5, 0, 0).length).toBeGreaterThanOrEqual(1)
    expect(paginatePattern(5, 5, -3, -3).length).toBeGreaterThanOrEqual(1)
    expect(paginatePattern(5, 5, 1.7, 1.7).length).toBeGreaterThanOrEqual(1)
  })
})

describe('按纸张算每页格数', () => {
  it('倍率越大，一页放下的格子越少', () => {
    const at1 = pagesPerSheet({ beadSizeMm: 5, printScale: 1, showRuler: true })
    const at2 = pagesPerSheet({ beadSizeMm: 5, printScale: 2, showRuler: true })
    expect(at2.colsPerPage).toBeLessThan(at1.colsPerPage)
    expect(at2.rowsPerPage).toBeLessThan(at1.rowsPerPage)
  })

  it('5 毫米豆 1.5 倍印，A4 上一页 23 列 34 行', () => {
    const per = pagesPerSheet({ beadSizeMm: 5, printScale: 1.5, showRuler: true })
    // 可用 182mm，扣掉标尺 6.75mm 后放得下 23 格（24 格要 186.75mm，超了）
    expect(per.colsPerPage).toBe(23)
    // 可用 269mm，扣掉标尺与页眉 7mm 后放得下 34 行
    expect(per.rowsPerPage).toBe(34)

    // 反过来说，这个列数必须真的塞得进纸张，否则会被裁掉一列
    expect(per.colsPerPage * MM_PER_CELL + RULER_MM).toBeLessThanOrEqual(182)
  })

  it('不画标尺时能多放一格', () => {
    const withRuler = pagesPerSheet({ beadSizeMm: 5, printScale: 1.5, showRuler: true })
    const without = pagesPerSheet({ beadSizeMm: 5, printScale: 1.5, showRuler: false })
    expect(without.colsPerPage).toBeGreaterThanOrEqual(withRuler.colsPerPage)
  })

  it('格子大到离谱时也至少给 1 格，不会算出 0', () => {
    const per = pagesPerSheet({ beadSizeMm: 10, printScale: 2, showRuler: true })
    expect(per.colsPerPage).toBeGreaterThanOrEqual(1)
    expect(per.rowsPerPage).toBeGreaterThanOrEqual(1)
  })

  it('豆子尺寸非法时不会崩溃', () => {
    const per = pagesPerSheet({ beadSizeMm: 0, printScale: 0, showRuler: false })
    expect(per.colsPerPage).toBeGreaterThanOrEqual(1)
    expect(per.rowsPerPage).toBeGreaterThanOrEqual(1)
  })
})

describe('分页渲染', () => {
  it('只画区域内的格子 —— 页面上不该出现别页的颜色块', () => {
    // 8×8，左半边全红、右半边全蓝；只导出右半边
    const pattern = makePattern(8, 8)
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 4; c++) pattern.grid[r * 8 + c] = 0
      for (let c = 4; c < 8; c++) pattern.grid[r * 8 + c] = 1
    }

    const svg = patternToSvg(pattern, {
      ...OPTS,
      region: { rowStart: 0, rowEnd: 8, colStart: 4, colEnd: 8 },
    })

    // 红色那一路径不该存在
    expect(svg).not.toContain('fill="#ff0000"')
    expect(svg).toContain('fill="#0000ff"')
  })

  it('区域的物理尺寸只按区域算，与整图无关', () => {
    const pattern = makePattern(20, 20)
    const whole = patternToSvg(pattern, OPTS)
    const half = patternToSvg(pattern, {
      ...OPTS,
      region: { rowStart: 0, rowEnd: 20, colStart: 0, colEnd: 10 },
    })

    // 10 格 × 7.5mm + 标尺 6.75mm
    expect(mmOf(half, 'width')).toBeCloseTo(10 * MM_PER_CELL + RULER_MM, 1)
    expect(mmOf(whole, 'width')).toBeGreaterThan(mmOf(half, 'width'))
  })

  it('同一批分页里，同样列数的页宽度完全相同 —— 各页共用一个比例', () => {
    const pattern = makePattern(60, 60)
    const per = pagesPerSheet({
      beadSizeMm: pattern.beadSizeMm,
      printScale: OPTS.printScale,
      showRuler: true,
    })
    const pages = paginatePattern(60, 60, per.rowsPerPage, per.colsPerPage)

    // 宽度直接反映比例。若某一页按自己的内容去适配纸张，
    // 它的宽度就会跟别页不一样，拼起来对不上 —— 这正是要防的。
    const widths = pages.map((p) => mmOf(patternToSvg(pattern, { ...OPTS, region: p }), 'width'))
    const byColCount = new Map<number, number>()
    for (let i = 0; i < pages.length; i++) {
      const cols = pages[i]!.colEnd - pages[i]!.colStart
      const seen = byColCount.get(cols)
      if (seen !== undefined) expect(widths[i]!).toBeCloseTo(seen, 5)
      else byColCount.set(cols, widths[i]!)
    }

    expect(widths[0]).toBeCloseTo(per.colsPerPage * MM_PER_CELL + RULER_MM, 1)
  })

  it('标尺用的是全图绝对行列号，而不是从 1 重数', () => {
    const pattern = makePattern(30, 30)
    // 第二页：行 20–30、列 20–30（绝对下标 19..29）
    const svg = patternToSvg(pattern, {
      ...OPTS,
      region: { rowStart: 19, rowEnd: 29, colStart: 19, colEnd: 29 },
    })

    // 区域第一行是第 20 行，所以要出现 20 而不是重新从 1 开始
    const labels = [...svg.matchAll(/<text[^>]*>(\d+)<\/text>/g)].map((m) => Number(m[1]))
    expect(labels).toContain(20)
    expect(labels).toContain(29)
  })

  it('页眉文字会画出来并占位，不会压到图纸上', () => {
    const pattern = makePattern(10, 10)
    const withCaption = patternToSvg(pattern, { ...OPTS, caption: '第 2/6 页' })
    const without = patternToSvg(pattern, OPTS)

    expect(withCaption).toContain('第 2/6 页')

    // 多了页眉，整张纸就更高，否则说明文字会盖在图纸上
    expect(mmOf(withCaption, 'height')).toBeGreaterThan(mmOf(without, 'height'))
  })

  it('页眉里的特殊字符被转义，不会破坏 SVG', () => {
    const svg = patternToSvg(makePattern(4, 4), {
      ...OPTS,
      caption: '行 1–4 & <列 5>',
    })
    expect(svg).toContain('&amp;')
    expect(svg).toContain('&lt;')
    expect(svg).not.toContain('<列 5>')
  })

  it('越界的区域被夹回图内，不会产出空白页', () => {
    const svg = patternToSvg(makePattern(10, 10), {
      ...OPTS,
      region: { rowStart: 8, rowEnd: 99, colStart: 8, colEnd: 99 },
    })
    // 仍然画了东西（有颜色块），而不是只剩背景
    expect(svg).toContain('fill="#ff0000"')
    expect(svg).toContain('fill="#0000ff"')
  })

  it('反面区间（结束小于开始）被夹成恰好一格，而不是一张白页', () => {
    const svg = patternToSvg(makePattern(10, 10), {
      ...OPTS,
      region: { rowStart: 5, rowEnd: 2, colStart: 5, colEnd: 2 },
    })

    // 只剩一格：宽度正好是 1 格加标尺
    expect(mmOf(svg, 'width')).toBeCloseTo(MM_PER_CELL + RULER_MM, 2)
    // 而且这一格是画了颜色的 —— 白页是最难排查的故障
    expect(svg).toMatch(/<path fill="#(ff0000|0000ff)"/)
  })

  it('省略 region 时与整图渲染完全一致', () => {
    const pattern = makePattern(12, 12)
    const implicit = patternToSvg(pattern, OPTS)
    const explicit = patternToSvg(pattern, {
      ...OPTS,
      region: { rowStart: 0, rowEnd: 12, colStart: 0, colEnd: 12 },
    })
    expect(explicit).toBe(implicit)
  })
})
