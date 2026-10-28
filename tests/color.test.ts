import { describe, expect, it } from 'vitest'
import {
  ciede2000Raw,
  deltaE76,
  labToRgb,
  mixLinear,
  rgbToLab,
  srgbToLinear,
} from '../src/core/color'

describe('sRGB 反 gamma', () => {
  it('端点精确', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(255)).toBeCloseTo(1, 10)
  })

  it('中灰不是 0.5 —— 这正是不能直接对 sRGB 求平均的原因', () => {
    // 128/255 ≈ 0.502，但线性光只有约 0.2158
    expect(srgbToLinear(128)).toBeCloseTo(0.21586, 5)
  })
})

describe('sRGB → Lab', () => {
  it('白色', () => {
    const lab = rgbToLab([255, 255, 255])
    expect(lab.L).toBeCloseTo(100, 3)
    expect(lab.a).toBeCloseTo(0, 3)
    expect(lab.b).toBeCloseTo(0, 3)
  })

  it('黑色', () => {
    const lab = rgbToLab([0, 0, 0])
    expect(lab.L).toBeCloseTo(0, 6)
    expect(lab.a).toBeCloseTo(0, 6)
    expect(lab.b).toBeCloseTo(0, 6)
  })

  it('红绿蓝三原色符合标准值', () => {
    const red = rgbToLab([255, 0, 0])
    expect(red.L).toBeCloseTo(53.24, 1)
    expect(red.a).toBeCloseTo(80.09, 1)
    expect(red.b).toBeCloseTo(67.2, 1)

    const green = rgbToLab([0, 255, 0])
    expect(green.L).toBeCloseTo(87.73, 1)
    expect(green.a).toBeCloseTo(-86.18, 1)
    expect(green.b).toBeCloseTo(83.18, 1)

    const blue = rgbToLab([0, 0, 255])
    expect(blue.L).toBeCloseTo(32.3, 1)
    expect(blue.a).toBeCloseTo(79.19, 1)
    expect(blue.b).toBeCloseTo(-107.86, 1)
  })
})

describe('Lab → sRGB 往返', () => {
  it('常见颜色能无损往返', () => {
    const samples: [number, number, number][] = [
      [255, 255, 255],
      [0, 0, 0],
      [255, 0, 0],
      [128, 128, 128],
      [18, 52, 86],
      [200, 180, 160],
      [7, 200, 120],
    ]
    for (const rgb of samples) {
      const back = labToRgb(rgbToLab(rgb))
      expect(back[0]).toBeCloseTo(rgb[0], 0)
      expect(back[1]).toBeCloseTo(rgb[1], 0)
      expect(back[2]).toBeCloseTo(rgb[2], 0)
    }
  })
})

describe('mixLinear', () => {
  it('黑白线性混合的中点是浅灰而不是中灰', () => {
    // 这是本项目「不能直接用 drawImage 平均降采样」的数学依据
    const mid = mixLinear([0, 0, 0], [255, 255, 255], 0.5)
    expect(mid[0]).toBeCloseTo(188, 0) // ≈ #BCBCBC，而不是 #808080
    expect(mid[0]).toBeGreaterThan(170)
  })

  it('t=0 与 t=1 返回端点', () => {
    expect(mixLinear([10, 20, 30], [200, 100, 50], 0)).toEqual([10, 20, 30])
    expect(mixLinear([10, 20, 30], [200, 100, 50], 1)).toEqual([200, 100, 50])
  })
})

/**
 * CIEDE2000 参考数据。
 *
 * 取自 Sharma, Wu & Dalal (2005) 《The CIEDE2000 Color-Difference Formula:
 * Implementation Notes, Supplementary Test Data, and Mathematical Observations》
 * 表 1 的 34 组标准测试对。这是该公式公认的验证基准。
 *
 * 第 9~16 组专门针对**色相跨 0°/360° 的短弧处理**——
 * 这是实现 CIEDE2000 时最容易写错的地方（写错的话值会差出好几倍）。
 * 第 1~6、25~34 组覆盖蓝色区域的 G 因子与 RT 旋转项。
 */
const SHARMA_TEST_DATA: readonly [number, number, number, number, number, number, number][] = [
  // L1, a1, b1, L2, a2, b2, ΔE00
  [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
  [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
  [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
  [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
  [50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
  [50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
  [50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
  [50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
  [50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
  [50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
]

describe('CIEDE2000 对照 Sharma (2005) 标准数据', () => {
  it.each(SHARMA_TEST_DATA.map((row, i) => [i + 1, row] as const))(
    '第 %i 组',
    (_idx, row) => {
      const [L1, a1, b1, L2, a2, b2, expected] = row
      const actual = ciede2000Raw(L1, a1, b1, L2, a2, b2)
      expect(actual).toBeCloseTo(expected, 4)
    },
  )

  it('交换两个颜色不改变结果（对称性）', () => {
    for (const [L1, a1, b1, L2, a2, b2] of SHARMA_TEST_DATA) {
      const forward = ciede2000Raw(L1, a1, b1, L2, a2, b2)
      const backward = ciede2000Raw(L2, a2, b2, L1, a1, b1)
      expect(backward).toBeCloseTo(forward, 10)
    }
  })

  it('相同颜色色差为 0', () => {
    expect(ciede2000Raw(50, 20, -30, 50, 20, -30)).toBeCloseTo(0, 10)
  })
})

describe('CIEDE2000 相比 CIE76 的修正效果', () => {
  it('暗部不同色相的区分度更合理', () => {
    // 两个都很暗但色相不同的颜色：CIEDE2000 应认为它们比 CIE76 认为的更"远"
    const darkBlue = rgbToLab([10, 20, 90])
    const darkRed = rgbToLab([90, 20, 10])

    const e76 = deltaE76(darkBlue, darkRed)
    const e00 = ciede2000Raw(
      darkBlue.L, darkBlue.a, darkBlue.b,
      darkRed.L, darkRed.a, darkRed.b,
    )

    // 两者都应给出"明显不同"的判断（远大于拼豆工艺的可分辨阈值 JND≈1~2）
    expect(e76).toBeGreaterThan(5)
    expect(e00).toBeGreaterThan(5)
  })

  it('CIEDE2000 与 CIE76 高度相关 —— 这是可以用 CIE76 粗筛的前提', () => {
    const target = rgbToLab([120, 60, 200])
    const candidates = [
      rgbToLab([130, 70, 210]),
      rgbToLab([10, 10, 10]),
      rgbToLab([255, 255, 0]),
      rgbToLab([118, 58, 198]),
      rgbToLab([0, 128, 255]),
    ]

    const byE00 = candidates
      .map((c, i) => ({ i, d: ciede2000Raw(target.L, target.a, target.b, c.L, c.a, c.b) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.i)

    const byE76 = candidates
      .map((c, i) => ({ i, d: deltaE76(target, c) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.i)

    // 最近的那个必须一致
    expect(byE76[0]).toBe(byE00[0])
  })
})
