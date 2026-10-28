import { describe, expect, it } from 'vitest'

import {
  analyzeBackground,
  backgroundModelFrom,
  invertAlpha,
  removeBackground,
} from '../src/core/imaging/background'
import { downscaleImage } from '../src/core/imaging/load'
import type { RasterImage } from '../src/core/imaging/types'

/**
 * 抠图的测试。
 *
 * 这个模块以前完全没有测试，而它恰好是最难靠肉眼判断的一个 ——
 * "背景没抠干净"和"主体被啃掉一块"都要在成品图纸上才看得出来。
 * 所以这里用**构造出来的像素**做端到端断言：每张图我都知道哪些像素是背景、
 * 哪些是主体，于是可以直接量出两个指标：
 *
 * - `residual` 残留背景：真背景里没被扣掉的比例
 * - `eaten`    吃掉主体：真主体里被扣掉的比例
 *
 * 前者是用户抱怨的"只把白色扣掉"，后者是更糟的静默数据丢失。
 * 两个都必须是 0 才算对，只有抗锯齿过渡带那种"本来就是混合色"的像素例外。
 */

const W = 200
const H = 200

type Mask = Uint8Array // 1 = 真背景

interface Case {
  img: RasterImage
  bg: Mask
}

function alloc(): Case {
  return {
    img: { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) },
    bg: new Uint8Array(W * H),
  }
}

function px(img: RasterImage, x: number, y: number, r: number, g: number, b: number): void {
  const o = (y * img.width + x) << 2
  img.data[o] = r
  img.data[o + 1] = g
  img.data[o + 2] = b
  img.data[o + 3] = 255
}

/** 铺满整张图的背景；`at` 返回该点的灰度（或 RGB） */
function fillBg(c: Case, at: (x: number, y: number) => [number, number, number]): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = at(x, y)
      px(c.img, x, y, r, g, b)
      c.bg[y * W + x] = 1
    }
  }
}

/** 画一个矩形主体（覆盖背景，并把掩码标为主体） */
function rect(
  c: Case,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      px(c.img, x, y, rgb[0], rgb[1], rgb[2])
      c.bg[y * W + x] = 0
    }
  }
}

/**
 * 柔边主体：主体矩形外扩 `fade` 像素做线性过渡。
 * 过渡带里 alpha>0.5 的像素算主体，其余算背景 —— 这是唯一允许两边都不完美的区域。
 */
function softRect(
  c: Case,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
  fade: number,
): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.max(x0 - x, x - (x1 - 1), 0)
      const dy = Math.max(y0 - y, y - (y1 - 1), 0)
      const d = Math.hypot(dx, dy)
      const a = Math.max(0, Math.min(1, 1 - d / fade))
      if (a === 0) continue
      const o = (y * W + x) << 2
      const br = c.img.data[o]!
      const bg = c.img.data[o + 1]!
      const bb = c.img.data[o + 2]!
      px(
        c.img,
        x,
        y,
        Math.round(br * (1 - a) + rgb[0] * a),
        Math.round(bg * (1 - a) + rgb[1] * a),
        Math.round(bb * (1 - a) + rgb[2] * a),
      )
      c.bg[y * W + x] = a > 0.5 ? 0 : 1
    }
  }
}

const DARK: [number, number, number] = [30, 40, 120]

// ---------------------------------------------------------------------------
// 各种背景
// ---------------------------------------------------------------------------

function solidWhite(): Case {
  const c = alloc()
  fillBg(c, () => [255, 255, 255])
  rect(c, 60, 60, 140, 140, DARK)
  return c
}

/** 纵向渐变：纯白 255 → 205，横跨 50 个色阶 */
function gradient(): Case {
  const c = alloc()
  fillBg(c, (_x, y) => {
    const v = Math.round(255 - (y / (H - 1)) * 50)
    return [v, v, v]
  })
  rect(c, 60, 60, 140, 140, DARK)
  return c
}

/** 渐变背景 + 硬边主体：产品图最常见的形态 */
function gradientHardSubject(): Case {
  const c = alloc()
  fillBg(c, (_x, y) => {
    const v = Math.round(250 - (y / (H - 1)) * 60)
    return [v, Math.round(v * 0.98), Math.round(v * 0.94)]
  })
  rect(c, 60, 60, 140, 140, DARK)
  return c
}

