import { describe, expect, it } from 'vitest'
import {
  computeStats,
  parsePatternFile,
  planBoards,
  serializePattern,
  suggestFileName,
} from '../src/core/pattern'
import type { Pattern, PatternColor } from '../src/core/pattern'
import { PatternParseError } from '../src/core/pattern'
import { symbolFor, SYMBOL_SEQUENCE } from '../src/core/pattern/symbols'

const COLORS: PatternColor[] = [
  { id: 't.T01', code: 'T01', name: '白', hex: '#ffffff', kind: 'solid' },
  { id: 't.T02', code: 'T02', name: '黑', hex: '#000000', kind: 'solid' },
  { id: 't.T03', code: 'T03', name: '红', hex: '#ff0000', kind: 'solid' },
]

function makePattern(rows: number, cols: number, values: number[]): Pattern {
  if (values.length !== rows * cols) {
    throw new Error('测试数据长度不匹配')
  }
  return {
    rows,
    cols,
    beadSizeMm: 5,
    colors: COLORS,
    grid: Int16Array.from(values),
    title: '测试图纸',
  }
}

describe('用量统计', () => {
  it('正确计数并排除空格', () => {
    // 2×2：白、黑、红、空格
    const p = makePattern(2, 2, [0, 1, 2, -1])
    const stats = computeStats(p)

    expect(stats.totalBeads).toBe(3)
    expect(stats.emptyCells).toBe(1)
    expect(stats.colorCount).toBe(3)
    expect(stats.fillRatio).toBeCloseTo(0.75, 6)
  })

  it('按用量降序排列 —— 用户最关心哪种用得最多', () => {
    // 5 格：3 个红、1 个白、1 个黑
    const p = makePattern(5, 1, [2, 2, 2, 0, 1])
    const stats = computeStats(p)

    expect(stats.colors[0]!.color.code).toBe('T03')
    expect(stats.colors[0]!.count).toBe(3)
    expect(stats.colors[1]!.count).toBe(1)
    expect(stats.colors[2]!.count).toBe(1)
  })

  it('建议备货量包含损耗并向上取整', () => {
    const p = makePattern(1, 10, Array(10).fill(0))
    // 损耗 20%：10 颗 → 12 颗
    const stats = computeStats(p, { wasteRatio: 0.2, beadsPerPack: 1000 })
    expect(stats.colors[0]!.count).toBe(10)
    expect(stats.colors[0]!.purchase).toBe(12)
  })

  it('折算整包数，至少 1 包', () => {
    const p = makePattern(1, 3, [0, 0, 0])
    const stats = computeStats(p, { wasteRatio: 0, beadsPerPack: 1000 })
    // 只要 3 颗，但豆子按包卖，仍然是 1 包
    expect(stats.colors[0]!.packs).toBe(1)

    const big = makePattern(1, 2500, Array(2500).fill(0))
    const bigStats = computeStats(big, { wasteRatio: 0, beadsPerPack: 1000 })
    expect(bigStats.colors[0]!.packs).toBe(3)
  })

  it('物理尺寸 = 格数 × 豆子直径', () => {
    const p: Pattern = {
      rows: 20,
      cols: 30,
      beadSizeMm: 5,
      colors: COLORS,
      grid: new Int16Array(600).fill(0),
      title: '尺寸测试',
    }
    const stats = computeStats(p)
    expect(stats.widthMm).toBe(150) // 30 × 5mm
    expect(stats.heightMm).toBe(100) // 20 × 5mm
  })

  it('同一张图换规格只改物理尺寸，不改网格', () => {
    const grid = new Int16Array(100).fill(0)
    const at5 = computeStats({ rows: 10, cols: 10, beadSizeMm: 5, colors: COLORS, grid, title: 'x' })
    const at26 = computeStats({ rows: 10, cols: 10, beadSizeMm: 2.6, colors: COLORS, grid, title: 'x' })

    expect(at5.totalBeads).toBe(at26.totalBeads) // 豆子颗数完全一样
    expect(at5.widthMm).toBe(50)
    expect(at26.widthMm).toBeCloseTo(26, 5)
  })

  it('数据损坏时明确报错，不静默产出错误统计', () => {
    const p = makePattern(2, 2, [0, 1, 2, 0])
    p.grid[3] = 99 // 越界下标
    expect(() => computeStats(p)).toThrow(/超出范围/)
  })
})

