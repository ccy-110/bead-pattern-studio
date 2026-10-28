import { describe, expect, it } from 'vitest'

import { createImage } from '../src/core/imaging/types'
import type { RasterImage } from '../src/core/imaging/types'
import { ConversionPipeline, clampCrop } from '../src/core/pipeline'
import type { PipelineParams } from '../src/core/pipeline'
import type { PaletteColor } from '../src/core/palette/types'

/**
 * 转换管线的端到端测试。
 *
 * 这条链路以前长在 Worker 的 `onmessage` 里，只能靠盯着浏览器看。
 * 但它恰恰是最容易出问题的地方 —— 抠图和量化的先后顺序、
 * 裁剪坐标的基准、预览与成品用的是不是同一个背景色，
 * 任何一处错了用户拿到的都是"看起来差不多但就是不对"的图纸。
 */

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function paletteColor(code: string, hex: string, name = code): PaletteColor {
  return { id: `test.${code}`, code, name, hex, rgb: hexToRgb(hex), kind: 'solid' }
}

const WHITE = paletteColor('W', '#ffffff', '白')
const RED = paletteColor('R', '#ff0000', '红')
const BLUE = paletteColor('B', '#0000ff', '蓝')

/** 造一张纯色图 */
function solid(width: number, height: number, hex: string): RasterImage {
  const [r, g, b] = hexToRgb(hex)
  const img = createImage(width, height)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    img.data[o] = r
    img.data[o + 1] = g
    img.data[o + 2] = b
    img.data[o + 3] = 255
  }
  return img
}

/** 在白底上画一个居中的矩形色块 */
function blockOn(
  width: number,
  height: number,
  bg: string,
  fg: string,
  box: { x: number; y: number; w: number; h: number },
): RasterImage {
  const img = solid(width, height, bg)
  const rgb = hexToRgb(fg)

  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      const o = (y * width + x) * 4
      img.data[o] = rgb[0]
      img.data[o + 1] = rgb[1]
      img.data[o + 2] = rgb[2]
    }
  }

  return img
}

const BASE: Omit<PipelineParams, 'crop' | 'backgroundTolerance' | 'backgroundReference'> = {
  rows: 8,
  cols: 8,
  colors: [WHITE, RED, BLUE],
  sampleMode: 'mode',
  maxColors: 8,
  minBeads: 1,
  emptyRatio: 0.5,
  alphaThreshold: 128,
  adjustments: { brightness: 0, contrast: 0, saturation: 0 },
}

function params(overrides: Partial<PipelineParams> = {}): PipelineParams {
  return {
    ...BASE,
    crop: { x: 0, y: 0, width: 64, height: 64 },
    backgroundTolerance: null,
    backgroundReference: null,
    ...overrides,
  }
}

describe('裁剪框夹紧', () => {
  it('原样接受范围内的矩形', () => {
    expect(clampCrop({ x: 10, y: 20, width: 30, height: 40 }, 100, 100)).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    })
  })

  it('越界的起点被拉回图内，且不会变成负数', () => {
    const c = clampCrop({ x: -50, y: -50, width: 30, height: 30 }, 100, 100)
    expect(c.x).toBe(0)
    expect(c.y).toBe(0)
    expect(c.width).toBe(30)
  })

  it('超出右下的宽高被截断到图边，绝不越界读取', () => {
    const c = clampCrop({ x: 80, y: 90, width: 100, height: 100 }, 100, 100)
    expect(c.x + c.width).toBeLessThanOrEqual(100)
    expect(c.y + c.height).toBeLessThanOrEqual(100)
    expect(c.width).toBeGreaterThanOrEqual(1)
    expect(c.height).toBeGreaterThanOrEqual(1)
  })

  it('退化输入（零宽、NaN）也至少留 1 像素，不会产出空网格', () => {
    expect(clampCrop({ x: 0, y: 0, width: 0, height: 0 }, 10, 10).width).toBe(1)
    const nan = clampCrop({ x: NaN, y: NaN, width: NaN, height: NaN }, 10, 10)
    expect(nan.width).toBeGreaterThanOrEqual(1)
    expect(nan.height).toBeGreaterThanOrEqual(1)
    expect(Number.isFinite(nan.x)).toBe(true)
  })
})

