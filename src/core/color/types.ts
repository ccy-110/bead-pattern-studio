/**
 * 色彩基础类型。
 *
 * 全项目约定：
 * - RGB 一律是 **sRGB、0~255、未经 gamma 线性化** 的值，与 CSS hex 一致。
 * - Lab 一律是 **CIELAB, D65 白点**，L ∈ [0,100]，a/b 大致 ∈ [-128,127]。
 *
 * 为什么不直接用 RGB 算距离：sRGB 的欧氏距离在感知上极不均匀，
 * 典型错误是把深蓝匹配成黑色、深红匹配成棕色。所有颜色匹配一律走 Lab。
 */

/** sRGB 三元组，分量取值 0~255 */
export type RGB = readonly [number, number, number]

/** CIELAB 颜色 */
export interface Lab {
  readonly L: number
  readonly a: number
  readonly b: number
}

/** 线性光 RGB，分量取值 0~1（已去 gamma） */
export interface LinearRGB {
  readonly r: number
  readonly g: number
  readonly b: number
}