/** 暗角：四角比中心暗 65 */
function vignette(): Case {
  const c = alloc()
  const maxd = Math.hypot(W / 2, H / 2)
  fillBg(c, (x, y) => {
    const v = Math.round(255 - 65 * Math.pow(Math.hypot(x - W / 2, y - H / 2) / maxd, 2))
    return [v, v, v]
  })
  rect(c, 60, 60, 140, 140, DARK)
  return c
}

/**
 * 双色背景：上半天空、下半草地。
 * 单参考色的模型必然漏掉一半，而两色的通道差（165）远大于任何可用容差，
 * 所以这是"多参考色"存在的理由。
 */
function twoTone(): Case {
  const c = alloc()
  fillBg(c, (_x, y) => (y < 100 ? [135, 190, 235] : [96, 150, 70]))
  rect(c, 70, 70, 130, 150, [220, 90, 60])
  return c
}

/** 白底 + JPEG 式压缩噪声 */
function jpegNoise(): Case {
  const c = alloc()
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  fillBg(c, () => {
    const base = 250 - Math.round(rnd() * 12)
    const n = () => base + Math.round((rnd() - 0.5) * 10)
    return [n(), n(), n()]
  })
  rect(c, 60, 60, 140, 140, DARK)
  return c
}

/** 白底 + 主体下方的柔和投影（过渡带约 12px，深度 127） */
function realisticShadow(): Case {
  const c = alloc()
  fillBg(c, () => [255, 255, 255])
  for (let y = 100; y < 195; y++) {
    for (let x = 30; x < 170; x++) {
      const d = Math.hypot((x - 100) / 70, (y - 148) / 47)
      if (d >= 1) continue
      const v = Math.round(255 * (1 - 0.5 * Math.min(1, (1 - d) * 4)))
      px(c.img, x, y, v, v, v)
    }
  }
  rect(c, 60, 50, 140, 130, DARK)
  return c
}

/** 主体内部有白色高光（眼睛）—— 绝不能被抠掉 */
function whiteInterior(): Case {
  const c = solidWhite()
  rect(c, 85, 80, 100, 95, [255, 255, 255])
  rect(c, 105, 80, 120, 95, [255, 255, 255])
  // 掩码保持：这两块属于主体
  for (let y = 80; y < 95; y++) {
    for (let x = 85; x < 100; x++) c.bg[y * W + x] = 0
    for (let x = 105; x < 120; x++) c.bg[y * W + x] = 0
  }
  return c
}

/** 白底上的细线：主体特征，不能被当成背景 */
function thinFeatures(): Case {
  const c = alloc()
  fillBg(c, () => [255, 255, 255])
  for (let y = 40; y < 160; y++) {
    for (let x = 90; x < 92; x++) {
      px(c.img, x, y, 20, 20, 20)
      c.bg[y * W + x] = 0
    }
  }
  for (let y = 96; y < 99; y++) {
    for (let x = 40; x < 160; x++) {
      px(c.img, x, y, 20, 20, 20)
      c.bg[y * W + x] = 0
    }
  }
  return c
}

/** 主体压在画面左边缘（人物出画的构图） */
function subjectOnBorder(): Case {
  const c = alloc()
  fillBg(c, () => [250, 250, 250])
  rect(c, 0, 40, 70, 160, [40, 45, 130])
  return c
}

// ---------------------------------------------------------------------------
// 度量
// ---------------------------------------------------------------------------

interface Score {
  /** 残留背景占比 */
  residual: number
  /** 被吃掉的主体占比 */
  eaten: number
}

const TOL = 32

function score(c: Case, tolerance = TOL, model = analyzeBackground(c.img)): Score {
  const out = removeBackground(c.img, { model, tolerance })
  let residual = 0
  let bgTotal = 0
  let eaten = 0
  let subjTotal = 0
  for (let i = 0; i < W * H; i++) {
    const removed = out.data[i * 4 + 3]! === 0
    if (c.bg[i]) {
      bgTotal++
      if (!removed) residual++
    } else {
      subjTotal++
      if (removed) eaten++
    }
  }
  return { residual: residual / bgTotal, eaten: subjTotal === 0 ? 0 : eaten / subjTotal }
}

