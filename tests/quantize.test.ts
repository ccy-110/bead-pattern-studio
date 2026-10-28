import { describe, expect, it } from 'vitest'
import type { RasterImage } from '../src/core/imaging/types'
import { createSampleScratch, sampleRegion } from '../src/core/imaging/sample'
import { quantize } from '../src/core/quantize'
import { defineColors } from '../src/core/palette/types'
import type { PaletteColor } from '../src/core/palette/types'

/** 合成测试图。返回值带 alpha，方便测透明处理。 */
function makeImage(
  w: number,
  h: number,
  fill: (x: number, y: number) => readonly [number, number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const px = fill(x, y)
      data[o] = px[0]
      data[o + 1] = px[1]
      data[o + 2] = px[2]
      data[o + 3] = px[3]
    }
  }
  return { width: w, height: h, data }
}

const TEST_PALETTE: PaletteColor[] = defineColors('test', [
  { code: 'T01', name: '白', hex: '#ffffff' },
  { code: 'T02', name: '黑', hex: '#000000' },
  { code: 'T03', name: '红', hex: '#ff0000' },
  { code: 'T04', name: '绿', hex: '#00ff00' },
  { code: 'T05', name: '蓝', hex: '#0000ff' },
  { code: 'T06', name: '灰', hex: '#808080' },
])

/** 便捷取色号下标 */
const idxOf = (code: string): number =>
  TEST_PALETTE.findIndex((c) => c.code === code)

describe('区域采样', () => {
  const scratch = createSampleScratch()

  it('主色法返回区域内真实存在的颜色，绝不返回平均值', () => {
    // 左 3/5 白、右 2/5 黑。
    // 平均值会得到灰色 —— 一个原图里根本不存在的颜色，
    // 映射到色卡后就是边缘那圈脏色。主色法必须返回白或黑。
    const img = makeImage(10, 1, (x) =>
      x < 6 ? [255, 255, 255, 255] : [0, 0, 0, 255],
    )

    const sample = sampleRegion(img, 0, 0, 10, 1, 'mode', 128, scratch)

    expect(sample.count).toBe(10)
    expect(sample.rgb).toEqual([255, 255, 255])
    expect(sample.dominance).toBeCloseTo(0.6, 5)
  })

  it('平均值模式给出中间色（这正是它在边缘处表现差的原因）', () => {
    const img = makeImage(10, 1, (x) =>
      x < 6 ? [255, 255, 255, 255] : [0, 0, 0, 255],
    )

    const sample = sampleRegion(img, 0, 0, 10, 1, 'average', 128, scratch)

    // 线性光空间下黑白各半 → 编码回 sRGB 约 188，比 sRGB 直接平均的 128 亮得多
    expect(sample.rgb[0]).toBeGreaterThan(150)
    expect(sample.rgb[0]).toBeLessThan(255)
  })

  it('完全透明的区域返回 count = 0', () => {
    const img = makeImage(4, 4, () => [10, 20, 30, 0])
    const sample = sampleRegion(img, 0, 0, 4, 4, 'mode', 128, scratch)
    expect(sample.count).toBe(0)
    expect(sample.total).toBe(16)
  })

  it('透明像素不参与取色，也不拉低占比', () => {
    // 一半透明、一半红
    const img = makeImage(8, 1, (x) =>
      x < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0],
    )
    const sample = sampleRegion(img, 0, 0, 8, 1, 'mode', 128, scratch)

    expect(sample.count).toBe(4)
    expect(sample.rgb).toEqual([255, 0, 0])
    expect(sample.dominance).toBe(1) // 只统计有效像素，占比应为 100%
  })

  it('多次采样之间状态不串味（缓冲区正确复用）', () => {
    const red = makeImage(4, 4, () => [255, 0, 0, 255])
    const blue = makeImage(4, 4, () => [0, 0, 255, 255])

    const s1 = sampleRegion(red, 0, 0, 4, 4, 'mode', 128, scratch)
    const s2 = sampleRegion(blue, 0, 0, 4, 4, 'mode', 128, scratch)
    const s3 = sampleRegion(red, 0, 0, 4, 4, 'mode', 128, scratch)

    expect(s1.rgb).toEqual([255, 0, 0])
    expect(s2.rgb).toEqual([0, 0, 255])
    expect(s3.rgb).toEqual([255, 0, 0])
  })

  it('在 mode 与 average 之间切换后结果依然正确', () => {
    // 回归测试：曾经因为 touched 清单重置时机不对，
    // 在模式切换后残留计数会污染下一次采样
    const img = makeImage(4, 4, () => [255, 0, 0, 255])

    sampleRegion(img, 0, 0, 4, 4, 'mode', 128, scratch)
    sampleRegion(img, 0, 0, 4, 4, 'median', 128, scratch)
    const back = sampleRegion(img, 0, 0, 4, 4, 'mode', 128, scratch)

    expect(back.rgb).toEqual([255, 0, 0])
    expect(back.dominance).toBe(1)
  })
})

