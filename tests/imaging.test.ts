import { describe, expect, it } from 'vitest'
import { cropImage, downscaleImage } from '../src/core/imaging/load'
import type { RasterImage } from '../src/core/imaging/types'

/** 造一张纯色图 */
function solid(w: number, h: number, rgba: [number, number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgba[0]
    data[i * 4 + 1] = rgba[1]
    data[i * 4 + 2] = rgba[2]
    data[i * 4 + 3] = rgba[3]
  }
  return { width: w, height: h, data }
}

/** 取某点的 RGBA */
function at(img: RasterImage, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, img.data[o + 3]!]
}

describe('downscaleImage', () => {
  it('目标尺寸已经足够小时不缩放，但仍返回副本', () => {
    const src = solid(10, 10, [1, 2, 3, 255])
    const out = downscaleImage(src, 100)
    expect(out.width).toBe(10)
    expect(out.height).toBe(10)
    expect(out.data).not.toBe(src.data)
    expect(Array.from(out.data)).toEqual(Array.from(src.data))
  })

  it('保持宽高比', () => {
    const out = downscaleImage(solid(400, 200, [0, 0, 0, 255]), 100)
    expect(out.width).toBe(100)
    expect(out.height).toBe(50)
  })

  it('纯色图缩放后仍然是同一个颜色', () => {
    const out = downscaleImage(solid(64, 64, [200, 100, 50, 255]), 8)
    expect(at(out, 4, 4)).toEqual([200, 100, 50, 255])
  })

  it('不修改源图', () => {
    const src = solid(32, 32, [12, 34, 56, 255])
    const before = Array.from(src.data)
    downscaleImage(src, 8)
    expect(Array.from(src.data)).toEqual(before)
  })

  it('1×1 的结果是整图的平均值', () => {
    // 左半黑、右半白，缩到 1×1 应该是中灰
    const src = solid(4, 4, [0, 0, 0, 255])
    for (let y = 0; y < 4; y++) {
      for (let x = 2; x < 4; x++) {
        const o = (y * 4 + x) * 4
        src.data[o] = 255
        src.data[o + 1] = 255
        src.data[o + 2] = 255
      }
    }
    const out = downscaleImage(src, 1)
    expect(out.width).toBe(1)
    expect(at(out, 0, 0)[0]).toBeCloseTo(128, 0)
  })

  it('全透明的图缩放后仍然全透明', () => {
    const out = downscaleImage(solid(16, 16, [0, 0, 0, 0]), 4)
    expect(at(out, 1, 1)).toEqual([0, 0, 0, 0])
  })
})

describe('downscaleImage 的预乘 alpha', () => {
  /**
   * 这是抠图之后最容易出错的地方。
   *
   * 背景被抠掉后是 (0,0,0,0)。如果直接对 RGB 求平均，
   * 这些"黑色"的透明像素会把主体边缘一起拉黑，预览图上会出现一圈脏边。
   * 正确做法是先乘 alpha 再平均、最后除回去 —— 透明像素的权重为 0，
   * 完全不影响颜色。
   */
  it('透明白色混合后不会变灰', () => {
    // 2×2：三个不透明白 + 一个全透明黑
    const src = solid(2, 2, [255, 255, 255, 255])
    src.data[0] = 0
    src.data[1] = 0
    src.data[2] = 0
    src.data[3] = 0

    const out = downscaleImage(src, 1)
    const [r, g, b, a] = at(out, 0, 0)

    // 朴素平均会得到 191 的灰色；预乘平均必须保持纯白
    expect(r).toBe(255)
    expect(g).toBe(255)
    expect(b).toBe(255)
    // alpha 仍然是面积的加权平均：3/4
    expect(a).toBeCloseTo(191, 0)
  })

  it('半透明像素按 alpha 加权', () => {
    // 2×1：一个不透明红，一个 alpha=0 的绿
    // 绿被完全排除，红因为 alpha=255 独占权重 —— 结果是纯红
    const src = solid(2, 1, [255, 0, 0, 255])
    src.data[4] = 0
    src.data[5] = 255
    src.data[6] = 0
    src.data[7] = 0

    const out = downscaleImage(src, 1)
    const [r, g, b] = at(out, 0, 0)
    expect(r).toBe(255)
    expect(g).toBe(0)
    expect(b).toBe(0)
  })
})

describe('cropImage', () => {
  it('裁出正确的区域', () => {
    const src = solid(10, 10, [9, 9, 9, 255])
    // 把 (2,2) 涂成红色作为标记
    const o = (2 * 10 + 2) * 4
    src.data[o] = 255
    src.data[o + 1] = 0
    src.data[o + 2] = 0

    const out = cropImage(src, 2, 2, 3, 3)
    expect(out.width).toBe(3)
    expect(out.height).toBe(3)
    expect(at(out, 0, 0)).toEqual([255, 0, 0, 255])
    expect(at(out, 1, 1)).toEqual([9, 9, 9, 255])
  })

  it('越界的矩形被夹到图像范围内', () => {
    const out = cropImage(solid(10, 10, [0, 0, 0, 255]), 8, 8, 100, 100)
    expect(out.width).toBe(2)
    expect(out.height).toBe(2)
  })

  it('起点越界时至少留下 1×1', () => {
    const out = cropImage(solid(10, 10, [0, 0, 0, 255]), 999, 999, 10, 10)
    expect(out.width).toBe(1)
    expect(out.height).toBe(1)
  })

  it('负数坐标被夹到 0', () => {
    const out = cropImage(solid(10, 10, [0, 0, 0, 255]), -5, -5, 4, 4)
    expect(out.width).toBe(4)
    expect(out.height).toBe(4)
  })

  it('不修改源图', () => {
    const src = solid(8, 8, [7, 7, 7, 255])
    const before = Array.from(src.data)
    cropImage(src, 1, 1, 3, 3)
    expect(Array.from(src.data)).toEqual(before)
  })
})
