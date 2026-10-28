// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { printPattern } from '../src/core/export/print'
import type { PrintOptions } from '../src/core/export/print'
import { computeStats } from '../src/core/pattern/stats'
import { toPatternColor } from '../src/core/pattern/types'
import type { Pattern, PatternColor } from '../src/core/pattern/types'
import type { PaletteColor } from '../src/core/palette/types'

/**
 * 打印文档的测试。
 *
 * 打印是这个工具最终要交付的东西 —— 用户拿着它照着摆豆子。
 * 但它在浏览器里才跑得起来，又是"打开新窗口写 HTML"这种最容易写错的形式，
 * 所以这里把 window.open 拦下来，直接检查写出去的那份文档：
 * 分了几页、每页画的是哪一块、断页标记有没有、图例在不在。
 */

function color(code: string, hex: string, name = code): PatternColor {
  const palette: PaletteColor = {
    id: `test.${code}`,
    code,
    name,
    hex,
    rgb: [0, 0, 0],
    kind: 'solid',
  }
  return toPatternColor(palette)
}

const RED = color('T01', '#ff0000', '大红')
const BLUE = color('T02', '#0000ff', '宝蓝')

function makePattern(rows: number, cols: number, beadSizeMm: 2.6 | 5 | 10 = 5): Pattern {
  const grid = new Int16Array(rows * cols)
  for (let i = 0; i < grid.length; i++) grid[i] = i % 2
  return { rows, cols, beadSizeMm, colors: [RED, BLUE], grid, title: '打印测试' }
}

const OPTS: Omit<PrintOptions, 'stats'> = {
  mode: 'color',
  showRuler: true,
  majorEvery: 5,
  showCode: true,
  cellSize: 24,
  printScale: 1.5,
  boardSize: 29,
}

/** 拦下 window.open，返回它写进去的整份文档 */
function capture(
  pattern: Pattern,
  options: Partial<PrintOptions> = {},
): { opened: boolean; doc: string } {
  const chunks: string[] = []
  const fake = {
    document: {
      open(): void {},
      write(s: string): void {
        chunks.push(s)
      },
      close(): void {},
    },
    addEventListener(): void {},
    focus(): void {},
    print(): void {},
  }
  const spy = vi
    .spyOn(window, 'open')
    .mockReturnValue(fake as unknown as Window & typeof globalThis)

  const opened = printPattern(pattern, {
    ...OPTS,
    stats: computeStats(pattern),
    ...options,
  })
  spy.mockRestore()

  return { opened, doc: chunks.join('') }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('打印文档', () => {
  it('弹窗被拦截时如实返回 false，而不是假装成功', () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null)
    const opened = printPattern(makePattern(4, 4), {
      ...OPTS,
      stats: computeStats(makePattern(4, 4)),
    })
    spy.mockRestore()
    expect(opened).toBe(false)
  })

  it('小图纸只有一页，不写页码', () => {
    const { opened, doc } = capture(makePattern(10, 10))

    expect(opened).toBe(true)
    expect(doc).toContain('<svg')
    expect(doc).not.toContain('第 1/1 页')
    // 只有一页时用可缩放的排法，不必分页
    expect(doc).toContain('class="sheet"')
    expect(doc).not.toContain('class="page"')
  })

  it('大图纸自动分页，每页各画一块并写明行号列号', () => {
    // 100×100 在 5 毫米豆 1.5 倍下，一张 A4 放不下
    const { doc } = capture(makePattern(100, 100))

    expect(doc).toContain('class="page"')
    const captions = [...doc.matchAll(/第 (\d+)\/(\d+) 页/g)]
    expect(captions.length).toBeGreaterThan(1)

    // 页码连续且总数一致
    const total = Number(captions[0]![2])
    expect(captions.map((m) => Number(m[1]))).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    )

    // 第一页管的是整张图的开头
    expect(doc).toContain('行 1–34')
    expect(doc).toContain('列 1–23')
  })

  it('分页时每一页都画了颜色，没有空白页', () => {
    const { doc } = capture(makePattern(100, 100))
    const pages = doc.split('class="page"').slice(1)

    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      const svg = page.slice(0, page.indexOf('</svg>'))
      expect(svg).toMatch(/<path fill="#(ff0000|0000ff)"/)
    }
  })

  it('每页各自断页，最后一页不留下多余的空白页', () => {
    const { doc } = capture(makePattern(100, 100))
    // CSS 里靠 page-break-after 分页；末页要复位，否则会多印一张白纸
    expect(doc).toContain('page-break-after: always')
    expect(doc).toContain('.page:last-of-type { page-break-after: auto')
  })

  it('显式关掉分页时压成一页 —— 此时不该出现分页标记', () => {
    const { doc } = capture(makePattern(100, 100), { paginate: false })

    expect(doc).toContain('class="sheet"')
    expect(doc).not.toContain('class="page"')
    expect(doc).not.toContain('第 1/')
    // 这条路径允许缩放，尺寸就不准了，所以代码里刻意不加 max-width
    expect(doc).toContain('.sheet svg { max-width: 100%')
  })

  it('分页的图纸绝不允许缩放 —— 缩了尺寸就不对', () => {
    const { doc } = capture(makePattern(100, 100))
    expect(doc).toContain('.page svg { display: block; max-width: none; }')
  })

  it('用色表带着色号、颗数与购买量，并且单独起一页', () => {
    const { doc } = capture(makePattern(20, 20))

    // 用标签本身判断，别用"用色表"三个字 —— CSS 注释里也有
    expect(doc).toContain('<h2>用色表</h2>')
    expect(doc).toContain('T01')
    expect(doc).toContain('大红')
    expect(doc).toContain('需要')
    expect(doc).toContain('备货')
    expect(doc).toContain('包数')
    // 图例被分页线切开就没法用了，所以强制另起一页
    expect(doc).toContain('page-break-before: always')
  })

  it('统计缺失时照样出图纸，只是不带用量表', () => {
    const { doc } = capture(makePattern(10, 10), { stats: null })

    expect(doc).toContain('<svg')
    expect(doc).not.toContain('<h2>用色表</h2>')
    // 但规格行仍要有最基本的尺寸信息
    expect(doc).toContain('格')
  })

  it('抬头用图纸标题，且转义过', () => {
    const pattern = makePattern(8, 8)
    pattern.title = '猫 <&> 狗'
    const { doc } = capture(pattern)

    expect(doc).toContain('猫 &lt;&amp;&gt; 狗')
    expect(doc).toContain('<title>猫 &lt;&amp;&gt; 狗</title>')
  })

  it('抬头写了底板数量，用户才知道要买几块', () => {
    const { doc } = capture(makePattern(60, 60), { boardSize: 29 })
    expect(doc).toContain('底板')
    expect(doc).toContain('29×29')
  })
})