describe('量化流程', () => {
  const baseOpts = {
    sampleMode: 'mode' as const,
    maxColors: 0,
    minBeads: 1,
    emptyRatio: 0.5,
    alphaThreshold: 128,
  }

  it('纯色图精确匹配到唯一色号', () => {
    const img = makeImage(40, 40, () => [255, 0, 0, 255])
    const result = quantize(img, {
      ...baseOpts,
      rows: 4,
      cols: 4,
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 40, height: 40 },
    })

    expect(result.colors).toHaveLength(1)
    expect(result.colors[0]!.code).toBe('T03')
    expect(Array.from(result.grid)).toEqual(Array(16).fill(0))
    expect(result.emptyCount).toBe(0)
  })

  it('输出的颜色**全部**来自候选色卡，绝不产生新颜色', () => {
    // 用一堆色卡里没有的中间色
    const img = makeImage(40, 40, (x, y) => [
      (x * 6) % 256,
      (y * 6) % 256,
      ((x + y) * 3) % 256,
      255,
    ])

    const result = quantize(img, {
      ...baseOpts,
      rows: 8,
      cols: 8,
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 40, height: 40 },
    })

    const allowed = new Set(TEST_PALETTE.map((c) => c.id))
    for (const c of result.colors) {
      expect(allowed.has(c.id)).toBe(true)
    }
  })

  it('网格取值只可能是 -1（空格）或合法的颜色下标', () => {
    const img = makeImage(40, 40, (x, y) => [x * 6, y * 6, 128, 255])
    const result = quantize(img, {
      ...baseOpts,
      rows: 8,
      cols: 8,
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 40, height: 40 },
    })

    for (const v of result.grid) {
      expect(v === -1 || (v >= 0 && v < result.colors.length)).toBe(true)
    }
  })

  it('maxColors 严格生效', () => {
    // 四个象限四种颜色
    const img = makeImage(40, 40, (x, y) => {
      if (x < 20 && y < 20) return [255, 0, 0, 255]
      if (x >= 20 && y < 20) return [0, 255, 0, 255]
      if (x < 20 && y >= 20) return [0, 0, 255, 255]
      return [255, 255, 255, 255]
    })

    const result = quantize(img, {
      ...baseOpts,
      rows: 4,
      cols: 4,
      maxColors: 2,
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 40, height: 40 },
    })

    expect(result.rawColorCount).toBe(4)
    expect(result.colors.length).toBeLessThanOrEqual(2)
    // 削减后豆子总数不能变少 —— 颜色只是被合并，格子还在
    expect(result.emptyCount).toBe(0)
  })

  it('minBeads 会合并掉"不值得单独买一包"的稀有颜色', () => {
    // 15 格红色 + 1 格蓝色（40×40 图切 4×4 格，每格 10×10）
    const img = makeImage(40, 40, (x, y) => {
      if (x >= 30 && y >= 30) return [0, 0, 255, 255]
      return [255, 0, 0, 255]
    })

    const withoutMerge = quantize(img, {
      ...baseOpts,
      rows: 4,
      cols: 4,
      minBeads: 1,
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 40, height: 40 },
    })
    expect(withoutMerge.colors).toHaveLength(2)

    const withMerge = quantize(img, {
      ...baseOpts,
      rows: 4,
      cols: 4,
      minBeads: 5, // 蓝只有 1 颗，远低于阈值
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 40, height: 40 },
    })

    expect(withMerge.colors).toHaveLength(1)
    expect(withMerge.colors[0]!.code).toBe('T03') // 蓝色被并入最近的红
  })

  it('minBeads 永远不会把颜色数削减到 0', () => {
    const img = makeImage(20, 20, () => [255, 0, 0, 255])
    const result = quantize(img, {
      ...baseOpts,
      rows: 2,
      cols: 2,
      minBeads: 9999, // 荒谬的阈值
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 20, height: 20 },
    })

    expect(result.colors.length).toBeGreaterThanOrEqual(1)
    expect(result.emptyCount).toBe(0)
  })

  it('透明区域变成空格（不留豆子）', () => {
    // 右半边完全透明
    const img = makeImage(40, 40, (x) =>
      x < 20 ? [255, 0, 0, 255] : [0, 0, 0, 0],
    )

    const result = quantize(img, {
      ...baseOpts,
      rows: 4,
      cols: 4,
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 40, height: 40 },
    })

    // 左 2 列有豆子，右 2 列全空
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const v = result.grid[r * 4 + c]!
        if (c < 2) expect(v).toBeGreaterThanOrEqual(0)
        else expect(v).toBe(-1)
      }
    }
    expect(result.emptyCount).toBe(8)
  })

  it('行列数与网格长度一致（非方阵也正确）', () => {
    const img = makeImage(50, 30, () => [255, 255, 255, 255])
    const result = quantize(img, {
      ...baseOpts,
      rows: 3,
      cols: 7,
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 50, height: 30 },
    })

    expect(result.rows).toBe(3)
    expect(result.cols).toBe(7)
    expect(result.grid.length).toBe(21)
    expect(result.colors[0]!.code).toBe('T01')
  })

  it('空白候选色卡会明确报错而不是静默产出空图纸', () => {
    const img = makeImage(10, 10, () => [255, 0, 0, 255])
    expect(() =>
      quantize(img, {
        ...baseOpts,
        rows: 2,
        cols: 2,
        colors: [],
        crop: { x: 0, y: 0, width: 10, height: 10 },
      }),
    ).toThrow(/候选颜色为空/)
  })

  it('合法色卡下标都能在 result.colors 中找到对应项', () => {
    const img = makeImage(40, 40, (x, y) => [(x * 7) % 256, (y * 7) % 256, 60, 255])
    const result = quantize(img, {
      ...baseOpts,
      rows: 5,
      cols: 5,
      maxColors: 3,
      colors: TEST_PALETTE,
      crop: { x: 0, y: 0, width: 40, height: 40 },
    })

    const seen = new Set<number>()
    for (const v of result.grid) if (v >= 0) seen.add(v)

    // 网格里出现的每个下标都必须指向一个真实颜色
    for (const v of seen) {
      expect(result.colors[v]).toBeDefined()
      expect(result.colors[v]!.hex).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(seen.size).toBe(result.colors.length)
    expect(seen.size).toBeLessThanOrEqual(3)
  })

  it('idxOf 辅助函数与色卡一致（防止测试自身写错）', () => {
    expect(TEST_PALETTE[idxOf('T03')]!.hex).toBe('#ff0000')
  })
})
