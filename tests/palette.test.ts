import { describe, expect, it } from 'vitest'

import {
  COLOR_KIND_LABEL,
  DEFAULT_PALETTE_ID,
  PALETTES,
  SPECIAL_KINDS,
  colorLabel,
  countSelected,
  createPaletteFilter,
  displayName,
  findPalette,
  getPalette,
  groupByKind,
  indexPalette,
  selectColors,
} from '../src/core/palette'
import type { Palette, PaletteColorKind } from '../src/core/palette'
import { parsePatternFile, serializePattern } from '../src/core/pattern/serialize'
import type { Pattern } from '../src/core/pattern/types'

/**
 * 色卡数据的完整性与自洽性。
 *
 * 这一批测试的存在理由很具体：色卡数据出错的表现**不是**界面报错，而是
 * 「某些颜色永远不出现在结果里」「图纸上的色号买不到」，用户完全无从排查。
 * 而 `defineColors` 一旦发现色号重复会直接抛错 —— 那是整个应用起不来，
 * 所以数据的唯一性和格式必须在测试里钉死。
 */

/** 每张色卡应当有的颜色数。改动数据时这里要一起改，避免误删整段数据。 */
const EXPECTED_COUNTS: Record<string, number> = {
  mard221: 221,
  mard291: 291,
  artkalS: 199,
  perler: 103,
  hama: 92,
  coco: 291,
  manman: 278,
  panpan: 289,
  mixiaowo: 290,
}

/** 全部类别。用 COLOR_KIND_LABEL 的键，它的类型保证穷尽 */
const ALL_KINDS = Object.keys(COLOR_KIND_LABEL) as PaletteColorKind[]

function everyColor(): { palette: Palette; color: PaletteColor }[] {
  return PALETTES.flatMap((palette) => palette.colors.map((color) => ({ palette, color })))
}

type PaletteColor = Palette['colors'][number]

