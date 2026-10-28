import type { RGB } from '../color/types'

/**
 * 豆子规格（单颗直径，毫米）。
 *
 * 注意：规格 **不改变** 网格矩阵本身，只决定成品的物理尺寸与打印比例。
 * 同一张 20×20 的图纸，用 5mm 豆拼出来是 10cm 见方，用 2.6mm 则是 5.2cm 见方。
 * 规格真正起作用的地方是「按成品厘米数反推行列数」这个换算。
 */
export type BeadSize = 2.6 | 5 | 10

/** 可选规格清单，供 UI 渲染 */
export const BEAD_SIZES: readonly BeadSize[] = [2.6, 5, 10]

export const BEAD_SIZE_LABEL: Record<BeadSize, string> = {
  2.6: '2.6mm 迷你',
  5: '5mm 标准',
  10: '10mm 大号',
}

/** 每种规格的常见底板边长（格数），仅用于 UI 提示 */
export const BEAD_BOARD_HINT: Record<BeadSize, string> = {
  2.6: '常见底板 29×29、58×58',
  5: '常见底板 10×10、15×15、20×20、29×29',
  10: '常见底板 10×10、15×15',
}

/**
 * 豆子的材质类型。
 *
 * 这些标记会参与算法决策：
 * - `transparent` 默认从匹配候选中 **排除** —— 它的 hex 表示的是透光后的颜色，
 *   直接参与匹配会得到很怪的结果。
 * - 除 `solid` 外全部属于特殊色，默认也排除，但用户可手动启用。
 *
 * 新增一个类别时，有**五处**硬编码列表必须同步，漏一处就会导致该类颜色在界面上
 * 整组消失（`groupByKind` 会静默丢弃不在顺序表里的类别）、或存盘后被静默降级成
 * 纯色（`serialize.ts` 的 VALID_KINDS 白名单）：
 * 这里、`COLOR_KIND_LABEL`、`index.ts` 的 `groupByKind` 顺序、`index.ts` 的
 * `SPECIAL_KINDS`、`pattern/serialize.ts` 的 `VALID_KINDS`。
 */
export type PaletteColorKind =
  | 'solid'
  | 'metallic'
  | 'pearl'
  | 'transparent'
  | 'glow'
  | 'glitter'
  | 'neon'
  /** 温变：在特定温度区间内可逆变色（MARD 的 Q 系列） */
  | 'thermo'
  /** 光变：紫外线照射后显色（MARD 的 ZG 系列） */
  | 'uv'

export const COLOR_KIND_LABEL: Record<PaletteColorKind, string> = {
  solid: '纯色',
  metallic: '金属色',
  pearl: '珠光色',
  transparent: '透明色',
  glow: '夜光色',
  glitter: '闪粉',
  neon: '荧光色',
  thermo: '温变色',
  uv: '光变色',
}

/** 除纯色外的都算特殊色，默认不参与自动配色 */
export function isSpecialColor(kind: PaletteColorKind): boolean {
  return kind !== 'solid'
}

/**
 * 取出值得显示的颜色名。
 *
 * 大部分国产品牌（MARD、COCO、漫漫、盼盼、咪小窝）**没有颜色名**——公开数据源和
 * 商家都是按色号销售的（「A1 一包」），所以数据里 `name` 与 `code` 相同。
 * 这类颜色如果再渲染一遍名称，图例上就会出现「A1 A1」这种纯噪声。
 *
 * 参数用结构类型而不是 `PaletteColor`，因为图纸里的 `PatternColor` 也要用
 * 同一个规则——它在 `pattern/types.ts`，而那一层依赖本文件，不能反过来依赖。
 */
export function displayName(color: { code: string; name: string }): string {
  return color.name === color.code ? '' : color.name
}

/** 图例、统计表、tooltip 统一用这个拼「色号 +（可选）名称」 */
export function colorLabel(color: { code: string; name: string }): string {
  const name = displayName(color)
  return name === '' ? color.code : `${color.code} ${name}`
}

export interface PaletteColor {
  /**
   * 稳定唯一 ID，格式 `<paletteId>.<code>`，例如 `perler.P17`。
   * 图纸文件里存的是这个 ID —— 换色卡时靠它做迁移映射。
   */
  readonly id: string
  /** 厂商标称色号，例如 "P17" / "H01" / "A12" */
  readonly code: string
  /** 中文名 */
  readonly name: string
  /** 英文名（选填，用于对照国外教程） */
  readonly nameEn?: string
  /** sRGB 十六进制，形如 "#RRGGBB" */
  readonly hex: string
  /** 与 hex 等价的分量形式，避免反复解析 */
  readonly rgb: RGB
  readonly kind: PaletteColorKind
  /** 是否已停产/难以买到 */
  readonly discontinued?: boolean
  /** 数据备注，例如"批次色差大" */
  readonly note?: string
}

export interface Palette {
  /** 色卡 ID，例如 "perler" */
  readonly id: string
  readonly name: string
  /**
   * 色卡数据版本。**修改任何一个颜色的 hex 都必须递增此版本号**，
   * 因为图纸文件的颜色 ID 依赖它来判断是否需要重新映射。
   */
  readonly version: string
  /** 数据来源说明 */
  readonly source: string
  /**
   * 精度免责声明。内置色卡全部是社区实测近似值，不是厂方公布的 sRGB。
   * UI 必须把这段话展示给用户，并提供校准入口。
   */
  readonly note: string
  readonly colors: readonly PaletteColor[]
}

/** 把 hex 解析成 RGB。非法输入抛错，便于尽早暴露脏数据。 */
export function parseHex(hex: string): RGB {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) throw new Error(`非法颜色值: ${hex}`)
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** RGB 转 hex，输入会被 clamp 并四舍五入 */
export function toHex(rgb: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${((c(rgb[0]) << 16) | (c(rgb[1]) << 8) | c(rgb[2])).toString(16).padStart(6, '0')}`
}

/**
 * 根据 hex 补全出 PaletteColor。
 * 色卡数据文件只写「code/name/hex/kind」，id 和 rgb 由这里统一派生，
 * 避免手写数据时出现 id 与 hex 不一致的低级错误。
 */
export function defineColor(
  paletteId: string,
  spec: {
    code: string
    name: string
    nameEn?: string
    hex: string
    kind?: PaletteColorKind
    discontinued?: boolean
    note?: string
  },
): PaletteColor {
  const rgb = parseHex(spec.hex)
  return {
    id: `${paletteId}.${spec.code}`,
    code: spec.code,
    name: spec.name,
    ...(spec.nameEn !== undefined ? { nameEn: spec.nameEn } : {}),
    hex: toHex(rgb),
    rgb,
    kind: spec.kind ?? 'solid',
    ...(spec.discontinued !== undefined ? { discontinued: spec.discontinued } : {}),
    ...(spec.note !== undefined ? { note: spec.note } : {}),
  }
}

/** 批量补全，同时校验色号唯一性 */
export function defineColors(
  paletteId: string,
  specs: readonly {
    code: string
    name: string
    nameEn?: string
    hex: string
    kind?: PaletteColorKind
    discontinued?: boolean
    note?: string
  }[],
): PaletteColor[] {
  const seen = new Set<string>()
  return specs.map((s) => {
    if (seen.has(s.code)) throw new Error(`色卡 ${paletteId} 中色号重复: ${s.code}`)
    seen.add(s.code)
    return defineColor(paletteId, s)
  })
}