describe('背景分析', () => {
  it('纯色背景只得到一个参考色，置信度为 1', () => {
    const m = analyzeBackground(solidWhite().img)
    expect(m.references.length).toBe(1)
    expect(m.reference).toEqual([255, 255, 255])
    expect(m.confidence).toBeCloseTo(1, 2)
    expect(m.roughness).toBe(0)
  })

  it('双色背景得到两个参考色 —— 只给一个的话有一半必然漏掉', () => {
    const m = analyzeBackground(twoTone().img)
    expect(m.references.length).toBe(2)
    const has = (rgb: [number, number, number]) =>
      m.references.some((r) => Math.abs(r[0] - rgb[0]) <= 4 && Math.abs(r[1] - rgb[1]) <= 4 && Math.abs(r[2] - rgb[2]) <= 4)
    expect(has([135, 190, 235])).toBe(true) // 天空
    expect(has([96, 150, 70])).toBe(true) // 草地
    expect(m.confidence).toBeCloseTo(1, 2)
  })

  it('参考色不超过 3 个 —— 再多就开始把主体当成背景', () => {
    const c = alloc()
    // 四色条纹背景
    fillBg(c, (_x, y) => {
      const stripes: [number, number, number][] = [
        [255, 255, 255],
        [200, 210, 220],
        [150, 160, 170],
        [90, 100, 110],
      ]
      return stripes[Math.floor((y / H) * 4)]!
    })
    expect(analyzeBackground(c.img).references.length).toBeLessThanOrEqual(3)
  })

  it('花哨的背景置信度低 —— 界面据此提示用户手动指定', () => {
    const m = analyzeBackground(jpegNoise().img)
    expect(m.confidence).toBeLessThan(0.6)
  })

  it('主体压在边缘时不会被当成背景色（否则主体会从贴边处被啃掉）', () => {
    const m = analyzeBackground(subjectOnBorder().img)
    // 主体色是 (40,45,130)，只占边缘的一小部分，不该进入参考色
    const isSubject = m.references.some(
      (r) => Math.abs(r[0] - 40) < 10 && Math.abs(r[1] - 45) < 10 && Math.abs(r[2] - 130) < 10,
    )
    expect(isSubject).toBe(false)
  })

  it('边缘全透明时退化成白色，不抛错', () => {
    const img: RasterImage = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) }
    const m = analyzeBackground(img)
    expect(m.reference).toEqual([255, 255, 255])
    expect(m.confidence).toBe(0)
  })

  it('退化尺寸（1×1、1×N）不会越界', () => {
    for (const [w, h] of [
      [1, 1],
      [1, 9],
      [9, 1],
      [2, 2],
    ] as const) {
      const img: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
      expect(() => analyzeBackground(img)).not.toThrow()
    }
  })
})

describe('抠图：背景要扣干净', () => {
  const cases: [string, () => Case][] = [
    ['纯白底', solidWhite],
    ['纵向渐变', gradient],
    ['渐变 + 硬边主体', gradientHardSubject],
    ['暗角', vignette],
    ['双色背景', twoTone],
    ['JPEG 噪声', jpegNoise],
    ['柔和投影', realisticShadow],
  ]

  for (const [name, make] of cases) {
    it(`${name}：容差 32 下背景全部扣掉`, () => {
      const s = score(make())
      // 留 1% 余量给抗锯齿过渡带里那些"本来就是混合色"的像素
      expect(s.residual, `残留背景 ${(s.residual * 100).toFixed(1)}%`).toBeLessThan(0.01)
      expect(s.eaten).toBe(0)
    })
  }

  it('渐变背景在任何容差下都不该留下大半张 —— 调参救不回来是修复前的病征', () => {
    for (const tol of [12, 16, 24, 32, 50]) {
      expect(score(gradient(), tol).residual).toBeLessThan(0.05)
    }
  })
})

describe('抠图：主体不能少', () => {
  it('主体内部的白色高光原样保留 —— 泛洪只删与边缘连通的区域', () => {
    const c = whiteInterior()
    const out = removeBackground(c.img, { model: analyzeBackground(c.img), tolerance: TOL })
    // 两块高光都必须还在
    for (const [x, y] of [
      [90, 85],
      [95, 90],
      [110, 85],
      [115, 90],
    ] as const) {
      expect(out.data[(y * W + x) * 4 + 3]).toBe(255)
    }
  })

  it('白底上的细线完整保留', () => {
    expect(score(thinFeatures()).eaten).toBe(0)
  })

  it('压在画面边缘的主体不会被啃掉 —— 靠色簇占比门槛挡住', () => {
    expect(score(subjectOnBorder()).eaten).toBe(0)
  })

  it('浅色主体 + 柔边：只损失模糊过渡带，主体核心保留', () => {
    const c = alloc()
    fillBg(c, () => [255, 255, 255])
    softRect(c, 60, 60, 140, 140, [210, 214, 220], 4)
    // 过渡带本身是混合色，损失它是正常的；核心必须留下
    expect(score(c).eaten).toBeLessThan(0.1)
  })

  it('白色主体靠一圈淡描边与白背景区分时，描边能挡住蔓延', () => {
    const c = alloc()
    fillBg(c, () => [255, 255, 255])
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(Math.max(60 - x, x - 139, 0), Math.max(60 - y, y - 139, 0))
        if (d <= 3) px(c.img, x, y, 230, 230, 230)
      }
    }
    rect(c, 60, 60, 140, 140, [255, 255, 255])
    expect(score(c).eaten).toBe(0)
  })
})

