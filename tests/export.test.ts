import { describe, expect, it } from 'vitest'

import { clampCell, resolveExportCellSize } from '../src/core/export/raster'
import { patternToSvg } from '../src/core/export/svg'
import { toPatternColor } from '../src/core/pattern/types'
import type { Pattern, PatternColor } from '../src/core/pattern/types'
import type { PaletteColor } from '../src/core/palette/types'

/**
 * 导出模块的测试。
 *
 * 重点是 SVG —— 它是纯函数，能在 node 里完整验证，
 * 而且它承载的是"用户打印出来照着摆"这条最要紧的路径：
 * 物理尺寸写错一点、图层顺序反了，用户要摆到一半才会发现。
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

/** 用扁平的下标数组造一张图纸；-1 表示空格 */
function makePattern(
  rows: number,
  cols: number,
  cells: number[],
  beadSizeMm: 2.6 | 5 | 10 = 5,
): Pattern {
  return {
    rows,
    cols,
    beadSizeMm,
    colors: [RED, BLUE],
    grid: Int16Array.from(cells),
    title: '测试图纸',
  }
}

const DEFAULT_SVG_OPTS = {
  mode: 'color' as const,
  showRuler: false,
  majorEvery: 5,
  showCode: false,
  cellSize: 10,
  printScale: 1,
}

/** 取出某个元素上某个属性的值，避免对整个 SVG 文本做脆弱的全局匹配 */
function attr(svg: string, tagPrefix: string, name: string): string {
  const at = svg.indexOf(tagPrefix)
  expect(at, `找不到元素 ${tagPrefix}`).toBeGreaterThanOrEqual(0)

  const start = svg.indexOf(`${name}="`, at)
  expect(start, `元素 ${tagPrefix} 上没有属性 ${name}`).toBeGreaterThanOrEqual(0)

  const from = start + name.length + 2
  return svg.slice(from, svg.indexOf('"', from))
}

