import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CELLS,
  MAX_CELLS,
  MIN_CELLS,
  boardsNeeded,
  cellsForPhysicalMm,
  clampCells,
  formatPhysical,
  physicalMmForCells,
  resolveSize,
  snapToBoard,
} from '../src/core/pattern/sizing'

describe('clampCells', () => {
  it('把非法输入退回默认值，而不是产生 NaN 或 0', () => {
    expect(clampCells(NaN)).toBe(DEFAULT_CELLS)
    expect(clampCells(Infinity)).toBe(DEFAULT_CELLS)
    expect(clampCells(0)).toBe(MIN_CELLS)
    expect(clampCells(-10)).toBe(MIN_CELLS)
  })

  it('夹在上下限之间', () => {
    expect(clampCells(1)).toBe(MIN_CELLS)
    expect(clampCells(10_000)).toBe(MAX_CELLS)
    expect(clampCells(50)).toBe(50)
  })

  it('四舍五入到整数', () => {
    expect(clampCells(50.4)).toBe(50)
    expect(clampCells(50.6)).toBe(51)
  })
})

describe('resolveSize', () => {
  it('正方形比例下两维相等', () => {
    expect(resolveSize({ rows: 0, cols: 50 }, 1, 'cols')).toEqual({
      rows: 50,
      cols: 50,
    })
  })

  it('由列驱动时按比例算出行', () => {
    // 3:1 的宽图，90 列 → 30 行
    expect(resolveSize({ rows: 0, cols: 90 }, 3, 'cols')).toEqual({
      rows: 30,
      cols: 90,
    })
  })

  it('由行驱动时按比例算出列', () => {
    expect(resolveSize({ rows: 30, cols: 0 }, 3, 'rows')).toEqual({
      rows: 30,
      cols: 90,
    })
  })

  it('driver 决定谁是权威，避免两维互相覆盖', () => {
    // 同一组输入，driver 不同结果就该不同
    const byCols = resolveSize({ rows: 99, cols: 40 }, 1, 'cols')
    const byRows = resolveSize({ rows: 40, cols: 99 }, 1, 'rows')
    expect(byCols.cols).toBe(40)
    expect(byRows.rows).toBe(40)
  })

  it('超限时按比例整体缩小，而不是把某一维削平', () => {
    // 回归测试：曾经先夹取再缩放，导致 3:1 的图变成正方形（图片被拉伸）
    const r = resolveSize({ rows: 300, cols: 0 }, 3, 'rows')
    expect(r).toEqual({ rows: 100, cols: 300 })
    // 比例必须保住
    expect(r.cols / r.rows).toBeCloseTo(3, 1)
  })

  it('列驱动超限时同样保持比例', () => {
    const r = resolveSize({ rows: 0, cols: 1000 }, 1, 'cols')
    expect(r).toEqual({ rows: MAX_CELLS, cols: MAX_CELLS })
  })

  it('宽高比非法时按正方形处理', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(resolveSize({ rows: 0, cols: 30 }, bad, 'cols')).toEqual({
        rows: 30,
        cols: 30,
      })
    }
  })

  it('竖图（比例小于 1）也被正确处理', () => {
    const r = resolveSize({ rows: 0, cols: 30 }, 0.5, 'cols')
    expect(r).toEqual({ rows: 60, cols: 30 })
  })

  it('结果永远落在合法区间内', () => {
    for (const aspect of [0.1, 0.5, 1, 2, 10]) {
      for (const n of [1, 50, 5000]) {
        const r = resolveSize({ rows: n, cols: n }, aspect, 'cols')
        expect(r.rows).toBeGreaterThanOrEqual(MIN_CELLS)
        expect(r.rows).toBeLessThanOrEqual(MAX_CELLS)
        expect(r.cols).toBeGreaterThanOrEqual(MIN_CELLS)
        expect(r.cols).toBeLessThanOrEqual(MAX_CELLS)
      }
    }
  })
})

describe('物理尺寸换算', () => {
  it('5mm 豆 30 格 = 150mm', () => {
    expect(physicalMmForCells(30, 5)).toBe(150)
  })

  it('2.6mm 豆 100 格 = 260mm', () => {
    expect(physicalMmForCells(100, 2.6)).toBeCloseTo(260, 6)
  })

  it('毫米换算回格数会四舍五入', () => {
    expect(cellsForPhysicalMm(150, 5)).toBe(30)
    expect(cellsForPhysicalMm(152, 5)).toBe(30)
    expect(cellsForPhysicalMm(153, 5)).toBe(31)
  })

  it('毫米数非法时退回下限而不是报错', () => {
    expect(cellsForPhysicalMm(0, 5)).toBe(MIN_CELLS)
    expect(cellsForPhysicalMm(-100, 5)).toBe(MIN_CELLS)
    expect(cellsForPhysicalMm(NaN, 5)).toBe(MIN_CELLS)
  })

  it('formatPhysical 在超过 10cm 时改用厘米', () => {
    // 30 格 × 5mm = 150mm = 15cm，用厘米读起来更自然
    expect(formatPhysical(30, 5)).toBe('15.0 厘米')
    // 10 格 × 5mm = 50mm，还不到 10cm，保持毫米
    expect(formatPhysical(10, 5)).toBe('50 毫米')
  })
})

describe('snapToBoard', () => {
  it('吸附到不小于原尺寸的底板整数倍', () => {
    expect(snapToBoard(29, 29)).toBe(29)
    expect(snapToBoard(30, 29)).toBe(58)
    expect(snapToBoard(40, 29)).toBe(58)
    expect(snapToBoard(58, 29)).toBe(58)
    expect(snapToBoard(59, 29)).toBe(87)
  })

  it('绝不向下取整，否则会悄悄砍掉图案', () => {
    // 40 格吸附到 29 会丢 11 列；必须是 58
    for (const cells of [30, 35, 40, 50]) {
      expect(snapToBoard(cells, 29)).toBeGreaterThanOrEqual(cells)
    }
  })

  it('与 boardsNeeded 的结论一致', () => {
    for (const cells of [29, 30, 58, 60, 100]) {
      const snapped = snapToBoard(cells, 29)
      expect(boardsNeeded(snapped, snapped, 29).total).toBe(
        boardsNeeded(cells, cells, 29).total,
      )
    }
  })

  it('至少留一块板', () => {
    expect(snapToBoard(3, 29)).toBe(29)
  })

  it('上限仍然生效', () => {
    expect(snapToBoard(10_000, 29)).toBe(MAX_CELLS)
  })

  it('底板尺寸非法时退回普通夹取', () => {
    expect(snapToBoard(50, 0)).toBe(50)
  })
})

describe('boardsNeeded', () => {
  it('正好一块板时只需要一块', () => {
    expect(boardsNeeded(29, 29, 29)).toEqual({ across: 1, down: 1, total: 1 })
  })

  it('多出一格就要多一块板', () => {
    expect(boardsNeeded(30, 30, 29)).toEqual({ across: 2, down: 2, total: 4 })
  })

  it('非正方形图纸', () => {
    expect(boardsNeeded(29, 60, 29)).toEqual({ across: 3, down: 1, total: 3 })
  })
})
