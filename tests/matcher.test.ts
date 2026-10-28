import { describe, expect, it } from 'vitest'

import { ciede2000Raw, rgbToLabInto } from '../src/core/color'
import { PALETTES, PaletteMatcher, getPalette } from '../src/core/palette'
import type { PaletteColor } from '../src/core/palette'

/**
 * 匹配器的正确性。
 *
 * `PaletteMatcher` 为了性能做了两级近似：先用 CIE76 粗筛出前 `PREFILTER_K` 名，
 * 再对这几个算精确的 CIEDE2000。而它的错误表现是最难被发现的那种：某个中间色
 * 匹配到的色号"看起来不太对"，但没人能证明它错。
 *
 * 所以这里拿全量 CIEDE2000 穷举当基准，直接比对**距离**（而不是色卡下标——
 * 色卡里存在色值完全相同或极接近的颜色时，取哪个都对，比下标会误报）。
 *
 * 这个测试同时守住 `PREFILTER_K`：实测它取 6 时约 3% 的查询失配、最差差 6.9 个
 * CIEDE2000 单位（肉眼可辨阈值约 1~2），已改为 48。色卡若再变大到粗筛不够用，
 * 这里会失败，届时调大那个常数。
 */

/**
 * 允许的距离容差，单位是 CIEDE2000。
 *
 * 不要求逐位相等：个别色卡里存在近乎重复的颜色（如 COCO 有一对相差 0.3 的颜色），
 * 此时两种排序都"正确"。0.5 远低于肉眼可辨阈值，因此它仍然能抓住真正的失配
 * （K=6 时最差差 6.9）。
 */
const TOLERANCE = 0.5

/** 确定性的伪随机，保证失败可复现 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const scratch = new Float64Array(3)
const other = new Float64Array(3)

/** 全量扫描的精确最近邻距离（不关心是哪一个，只关心距离） */
function bruteForceDistance(colors: readonly PaletteColor[], r: number, g: number, b: number): number {
  rgbToLabInto(r, g, b, scratch, 0)
  let best = Infinity
  for (let i = 0; i < colors.length; i++) {
    const rgb = colors[i]!.rgb
    rgbToLabInto(rgb[0], rgb[1], rgb[2], other, 0)
    const d = ciede2000Raw(scratch[0]!, scratch[1]!, scratch[2]!, other[0]!, other[1]!, other[2]!)
    if (d < best) best = d
  }
  return best
}

/** 匹配器给出的颜色，按 CIEDE2000 衡量的实际距离 */
function matcherDistance(colors: readonly PaletteColor[], index: number, r: number, g: number, b: number): number {
  rgbToLabInto(r, g, b, scratch, 0)
  const rgb = colors[index]!.rgb
  rgbToLabInto(rgb[0], rgb[1], rgb[2], other, 0)
  return ciede2000Raw(scratch[0]!, scratch[1]!, scratch[2]!, other[0]!, other[1]!, other[2]!)
}

describe('匹配器与全量穷举等价', () => {
  for (const palette of PALETTES) {
    it(`${palette.id}（${palette.colors.length} 色）随机取色不失配`, () => {
      const matcher = new PaletteMatcher(palette.colors)
      const rng = makeRng(0x5eed ^ palette.colors.length)
      const samples = 400
      let mismatches = 0
      let worstGap = 0
      let worstCase = ''

      for (let i = 0; i < samples; i++) {
        const r = Math.floor(rng() * 256)
        const g = Math.floor(rng() * 256)
        const b = Math.floor(rng() * 256)

        const got = matcherDistance(palette.colors, matcher.findNearest(r, g, b), r, g, b)
        const want = bruteForceDistance(palette.colors, r, g, b)

        const gap = got - want
        if (gap > TOLERANCE) {
          mismatches++
          if (gap > worstGap) {
            worstGap = gap
            worstCase = `rgb(${r},${g},${b}) 粗筛结果差 ${gap.toFixed(3)}`
          }
        }
      }

      expect(mismatches, `${palette.id}：${mismatches}/${samples} 次失配，${worstCase}`).toBe(0)
    })
  }

  it('最大色卡上按 RGB 立方体均匀扫描也不失配', () => {
    // 随机取色可能碰不到色卡密集的区域，均匀扫描能覆盖到边界地带
    const palette = getPalette('mard291')
    const matcher = new PaletteMatcher(palette.colors)
    let mismatches = 0

    for (let r = 0; r < 256; r += 32) {
      for (let g = 0; g < 256; g += 32) {
        for (let b = 0; b < 256; b += 32) {
          const got = matcherDistance(palette.colors, matcher.findNearest(r, g, b), r, g, b)
          const want = bruteForceDistance(palette.colors, r, g, b)
          if (got - want > TOLERANCE) mismatches++
        }
      }
    }

    expect(mismatches, `均匀扫描有 ${mismatches} 个格子失配`).toBe(0)
  })

  it('色卡里每个颜色都能匹配回它自己', () => {
    for (const palette of PALETTES) {
      const matcher = new PaletteMatcher(palette.colors)
      for (let i = 0; i < palette.colors.length; i++) {
        const rgb = palette.colors[i]!.rgb
        const idx = matcher.findNearest(rgb[0], rgb[1], rgb[2])
        const got = palette.colors[idx]!.rgb
        // 允许匹配到色值完全相同的另一个色号（色卡里确实存在）
        expect(
          [got[0], got[1], got[2]],
          `${palette.id} 的 ${palette.colors[i]!.code} 匹配到了 ${palette.colors[idx]!.code}`,
        ).toEqual([rgb[0], rgb[1], rgb[2]])
      }
    }
  })

  it('结果可复现：同样的输入两次完全一致', () => {
    const palette = getPalette('mard291')
    const a = new PaletteMatcher(palette.colors)
    const b = new PaletteMatcher(palette.colors)
    const rng = makeRng(7)
    for (let i = 0; i < 300; i++) {
      const r = Math.floor(rng() * 256)
      const g = Math.floor(rng() * 256)
      const bl = Math.floor(rng() * 256)
      expect(a.findNearest(r, g, bl)).toBe(b.findNearest(r, g, bl))
    }
  })

  it('空色卡明确报错，而不是产出随机结果', () => {
    expect(() => new PaletteMatcher([])).toThrow()
  })
})