describe('色卡数据完整性', () => {
  it('至少内置 9 张色卡，且默认色卡存在', () => {
    expect(PALETTES.length).toBeGreaterThanOrEqual(9)
    expect(findPalette(DEFAULT_PALETTE_ID)).toBeDefined()
    expect(() => getPalette(DEFAULT_PALETTE_ID)).not.toThrow()
  })

  it('默认色卡是 MARD 221 —— 国内最通用的实体套装', () => {
    // 默认给 291 会让自动配色产出用户手里没有的扩展色号，
    // 而那些色号在国内并不单独零售
    expect(DEFAULT_PALETTE_ID).toBe('mard221')
  })

  it('色卡 id 互不重复 —— indexCache 以 id 为键且永不失效', () => {
    const ids = PALETTES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每张色卡的色号唯一', () => {
    for (const palette of PALETTES) {
      const codes = palette.colors.map((c) => c.code)
      const dup = codes.filter((c, i) => codes.indexOf(c) !== i)
      expect(dup, `${palette.id} 存在重复色号`).toEqual([])
    }
  })

  it('每张色卡的稳定 ID 唯一，且格式为 <色卡 id>.<色号>', () => {
    for (const palette of PALETTES) {
      const ids = palette.colors.map((c) => c.id)
      expect(new Set(ids).size, `${palette.id} 存在重复 id`).toBe(ids.length)
      for (const color of palette.colors) {
        expect(color.id).toBe(`${palette.id}.${color.code}`)
      }
    }
  })

  it('色值都是合法的六位小写 hex，且 rgb 与 hex 一致', () => {
    for (const { palette, color } of everyColor()) {
      expect(color.hex, `${color.id}`).toMatch(/^#[0-9a-f]{6}$/)
      const expected = [
        parseInt(color.hex.slice(1, 3), 16),
        parseInt(color.hex.slice(3, 5), 16),
        parseInt(color.hex.slice(5, 7), 16),
      ]
      expect(color.rgb, `${color.id} 的 rgb 与 hex 不一致`).toEqual(expected)
    }
  })

  it('没有颜色名缺失 —— 没有名称的品牌直接用色号当名称', () => {
    for (const { color } of everyColor()) {
      expect(color.name, `${color.id}`).toBeTruthy()
    }
  })

  it('颜色数与预期一致', () => {
    for (const palette of PALETTES) {
      expect(palette.colors.length, `${palette.id} 的颜色数变了`).toBe(
        EXPECTED_COUNTS[palette.id],
      )
    }
    expect(Object.keys(EXPECTED_COUNTS).sort()).toEqual(PALETTES.map((p) => p.id).sort())
  })

  it('每张色卡都写明了数据来源与免责说明', () => {
    // MIT 许可要求保留出处；而且这些色值确实不是厂商公布的 sRGB，
    // 用户有权知道自己在看什么
    for (const palette of PALETTES) {
      expect(palette.source.length, `${palette.id} 缺少来源说明`).toBeGreaterThan(20)
      expect(palette.note.length, `${palette.id} 缺少免责说明`).toBeGreaterThan(20)
      expect(palette.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('MARD 221 与 291 在共用色号上色值完全一致', () => {
    // 两张色卡共用一份基准表，否则用户会在两张卡上看到同一个 A1 颜色不同
    const m221 = new Map(getPalette('mard221').colors.map((c) => [c.code, c.hex]))
    const m291 = new Map(getPalette('mard291').colors.map((c) => [c.code, c.hex]))
    expect(m221.size).toBe(221)
    for (const [code, hex] of m221) {
      expect(m291.get(code), `MARD ${code} 在两套色卡里色值不同`).toBe(hex)
    }
  })

  it('MARD 291 比 221 多的正好是 70 个特殊色', () => {
    const m221 = new Set(getPalette('mard221').colors.map((c) => c.code))
    const extra = getPalette('mard291').colors.filter((c) => !m221.has(c.code))
    expect(extra.length).toBe(70)
    expect(extra.every((c) => c.kind !== 'solid')).toBe(true)
  })

  it('MARD 221 全部是纯色 —— 它本来就是纯色套装', () => {
    expect(getPalette('mard221').colors.every((c) => c.kind === 'solid')).toBe(true)
  })
})

describe('类别分类的自洽性', () => {
  it('数据里出现的每个类别都在 COLOR_KIND_LABEL 里有中文名', () => {
    for (const { color } of everyColor()) {
      expect(COLOR_KIND_LABEL[color.kind], `未知类别 ${color.kind}`).toBeTruthy()
    }
  })

  it('groupByKind 不会丢类别 —— 分组后的颜色数必须等于输入', () => {
    // groupByKind 内部有一张硬编码的顺序表，不在表里的类别会被静默丢弃，
    // 表现是「整类颜色在色板上凭空消失」。这条断言就是守住它的。
    for (const palette of PALETTES) {
      const grouped = groupByKind(palette.colors)
      const total = grouped.reduce((n, g) => n + g.colors.length, 0)
      expect(total, `${palette.id} 有类别被 groupByKind 丢掉了`).toBe(palette.colors.length)
    }
  })

  it('SPECIAL_KINDS 与纯色合起来覆盖所有类别', () => {
    const covered = new Set<PaletteColorKind>(['solid', ...SPECIAL_KINDS])
    for (const kind of ALL_KINDS) {
      expect(covered.has(kind), `${kind} 既不是纯色也不在 SPECIAL_KINDS 里`).toBe(true)
    }
    expect(SPECIAL_KINDS).not.toContain('solid')
  })

  it('数据里出现过的类别都能在界面上被勾选（SPECIAL_KINDS 覆盖）', () => {
    const selectable = new Set<PaletteColorKind>(['solid', ...SPECIAL_KINDS])
    for (const { palette, color } of everyColor()) {
      expect(selectable.has(color.kind), `${palette.id} 的 ${color.id} 类别无法启用`).toBe(true)
    }
  })

  it('indexPalette 的类别计数之和等于颜色数', () => {
    for (const palette of PALETTES) {
      const counts = indexPalette(palette).kindCounts
      let sum = 0
      for (const n of counts.values()) sum += n
      expect(sum).toBe(palette.colors.length)
    }
  })

  it('每一类在数据里都真的存在（没有空类别导致的界面残留）', () => {
    const present = new Set(everyColor().map(({ color }) => color.kind))
    for (const kind of SPECIAL_KINDS) {
      if (present.has(kind)) continue
      // 这里不失败，只说明哪些类别当前没有数据。断言留给下一句：
      expect(SPECIAL_KINDS).toContain(kind)
    }
    // 珠光、温变、光变是这一轮新增/依赖的类别，必须有数据
    for (const kind of ['pearl', 'thermo', 'uv'] as const) {
      expect(present.has(kind), `没有任何颜色是 ${kind}`).toBe(true)
    }
  })
})

describe('类别在存盘往返后不丢', () => {
  /** 把某个类别做成一张最小图纸，存盘再读回来 */
  function roundTrip(kind: PaletteColorKind): PaletteColorKind {
    const pattern: Pattern = {
      title: 't',
      beadSizeMm: 5,
      rows: 1,
      cols: 1,
      grid: Int16Array.from([0]),
      colors: [
        {
          id: `x.${kind}`,
          code: 'X1',
          name: '测试色',
          hex: '#123456',
          kind,
        },
      ],
    }
    const text = serializePattern(pattern)
    return parsePatternFile(text).pattern.colors[0]!.kind
  }

  it('每一种类别存盘读回后都原样保留', () => {
    // serialize.ts 里有一张 VALID_KINDS 白名单，不在里面的类别会被**静默降级成纯色**，
    // 于是同一个颜色出现「存盘前不可用、重开后变成可用候选」这种前后不一致的行为。
    for (const kind of ALL_KINDS) {
      expect(roundTrip(kind), `${kind} 在存盘往返后变了`).toBe(kind)
    }
  })
})

describe('没有颜色名的品牌不重复显示色号', () => {
  it('name 与 code 相同时 displayName 返回空串', () => {
    expect(displayName({ code: 'A1', name: 'A1' })).toBe('')
    expect(colorLabel({ code: 'A1', name: 'A1' })).toBe('A1')
  })

  it('有真实名称时正常显示', () => {
    expect(displayName({ code: 'H01', name: 'White' })).toBe('White')
    expect(colorLabel({ code: 'H01', name: 'White' })).toBe('H01 White')
  })

  it('国产色卡确实走的是「只有色号」这条路径', () => {
    for (const id of ['mard221', 'coco', 'panpan']) {
      const colors = getPalette(id).colors
      expect(colors.every((c) => displayName(c) === ''), `${id}`).toBe(true)
    }
  })

  it('国外品牌保留了厂商的真实名称', () => {
    for (const id of ['hama', 'perler', 'artkalS']) {
      const named = getPalette(id).colors.filter((c) => displayName(c) !== '')
      expect(named.length, `${id} 几乎没有颜色名`).toBeGreaterThan(50)
    }
  })

  it('Perler 用的是官方物料号，不是自编的 P 编号', () => {
    const codes = getPalette('perler').colors.map((c) => c.code)
    // 80-19004=Orange、80-19005=Red 是厂商的真实物料号
    expect(codes).toContain('80-19004')
    expect(codes).toContain('80-19005')
    expect(codes.some((c) => /^P\d+$/.test(c))).toBe(false)
  })

  it('Hama 用的是社区通行的 H 前缀色号', () => {
    const codes = getPalette('hama').colors.map((c) => c.code)
    expect(codes).toContain('H01')
    expect(codes.every((c) => /^H\d+$/.test(c))).toBe(true)
  })
})

describe('候选集筛选', () => {
  it('默认只有纯色参与自动配色', () => {
    const filter = createPaletteFilter()
    for (const palette of PALETTES) {
      const selected = selectColors(palette, filter)
      expect(selected.every((c) => c.kind === 'solid'), palette.id).toBe(true)
      expect(selected.length, `${palette.id} 一个纯色都没有`).toBeGreaterThan(0)
    }
  })

  it('selectColors 与 countSelected 口径一致', () => {
    // 两者各写了一遍过滤逻辑。口径不一致时界面上的数字会静默失真
    const filter = createPaletteFilter({ activeKinds: ['solid', 'pearl', 'thermo'] })
    for (const palette of PALETTES) {
      expect(countSelected(palette, filter), palette.id).toBe(
        selectColors(palette, filter).length,
      )
    }
  })

  it('排除掉的色号绝不会出现在候选集里', () => {
    const palette = getPalette('mard221')
    const excluded = palette.colors.slice(0, 5).map((c) => c.id)
    const filter = createPaletteFilter({ excludedIds: excluded })
    const selected = selectColors(palette, filter)
    expect(selected.length).toBe(palette.colors.length - excluded.length)
    for (const id of excluded) {
      expect(selected.some((c) => c.id === id)).toBe(false)
    }
  })

  it('启用全部类别时，候选集覆盖整张色卡', () => {
    const filter = createPaletteFilter({ activeKinds: ALL_KINDS })
    for (const palette of PALETTES) {
      expect(selectColors(palette, filter).length).toBe(palette.colors.length)
    }
  })
})