describe('整条管线', () => {
  it('纯色图转出全同色的网格，且用的就是色卡里的那个色号', () => {
    const pipeline = new ConversionPipeline(solid(64, 64, '#ff0000'))
    const out = pipeline.run(params(), true, 0)

    const p = out.pattern!
    expect(p.rows).toBe(8)
    expect(p.cols).toBe(8)
    expect(p.grid).toHaveLength(64)

    const used = new Set(Array.from(p.grid))
    expect(used.size).toBe(1)
    expect(p.colors[Array.from(used)[0]!]!.code).toBe('R')
  })

  it('白底上的红色方块：不抠图时背景是白色豆，抠图后变成空格', () => {
    const image = blockOn(64, 64, '#ffffff', '#ff0000', { x: 16, y: 16, w: 32, h: 32 })

    const withoutBg = new ConversionPipeline(image).run(params(), true, 0).pattern!
    const withBg = new ConversionPipeline(image).run(
      params({ backgroundTolerance: 32 }),
      true,
      0,
    ).pattern!

    // 不抠图：整张图都有豆子
    expect(withoutBg.emptyCount).toBe(0)
    expect(withoutBg.colors.length).toBeGreaterThan(1)

    // 抠图后：四周的空格 4×8×4 - 中间 4×4 = 48 格
    expect(withBg.emptyCount).toBe(48)

    // 中间那 4×4 应该都是红
    const mid = [27, 28, 35, 36]
    for (const i of mid) {
      expect(withBg.grid[i]).toBeGreaterThanOrEqual(0)
      expect(withBg.colors[withBg.grid[i]!]!.code).toBe('R')
    }
  })

  it('抠图后统计出的颜色数只剩前景色 —— 白色不该再占用一个色号', () => {
    const image = blockOn(64, 64, '#ffffff', '#ff0000', { x: 16, y: 16, w: 32, h: 32 })

    const withoutBg = new ConversionPipeline(image).run(params(), true, 0).pattern!
    const withBg = new ConversionPipeline(image).run(
      params({ backgroundTolerance: 32 }),
      true,
      0,
    ).pattern!

    expect(withoutBg.rawColorCount).toBeGreaterThan(withBg.rawColorCount)
    expect(withBg.colors.map((c) => c.code)).toEqual(['R'])
  })

  it('裁剪只转换框内的部分', () => {
    // 左半边红、右半边蓝
    const image = blockOn(64, 64, '#0000ff', '#ff0000', { x: 0, y: 0, w: 32, h: 64 })

    const left = new ConversionPipeline(image).run(
      params({ crop: { x: 0, y: 0, width: 32, height: 64 } }),
      true,
      0,
    ).pattern!

    expect(new Set(Array.from(left.grid)).size).toBe(1)
    expect(left.colors[left.grid[0]!]!.code).toBe('R')

    const right = new ConversionPipeline(image).run(
      params({ crop: { x: 32, y: 0, width: 32, height: 64 } }),
      true,
      0,
    ).pattern!

    expect(right.colors[right.grid[0]!]!.code).toBe('B')
  })

  it('裁剪框越界也不会崩，只是夹到图内', () => {
    const pipeline = new ConversionPipeline(solid(64, 64, '#ff0000'))
    const out = pipeline.run(
      params({ crop: { x: 60, y: 60, width: 999, height: 999 } }),
      true,
      0,
    )
    expect(out.pattern!.grid).toHaveLength(64)
    expect(Array.from(out.pattern!.grid).every((v) => v >= 0)).toBe(true)
  })

  it('格子小于一个像素时不留空洞，取最近的那个像素', () => {
    // 4×4 像素的区域要排 8×8 个格子，每格只有半个像素。
    // 按边界取整会有一半格子采不到任何像素，若就此留空，
    // 用户看到的就是一张隔行空白的图纸，而且找不出原因。
    const pipeline = new ConversionPipeline(solid(64, 64, '#ff0000'))
    const out = pipeline.run(
      params({ crop: { x: 60, y: 60, width: 4, height: 4 } }),
      true,
      0,
    )

    expect(out.pattern!.grid).toHaveLength(64)
    expect(out.pattern!.emptyCount).toBe(0)
    expect(new Set(Array.from(out.pattern!.grid)).size).toBe(1)
  })

  it('亚像素格子也会尊重透明 —— 抠掉的背景不会因为取整而漏回来', () => {
    // 整张图都是背景，再密的格子也应该全是空格
    const pipeline = new ConversionPipeline(solid(64, 64, '#ffffff'))
    const out = pipeline.run(
      params({
        crop: { x: 30, y: 30, width: 4, height: 4 },
        backgroundTolerance: 32,
        backgroundReference: [255, 255, 255],
      }),
      true,
      0,
    )
    expect(out.pattern!.emptyCount).toBe(64)
  })

  it('亮度调低会让颜色匹配到更深的色号', () => {
    // 中灰配一张只有黑白的色卡，靠亮度把它推到不同的一侧
    const gray = paletteColor('G', '#808080', '灰')
    const black = paletteColor('K', '#000000', '黑')
    const white = paletteColor('W2', '#ffffff', '白')

    const base = { colors: [black, white], crop: { x: 0, y: 0, width: 64, height: 64 } }
    const image = solid(64, 64, '#808080')

    const normal = new ConversionPipeline(image).run(params(base), true, 0).pattern!
    const darker = new ConversionPipeline(image).run(
      params({ ...base, adjustments: { brightness: -40, contrast: 0, saturation: 0 } }),
      true,
      0,
    ).pattern!

    const normalCode = normal.colors[normal.grid[0]!]!.code
    const darkCode = darker.colors[darker.grid[0]!]!.code

    expect(normalCode).toBe('W2')
    expect(darkCode).toBe('K')
    expect(gray.hex).toBe('#808080')
  })

  it('同一份输入跑两次结果完全一致', () => {
    const image = blockOn(64, 64, '#ffffff', '#0000ff', { x: 8, y: 8, w: 40, h: 40 })
    const p = params({ backgroundTolerance: 24 })

    const a = new ConversionPipeline(image).run(p, true, 96).pattern!
    const b = new ConversionPipeline(image).run(p, true, 96).pattern!

    expect(Array.from(a.grid)).toEqual(Array.from(b.grid))
    expect(a.colors.map((c) => c.code)).toEqual(b.colors.map((c) => c.code))
  })

  it('预览图受 previewMaxDim 约束，且保留了透明通道', () => {
    const image = blockOn(400, 400, '#ffffff', '#ff0000', { x: 100, y: 100, w: 200, h: 200 })
    const out = new ConversionPipeline(image).run(
      params({ crop: { x: 0, y: 0, width: 400, height: 400 }, backgroundTolerance: 32 }),
      false,
      200,
    )

    expect(out.pattern).toBeNull() // 没要求量化
    expect(out.preview!.width).toBeLessThanOrEqual(200)
    expect(out.preview!.height).toBeLessThanOrEqual(200)
    expect(out.preview!.data).toHaveLength(out.preview!.width * out.preview!.height * 4)

    // 角落是抠掉的背景
    expect(out.preview!.data[3]).toBe(0)
  })

  it('previewMaxDim 大于图像时不放大', () => {
    const out = new ConversionPipeline(solid(40, 40, '#ff0000')).run(params(), false, 900)
    expect(out.preview!.width).toBe(40)
    expect(out.preview!.height).toBe(40)
  })

  it('预览与成品用的是同一个背景参考色 —— 不能各算各的', () => {
    const image = blockOn(64, 64, '#ffffff', '#ff0000', { x: 16, y: 16, w: 32, h: 32 })
    const out = new ConversionPipeline(image).run(
      params({ backgroundTolerance: 32, crop: { x: 0, y: 0, width: 64, height: 64 } }),
      true,
      128,
    )

    // 自动推断出的参考色接近白色，而且被显式报了出来
    expect(out.backgroundReference).not.toBeNull()
    expect(out.backgroundConfidence).toBeGreaterThan(0)
    const [r, g, b] = out.backgroundReference!
    expect(r).toBeGreaterThan(230)
    expect(g).toBeGreaterThan(230)
    expect(b).toBeGreaterThan(230)

    // 预览里背景是透明的，成品里背景是空格 —— 两边一致
    expect(out.preview!.data[3]).toBe(0)
    expect(out.pattern!.emptyCount).toBeGreaterThan(0)
  })

  it('用户指定的背景色优先于自动推断，且可信度为 1', () => {
    const image = solid(64, 64, '#ff0000')
    const out = new ConversionPipeline(image).run(
      params({ backgroundTolerance: 10, backgroundReference: [255, 0, 0] }),
      true,
      0,
    )

    expect(out.backgroundReference).toEqual([255, 0, 0])
    expect(out.backgroundConfidence).toBe(1)
    // 整张图都被当成背景抠掉了
    expect(out.pattern!.emptyCount).toBe(64)
  })

  it('背景分析结果被缓存：调容差不重算，改亮度才重算', () => {
    const image = blockOn(64, 64, '#ffffff', '#ff0000', { x: 16, y: 16, w: 32, h: 32 })
    const pipeline = new ConversionPipeline(image)

    const a = pipeline.analyze({ brightness: 0, contrast: 0, saturation: 0 })
    const b = pipeline.analyze({ brightness: 0, contrast: 0, saturation: 0 })
    // 同一个对象说明命中了缓存，没有重新分析
    expect(b).toBe(a)

    const c = pipeline.analyze({ brightness: 30, contrast: 0, saturation: 0 })
    expect(c).not.toBe(a)
  })

  it('没有候选色卡时明确报错，而不是产出一张空图纸', () => {
    const pipeline = new ConversionPipeline(solid(64, 64, '#ff0000'))
    expect(() => pipeline.run(params({ colors: [] }), true, 0)).toThrow()
  })

  it('行列数可以不相等，网格长度始终等于 rows × cols', () => {
    const image = solid(80, 40, '#ff0000')
    const out = new ConversionPipeline(image).run(
      params({ rows: 5, cols: 20, crop: { x: 0, y: 0, width: 80, height: 40 } }),
      true,
      0,
    )
    expect(out.pattern!.grid).toHaveLength(100)
    expect(out.pattern!.rows).toBe(5)
    expect(out.pattern!.cols).toBe(20)
  })

  it('各阶段耗时都被记录，便于定位卡顿', () => {
    const out = new ConversionPipeline(solid(64, 64, '#ff0000')).run(params(), true, 64)
    expect(out.timings.quantize).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(out.timings.preview)).toBe(true)
    expect(Number.isFinite(out.timings.adjust)).toBe(true)
  })
})