describe('分板方案', () => {
  it('图纸正好等于一块底板时只切一块', () => {
    // 回归测试：曾经的循环会多切出一块只含最后一行的废板
    const plan = planBoards(29, 29, 29, 1)
    expect(plan.totalBoards).toBe(1)
    expect(plan.tiles[0]!.rows).toBe(29)
    expect(plan.tiles[0]!.cols).toBe(29)
  })

  it('小于一块底板时也是一块', () => {
    const plan = planBoards(10, 15, 29, 1)
    expect(plan.totalBoards).toBe(1)
    expect(plan.tiles[0]!.rows).toBe(10)
    expect(plan.tiles[0]!.cols).toBe(15)
  })

  it('50×50 用 29 格底板切出 2×2 = 4 块', () => {
    const plan = planBoards(50, 50, 29, 1)
    expect(plan.totalBoards).toBe(4)
    expect(plan.boardRows).toBe(2)
    expect(plan.boardCols).toBe(2)
    expect(plan.tiles.map((t) => [t.rowOffset, t.colOffset])).toEqual([
      [0, 0],
      [0, 28],
      [28, 0],
      [28, 28],
    ])
  })

  it('每一格都至少被一块底板覆盖', () => {
    const rows = 73
    const cols = 41
    const plan = planBoards(rows, cols, 29, 1)

    const covered = new Uint8Array(rows * cols)
    for (const t of plan.tiles) {
      for (let r = 0; r < t.rows; r++) {
        for (let c = 0; c < t.cols; c++) {
          covered[(t.rowOffset + r) * cols + (t.colOffset + c)] = 1
        }
      }
    }
    expect(covered.every((v) => v === 1)).toBe(true)
  })

  it('相邻底板的重叠量始终一致', () => {
    const plan = planBoards(100, 100, 29, 1)
    const rowOffsets = [...new Set(plan.tiles.map((t) => t.rowOffset))].sort((a, b) => a - b)
    expect(rowOffsets).toEqual([0, 28, 56, 84])
    for (let i = 1; i < rowOffsets.length; i++) {
      expect(rowOffsets[i]! - rowOffsets[i - 1]!).toBe(28)
    }
  })

  it('非法参数被拒绝', () => {
    expect(() => planBoards(10, 10, 1, 0)).toThrow(/至少/)
    expect(() => planBoards(10, 10, 10, 10)).toThrow(/重叠/)
    expect(() => planBoards(10, 10, 10, -1)).toThrow(/重叠/)
  })
})

describe('图纸存取', () => {
  it('序列化后能原样解析回来', () => {
    const original = makePattern(3, 4, [0, 1, 2, -1, 2, 2, 0, 1, -1, -1, 0, 0])
    const text = serializePattern(original)
    const { pattern } = parsePatternFile(text)

    expect(pattern.rows).toBe(3)
    expect(pattern.cols).toBe(4)
    expect(pattern.beadSizeMm).toBe(5)
    expect(pattern.title).toBe('测试图纸')
    expect(Array.from(pattern.grid)).toEqual(Array.from(original.grid))
    expect(pattern.colors.map((c) => c.code)).toEqual(['T01', 'T02', 'T03'])
  })

  it('缩略图与生成参数能一并往返', () => {
    const p = makePattern(2, 2, [0, 1, 2, 0])
    const text = serializePattern(p, {
      thumbnail: 'data:image/png;base64,iVBORw0KGgo=',
    })
    const parsed = parsePatternFile(text)
    expect(parsed.thumbnail).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('文件带版本号，且是自包含的', () => {
    const text = serializePattern(makePattern(1, 1, [0]))
    const raw = JSON.parse(text)

    expect(raw.format).toBe('beadpattern')
    expect(raw.version).toBe(1)
    // 颜色必须内嵌完整信息，而不是只存一个 ID 去引用外部色卡
    expect(raw.colors[0]).toMatchObject({
      id: 't.T01',
      code: 'T01',
      name: '白',
      hex: '#ffffff',
    })
  })

  it('拒绝非本格式的文件', () => {
    expect(() => parsePatternFile('{"format":"something-else"}')).toThrow(
      PatternParseError,
    )
    expect(() => parsePatternFile('not json at all')).toThrow(/JSON/)
    expect(() => parsePatternFile('[]')).toThrow(/对象/)
  })

  it('拒绝来自更高版本的文件并说明原因', () => {
    const text = JSON.stringify({
      format: 'beadpattern',
      version: 99,
      colors: COLORS,
      grid: [[0]],
    })
    expect(() => parsePatternFile(text)).toThrow(/v99/)
  })

  it('拒绝行列不齐的网格，并指出是第几行', () => {
    const text = JSON.stringify({
      format: 'beadpattern',
      version: 1,
      colors: COLORS,
      grid: [
        [0, 1],
        [0],
      ],
    })
    expect(() => parsePatternFile(text)).toThrow(/第 2 行/)
  })

  it('拒绝越界的色号下标，并指出是第几格', () => {
    const text = JSON.stringify({
      format: 'beadpattern',
      version: 1,
      colors: COLORS,
      grid: [
        [0, 1],
        [0, 7],
      ],
    })
    expect(() => parsePatternFile(text)).toThrow(/第 2 行第 2 格/)
  })

  it('拒绝非法颜色值', () => {
    const text = JSON.stringify({
      format: 'beadpattern',
      version: 1,
      colors: [{ id: 'a', code: 'A', name: '坏色', hex: 'red' }],
      grid: [[0]],
    })
    expect(() => parsePatternFile(text)).toThrow(/颜色值非法/)
  })

  it('文件名会剔除非法字符', () => {
    const p = makePattern(2, 2, [0, 0, 0, 0])
    p.title = '我的/图纸:测试*'
    expect(suggestFileName(p, 'png')).toBe('我的_图纸_测试__2x2.png')
  })
})

describe('符号体系', () => {
  it('符号互不重复且数量足够', () => {
    expect(SYMBOL_SEQUENCE.length).toBeGreaterThanOrEqual(80)
    expect(new Set(SYMBOL_SEQUENCE).size).toBe(SYMBOL_SEQUENCE.length)
  })

  it('前 26 个是大写字母 —— 最容易辨认', () => {
    expect(symbolFor(0)).toBe('A')
    expect(symbolFor(25)).toBe('Z')
    expect(symbolFor(26)).toBe('a')
  })

  it('负数返回占位符而不是崩溃', () => {
    expect(symbolFor(-1)).toBe('?')
  })
})
