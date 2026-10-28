import { symbolFor } from '../pattern/symbols'
import type { GridMode } from './grid'

/**
 * 格内标注（色号或符号）的排布计算。
 *
 * 屏幕预览、PNG 导出、SVG 导出、打印四路输出共用这一份逻辑。此前 grid.ts 与
 * svg.ts 各自抄了一遍同样的公式，而那条公式**把格内色号钉死在 4 个字符**，
 * 还是无省略号的硬截断——Perler 的 `80-19001`、`80-19002` 会一起显示成 `80-1`，
 * 几十个色号互相无法区分。色号长度是随品牌变的（MARD 是 A1、Perler 是 80-19001），
 * 所以字号必须按**本张图纸里最长的色号**反算，而不是套一个常数。
 *
 * 放不下时退化为符号而不是截断：符号是无歧义的（图例上有对照表），
 * 截断的色号不是。Perler 的官方图纸本来也是用符号的。
 */

/** 色号使用的字号占格宽的比例（与旧实现一致，仅在没有长度压力时生效） */
const CODE_FONT_RATIO = 0.36
/** 符号是单字符且加粗，可以画得大得多 */
const SYMBOL_FONT_RATIO = 0.62
/** 格内文字实际可用的宽度占格宽的比例，其余是左右留白 */
const USABLE_RATIO = 0.88
/** 字号与字符宽度的经验比值 */
const CHAR_ASPECT = 0.62
/** 可读的字号下限，低于它就不写字了 */
export const MIN_LABEL_FONT = 6

export interface LabelPlan {
  detail: 'none' | 'symbol' | 'code'
  fontSize: number
  /** 每个颜色下标对应的格内文字；`detail === 'none'` 时为空数组 */
  labels: readonly string[]
}

/**
 * 决定格子里写什么。
 *
 * 只会**降级**（色号 → 符号 → 不写），不会升级：调用方传进来的 detail 已经是
 * 按格子大小定过的，这里只额外考虑「色号长度」这一个变量。
 */
export function planCellLabels(
  cellSize: number,
  detail: 'none' | 'symbol' | 'code',
  mode: GridMode,
  codes: readonly string[],
): LabelPlan {
  if (mode === 'outline' || detail === 'none') {
    return { detail: 'none', fontSize: MIN_LABEL_FONT, labels: [] }
  }

  if (detail === 'code') {
    const plan = codePlan(cellSize, codes)
    if (plan !== null) return plan
    // 色号放不下 → 退成符号
  }

  return {
    detail: 'symbol',
    fontSize: Math.max(MIN_LABEL_FONT, Math.floor(cellSize * SYMBOL_FONT_RATIO)),
    labels: codes.map((_, i) => symbolFor(i)),
  }
}

function codePlan(cellSize: number, codes: readonly string[]): LabelPlan | null {
  let longest = 0
  for (const code of codes) {
    if (code.length > longest) longest = code.length
  }
  if (longest === 0) return null

  // 既要满足常规字号，又要保证最长的色号塞得下，取两者中小的那个
  const fontSize = Math.min(
    Math.floor(cellSize * CODE_FONT_RATIO),
    Math.floor((cellSize * USABLE_RATIO) / (longest * CHAR_ASPECT)),
  )
  if (fontSize < MIN_LABEL_FONT) return null

  return { detail: 'code', fontSize, labels: codes }
}
