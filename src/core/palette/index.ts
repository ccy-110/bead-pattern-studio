import { artkalSPalette } from './data/artkal'
import { cocoPalette } from './data/coco'
import { hamaPalette } from './data/hama'
import { manmanPalette } from './data/manman'
import { mard221Palette, mard291Palette } from './data/mard'
import { mixiaowoPalette } from './data/mixiaowo'
import { panpanPalette } from './data/panpan'
import { perlerPalette } from './data/perler'
import type { Palette, PaletteColor, PaletteColorKind } from './types'

export * from './types'
export { PaletteMatcher } from './matcher'

/**
 * 内置色卡。
 *
 * 顺序即 UI 中的展示顺序，排在最前的是默认选中的那张。
 *
 * **MARD 221 排第一**：MARD 是国内零售和图纸交流的实际默认色号体系（图纸和教程
 * 普遍标注 MARD 色号），而 221 是大多数人手里实际持有的那套实体豆。
 * 默认用 221 而不是 291，是为了保证自动配色绝不会产出用户买不到的扩展色号——
 * 需要全色系的人自己去切换。
 *
 * 色号与色值全部来自公开色卡数据（MIT 许可，见仓库 data-sources/ 目录），
 * 不再有任何自编的色号。同一色号在不同品牌之间**不通用**，这正是本表按品牌
 * 分卡的原因。
 */
export const PALETTES: readonly Palette[] = [
  mard221Palette,
  mard291Palette,
  artkalSPalette,
  perlerPalette,
  hamaPalette,
  cocoPalette,
  manmanPalette,
  panpanPalette,
  mixiaowoPalette,
]

export const DEFAULT_PALETTE_ID = mard221Palette.id

/**
 * 每个色卡建立索引，避免在渲染循环里反复 `colors.find(...)`。
 * 色卡最多一百来项，但对齐图例、恢复图纸文件时可能被调用上千次。
 */
export interface PaletteIndex {
  readonly palette: Palette
  readonly byId: ReadonlyMap<string, PaletteColor>
  readonly byCode: ReadonlyMap<string, PaletteColor>
  /** 按色系分类计数，用于在设置面板里显示"纯色 51 种"这类提示 */
  readonly kindCounts: ReadonlyMap<PaletteColorKind, number>
}

const indexCache = new Map<string, PaletteIndex>()

export function indexPalette(palette: Palette): PaletteIndex {
  const cached = indexCache.get(palette.id)
  if (cached) return cached

  const byId = new Map<string, PaletteColor>()
  const byCode = new Map<string, PaletteColor>()
  const kindCounts = new Map<PaletteColorKind, number>()

  for (const color of palette.colors) {
    byId.set(color.id, color)
    byCode.set(color.code, color)
    kindCounts.set(color.kind, (kindCounts.get(color.kind) ?? 0) + 1)
  }

  const index: PaletteIndex = { palette, byId, byCode, kindCounts }
  indexCache.set(palette.id, index)
  return index
}

export function getPalette(id: string): Palette {
  const found = PALETTES.find((p) => p.id === id)
  if (!found) throw new Error(`未知色卡: ${id}`)
  return found
}

export function findPalette(id: string): Palette | undefined {
  return PALETTES.find((p) => p.id === id)
}

/**
 * 默认开启的颜色类别：**只有纯色**。
 *
 * 特殊色（金属、珠光、夜光、透明、闪粉、荧光）全部默认关闭，原因很实际：
 * 新手手里通常只有一盒纯色豆，如果自动配色里混进了"珠光珊瑚粉"，
 * 用户拿着图纸去买会发现根本没这个色，或者得单买一小包。
 * 想用特殊色是可以的 —— 在设置里按类别勾选即可，但必须是用户主动的选择。
 */
export const DEFAULT_ACTIVE_KINDS: readonly PaletteColorKind[] = ['solid']

export interface PaletteFilter {
  /** 允许参与的类别。空集合会导致候选色为空，调用方需保证非空。 */
  readonly activeKinds: ReadonlySet<PaletteColorKind>
  /** 用户手动排除的色号 ID（"我手里没有这个色"） */
  readonly excludedIds: ReadonlySet<string>
  /** 是否排除已停产的色号 */
  readonly excludeDiscontinued: boolean
}

export function createPaletteFilter(
  overrides: Partial<{
    activeKinds: Iterable<PaletteColorKind>
    excludedIds: Iterable<string>
    excludeDiscontinued: boolean
  }> = {},
): PaletteFilter {
  return {
    activeKinds: new Set(overrides.activeKinds ?? DEFAULT_ACTIVE_KINDS),
    excludedIds: new Set(overrides.excludedIds ?? []),
    excludeDiscontinued: overrides.excludeDiscontinued ?? false,
  }
}

/**
 * 按筛选条件挑出候选色。
 *
 * 返回值就是量化器的候选集 —— 量化过程**绝不会产生这里没有的颜色**，
 * 所以用户取消勾选某个色号，成品里就一定不会出现它。
 */
export function selectColors(
  palette: Palette,
  filter: PaletteFilter,
): PaletteColor[] {
  return palette.colors.filter((c) => {
    if (!filter.activeKinds.has(c.kind)) return false
    if (filter.excludedIds.has(c.id)) return false
    if (filter.excludeDiscontinued && c.discontinued === true) return false
    return true
  })
}

/** 统计某个筛选条件下有多少颜色可用，用于实时提示 */
export function countSelected(palette: Palette, filter: PaletteFilter): number {
  let n = 0
  for (const c of palette.colors) {
    if (!filter.activeKinds.has(c.kind)) continue
    if (filter.excludedIds.has(c.id)) continue
    if (filter.excludeDiscontinued && c.discontinued === true) continue
    n++
  }
  return n
}

/**
 * 按类别分组，用于在颜色选择器里分节展示。
 * 组内保持色卡原本的顺序（即按色号排），不打乱。
 */
export function groupByKind(
  colors: readonly PaletteColor[],
): { kind: PaletteColorKind; colors: PaletteColor[] }[] {
  // 这个数组必须覆盖 PaletteColorKind 的每一个取值：
  // 不在里面的类别会被下面的 filter 静默丢掉，用户在色板里根本看不到那类颜色。
  const order: PaletteColorKind[] = [
    'solid',
    'metallic',
    'pearl',
    'glitter',
    'neon',
    'glow',
    'thermo',
    'uv',
    'transparent',
  ]

  const groups = new Map<PaletteColorKind, PaletteColor[]>()
  for (const c of colors) {
    const list = groups.get(c.kind)
    if (list) list.push(c)
    else groups.set(c.kind, [c])
  }

  return order
    .filter((k) => groups.has(k))
    .map((k) => ({ kind: k, colors: groups.get(k)! }))
}

/**
 * 全部特殊色的类别，供 UI 做"一键全选特殊色"之类的操作。
 */
export const SPECIAL_KINDS: readonly PaletteColorKind[] = [
  'metallic',
  'pearl',
  'transparent',
  'glow',
  'glitter',
  'neon',
  'thermo',
  'uv',
]