describe('抠图的边界条件', () => {
  it('容差 0 时只认与参考色一模一样的像素', () => {
    const c = gradient()
    // 渐变图上除了第一行，没有像素与参考色完全相同
    const s = score(c, 0)
    expect(s.eaten).toBe(0)
    expect(s.residual).toBeGreaterThan(0.9)
  })

  it('容差调大不会让残留变多（单调性）—— 否则滑块会前后乱跳', () => {
    const c = gradientHardSubject()
    const model = analyzeBackground(c.img)
    let prev = 1
    for (const tol of [8, 16, 24, 32, 40, 50]) {
      const r = score(c, tol, model).residual
      expect(r, `容差 ${tol} 时残留反弹了`).toBeLessThanOrEqual(prev + 1e-9)
      prev = r
    }
  })

  it('同一份模型用在降采样图与原图上，结果都扣得干净', () => {
    // 这正是生产路径：模型在小图上算一次，预览图和全分辨率量化共用
    const c = gradientHardSubject()
    const small = downscaleImage(c.img, 100)
    const model = analyzeBackground(small)
    const out = removeBackground(c.img, { model, tolerance: TOL })
    let residual = 0
    let bgTotal = 0
    for (let i = 0; i < W * H; i++) {
      if (!c.bg[i]) continue
      bgTotal++
      if (out.data[i * 4 + 3]! !== 0) residual++
    }
    expect(residual / bgTotal).toBeLessThan(0.02)
  })

  it('大面积的纯色图不会把栈挤爆 —— 每个像素只入栈一次', () => {
    // 修复前是出队时才标记，同一像素会被 4 个邻居各压一次，栈深度可达 4·w·h
    const size = 300
    const img: RasterImage = {
      width: size,
      height: size,
      data: new Uint8ClampedArray(size * size * 4),
    }
    for (let i = 0; i < size * size; i++) {
      img.data[i * 4] = 255
      img.data[i * 4 + 1] = 255
      img.data[i * 4 + 2] = 255
      img.data[i * 4 + 3] = 255
    }
    const out = removeBackground(img, { model: analyzeBackground(img), tolerance: TOL })
    for (let i = 0; i < size * size; i++) {
      expect(out.data[i * 4 + 3]).toBe(0)
    }
  })

  it('结果是确定的：同样输入跑两次完全一致', () => {
    const c = gradientHardSubject()
    const model = analyzeBackground(c.img)
    const a = removeBackground(c.img, { model, tolerance: TOL })
    const b = removeBackground(c.img, { model, tolerance: TOL })
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
  })

  it('吸管指定颜色时只认它 —— 用户明确指了背景，不该再自动扩展', () => {
    const model = backgroundModelFrom([135, 190, 235])
    expect(model.references.length).toBe(1)
    expect(model.confidence).toBe(1)
    // 只认天空色，草地会留下
    const c = twoTone()
    const out = removeBackground(c.img, { model, tolerance: TOL })
    const grass = (150 * W + 30) * 4
    expect(out.data[grass + 3]).toBe(255) // 草地还在
  })

  it('不改动入参', () => {
    const c = gradient()
    const before = Array.from(c.img.data)
    removeBackground(c.img, { model: analyzeBackground(c.img), tolerance: TOL })
    expect(Array.from(c.img.data)).toEqual(before)
  })
})

describe('反转抠图', () => {
  it('把透明的部分变成不透明，其余全透明', () => {
    const img: RasterImage = {
      width: 2,
      height: 1,
      data: Uint8ClampedArray.from([1, 2, 3, 0, 4, 5, 6, 255]),
    }
    const out = invertAlpha(img)
    expect(Array.from(out.data)).toEqual([255, 255, 255, 255, 0, 0, 0, 0])
  })
})