describe('SVG 导出', () => {
  it('输出是结构完整的 svg 根元素', () => {
    const svg = patternToSvg(makePattern(2, 2, [0, 1, 1, 0]), DEFAULT_SVG_OPTS)

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    // 标签成对出现，不能有未闭合的元素
    expect((svg.match(/<g\b/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length)
    expect(svg).not.toContain('undefined')
    expect(svg).not.toContain('NaN')
  })

  it('viewBox 按格数×格宽给出，不含标尺时正好铺满', () => {
    const svg = patternToSvg(makePattern(3, 4, new Array(12).fill(0)), DEFAULT_SVG_OPTS)
    expect(svg).toContain('viewBox="0 0 40 30"')
  })

  it('物理尺寸按豆径换算成毫米 —— 打印出来要能垫在底板下面', () => {
    // 4 格 × 5mm × 1 倍 = 20 毫米，3 格 × 5mm = 15 毫米
    const svg = patternToSvg(
      makePattern(3, 4, new Array(12).fill(0), 5),
      { ...DEFAULT_SVG_OPTS, printScale: 1 },
    )
    expect(svg).toContain('width="20mm"')
    expect(svg).toContain('height="15mm"')
  })

  it('打印倍率等比放大物理尺寸，但坐标系统不变', () => {
    const pattern = makePattern(3, 4, new Array(12).fill(0), 5)

    const one = patternToSvg(pattern, { ...DEFAULT_SVG_OPTS, printScale: 1 })
    const two = patternToSvg(pattern, { ...DEFAULT_SVG_OPTS, printScale: 2 })

    expect(one).toContain('width="20mm"')
    expect(two).toContain('width="40mm"')
    // viewBox 是同一个，所以放大打印不会让格子内容错位
    expect(two).toContain('viewBox="0 0 40 30"')
  })

  it('换豆子规格只改毫米数，不改像素布局', () => {
    const small = patternToSvg(makePattern(2, 2, [0, 0, 0, 0], 2.6), DEFAULT_SVG_OPTS)
    const large = patternToSvg(makePattern(2, 2, [0, 0, 0, 0], 10), DEFAULT_SVG_OPTS)

    expect(small).toContain('viewBox="0 0 20 20"')
    expect(large).toContain('viewBox="0 0 20 20"')
    expect(small).toContain('width="5.2mm"')
    expect(large).toContain('width="20mm"')
  })

  it('同色相邻格子合并成一条路径，体积才压得下来', () => {
    // 一行 5 个同色格子 → 应该只有一条 h50 的水平线段，而不是 5 个方块
    const svg = patternToSvg(makePattern(1, 5, [0, 0, 0, 0, 0]), DEFAULT_SVG_OPTS)
    const d = attr(svg, '<path fill="#ff0000"', 'd')

    expect(d).toBe('M0 0h50v10h-50z')
    // 整条路径只有一次提笔
    expect(d.match(/M/g)?.length).toBe(1)
  })

  it('颜色不同处断开成多条路径', () => {
    const svg = patternToSvg(makePattern(1, 4, [0, 0, 1, 1]), DEFAULT_SVG_OPTS)

    // 每个颜色各自一条 path
    expect(svg.match(/<path fill="#ff0000"/g)?.length).toBe(1)
    expect(svg.match(/<path fill="#0000ff"/g)?.length).toBe(1)
    expect(svg).toContain('h20')
  })

  it('空格填白色且不会被当成颜色 0', () => {
    const svg = patternToSvg(makePattern(1, 2, [-1, -1]), DEFAULT_SVG_OPTS)

    expect(svg).toContain('<path fill="#ffffff"')
    expect(svg).not.toContain('#ff0000')
  })

  it('符号模式一律白底 —— 彩色底色在黑白打印时会糊掉符号', () => {
    const svg = patternToSvg(makePattern(2, 2, [0, 1, 0, 1]), {
      ...DEFAULT_SVG_OPTS,
      mode: 'symbol',
      showCode: true,
    })

    expect(svg).not.toContain('fill="#ff0000"')
    expect(svg).not.toContain('fill="#0000ff"')
    expect(svg).toContain('<path fill="#ffffff"')
  })

  it('标尺开启时才绘制行列号，且编号从 1 开始', () => {
    const without = patternToSvg(makePattern(2, 2, [0, 0, 0, 0]), DEFAULT_SVG_OPTS)
    expect(without).not.toContain('<text')

    const withRuler = patternToSvg(makePattern(2, 2, [0, 0, 0, 0]), {
      ...DEFAULT_SVG_OPTS,
      showRuler: true,
      showCode: true,
    })
    expect(withRuler).toContain('>1</text>')
    expect(withRuler).toContain('>2</text>')
    // 0 号不该出现，图纸的行列是从 1 数起的
    expect(withRuler).not.toContain('>0</text>')
  })

  it('标尺会额外占用画布尺寸，不覆盖第一行格子', () => {
    const svg = patternToSvg(makePattern(2, 2, [0, 0, 0, 0]), {
      ...DEFAULT_SVG_OPTS,
      showRuler: true,
    })
    // 标尺宽度取 max(14, cellSize×0.9) = 14
    expect(svg).toContain('viewBox="0 0 34 34"')
  })

  it('色号里的特殊字符被转义，不会破坏 XML', () => {
    const nasty: PatternColor = { ...RED, code: '<A&' }
    const pattern: Pattern = {
      ...makePattern(1, 1, [0]),
      colors: [nasty],
    }

    // 格子要够大，否则色号会先被截断，测不到转义
    const svg = patternToSvg(pattern, {
      ...DEFAULT_SVG_OPTS,
      showCode: true,
      cellSize: 24,
    })

    expect(svg).toContain('>&lt;A&amp;</text>')
    expect(svg).not.toContain('<A&')
  })

  it('色号放不下时退成符号，绝不截断 —— 截断的色号会互相混淆', () => {
    const pattern: Pattern = {
      ...makePattern(1, 1, [0]),
      colors: [{ ...RED, code: '<A&B-C' }],
    }

    // 20px 的格子放不下 6 个字符。曾经这里会截成「<A&B」，那是错的做法：
    // Perler 的 80-19001 与 80-19002 会一起变成「80-1」，几十个色号无法区分。
    // 符号虽然要查图例，但它无歧义。
    const svg = patternToSvg(pattern, {
      ...DEFAULT_SVG_OPTS,
      showCode: true,
      cellSize: 20,
    })

    expect(svg).toContain('>A</text>')
    expect(svg).not.toContain('&lt;A&amp;')
  })

  it('色号短到放得下时照常显示，不因上一条而过于保守', () => {
    const pattern: Pattern = {
      ...makePattern(1, 1, [0]),
      colors: [{ ...RED, code: 'A12' }],
    }
    const svg = patternToSvg(pattern, {
      ...DEFAULT_SVG_OPTS,
      showCode: true,
      cellSize: 20,
    })
    expect(svg).toContain('>A12</text>')
  })

  it('同一个格子里，MARD 的短色号显示色号、Perler 的长色号退成符号', () => {
    const mard: Pattern = { ...makePattern(1, 1, [0]), colors: [{ ...RED, code: 'H12' }] }
    const perler: Pattern = {
      ...makePattern(1, 1, [0]),
      colors: [{ ...RED, code: '80-19001' }],
    }
    const opts = { ...DEFAULT_SVG_OPTS, showCode: true, cellSize: 24 }

    expect(patternToSvg(mard, opts)).toContain('>H12</text>')
    expect(patternToSvg(perler, opts)).toContain('>A</text>')
  })

  it('格子小到写不下色号时退化成单字符符号，而不是硬塞', () => {
    const pattern: Pattern = {
      ...makePattern(1, 1, [0]),
      colors: [{ ...RED, code: '<A&B-C' }],
    }

    // 10px 一格塞不下任何色号，此时应该改用符号
    const svg = patternToSvg(pattern, {
      ...DEFAULT_SVG_OPTS,
      showCode: true,
      cellSize: 10,
    })
    expect(svg).toContain('>A</text>')
    expect(svg).not.toContain('&lt;')
  })

  it('网格线始终绘制，加粗线按 majorEvery 落位', () => {
    const svg = patternToSvg(makePattern(10, 10, new Array(100).fill(0)), {
      ...DEFAULT_SVG_OPTS,
      majorEvery: 5,
    })

    expect(svg).toContain('stroke="#c8ccd0"')
    // 10×10、每 5 格加粗 → 第 5 行/列两条
    expect(svg).toContain('stroke="#495057"')
    expect(svg).toContain('stroke-width="2"')
  })

  it('关闭加粗时不再输出加粗图层', () => {
    const svg = patternToSvg(makePattern(10, 10, new Array(100).fill(0)), {
      ...DEFAULT_SVG_OPTS,
      majorEvery: 0,
    })
    expect(svg).not.toContain('#495057')
  })

  it('大图纸也能生成，且不包含 NaN 坐标', () => {
    const cells = new Array(300 * 300).fill(0)
    for (let i = 0; i < cells.length; i += 7) cells[i] = 1

    const svg = patternToSvg(makePattern(300, 300, cells), DEFAULT_SVG_OPTS)
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('Infinity')
    expect(svg.startsWith('<svg')).toBe(true)
  })
})

describe('导出格子尺寸', () => {
  it('给定 cellSize 时原样使用', () => {
    expect(resolveExportCellSize(20, 20, { cellSize: 24 })).toBe(24)
  })

  it('给定目标宽度时按列数反推，并向下取整', () => {
    // 1000 / 37 = 27.03 → 27，不能是 27.03，否则网格线落在半个像素上
    expect(resolveExportCellSize(10, 37, { targetWidth: 1000 })).toBe(27)
  })

  it('不超过单格像素上限', () => {
    // 20 / 2 本来是 10，但上限是 6
    expect(resolveExportCellSize(2, 2, { targetWidth: 20, maxCellSize: 6 })).toBe(6)
  })

  it('总像素超限时自动退让 —— 否则浏览器会静默产出全白画布', () => {
    // 300×300 在 64px/格下是 3.7 亿像素，远超上限
    const size = resolveExportCellSize(300, 300, { cellSize: 64 })
    expect(size).toBeLessThan(64)
    expect(300 * 300 * size * size).toBeLessThanOrEqual(160_000_000)
    expect(size).toBeGreaterThanOrEqual(2)
  })

  it('永远不小于 2 像素，哪怕是极端的图纸尺寸', () => {
    expect(resolveExportCellSize(5000, 5000, { cellSize: 64 })).toBeGreaterThanOrEqual(2)
    expect(resolveExportCellSize(1, 1, { targetWidth: 0.001 })).toBeGreaterThanOrEqual(2)
  })

  it('非有限或非正输入回退到安全值，而不是产出 NaN 画布', () => {
    // 非有限值在这里没有"更大/更小"的语义，一律当成无效输入，
    // 给一个确定能用的默认值。要点是绝不能把 NaN 传进 canvas.width。
    for (const bad of [NaN, Infinity, -Infinity, 0, -5]) {
      const size = clampCell(bad, 10, 10)
      expect(Number.isFinite(size)).toBe(true)
      expect(Number.isInteger(size)).toBe(true)
      expect(size).toBe(8)
    }
  })

  it('结果恒为整数', () => {
    for (const cols of [7, 13, 29, 37, 48, 100, 299]) {
      const size = resolveExportCellSize(50, cols, { targetWidth: 2400 })
      expect(Number.isInteger(size)).toBe(true)
    }
  })
})
