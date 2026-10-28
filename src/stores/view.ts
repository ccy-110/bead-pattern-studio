import { reactive } from 'vue'

import type { GridMode } from '@/core/render/grid'

/**
 * 显示与导出选项。
 *
 * 单独放在一个 store 里，是因为这些选项要同时喂给两个互不相邻的地方：
 * 中间的图纸画布（屏幕上怎么显示）和左侧的导出面板（导出成什么样）。
 * 用 props 一层层传要穿过整个 App，而且两边看到的值必须**是同一份** ——
 * 否则会出现"屏幕上看着有网格线，导出后没有"这种最让人恼火的不一致。
 */
export interface ViewOptions {
  /** 彩色 / 黑白符号 / 线稿 */
  mode: GridMode
  showRuler: boolean
  /** 是否画网格线（关闭后只剩色块，看整体效果更清楚） */
  showGrid: boolean
  /** 每隔几格加粗一条线 */
  majorEvery: number
  /** 导出时是否在格子里印色号 */
  showCode: boolean
  /**
   * 打印倍率：图纸上 1 格 = 实物 1 颗豆，倍率决定印出来放大多少倍。
   * 1 倍是实际大小，可以直接垫在底板下照着摆，但格子只有 5mm 见方，塞不下色号。
   */
  printScale: number
  /** 导出 PNG 时的目标宽度（像素） */
  exportWidth: number
  /**
   * 打印时是否分页。
   *
   * 默认开。图纸的物理尺寸是硬的，300 格 × 5 毫米就是 1.5 米，
   * 一张 A4 装不下；这时浏览器会把整张图缩到纸宽，于是"按真实尺寸打印"失效，
   * 用户拿尺子一比才发现每格小了一半。分页是唯一能同时保住尺寸和可读性的做法。
   */
  paginate: boolean
  /**
   * 导出 PDF 的排版方式。
   *
   * `paged` 按豆子实际尺寸切成多页 A4，打印出来能垫在底板下面照着摆；
   * `single` 把整张图压进一页，页面尺寸随图纸走，适合在屏幕上放大看和转发。
   * 两种场景都真实存在，所以做成选项而不是替用户定死。
   */
  pdfLayout: 'paged' | 'single'
}

export const view = reactive<ViewOptions>({
  mode: 'color',
  showRuler: true,
  showGrid: true,
  majorEvery: 5,
  showCode: true,
  printScale: 1.5,
  exportWidth: 2400,
  paginate: true,
  pdfLayout: 'paged',
})

export const MAJOR_EVERY_OPTIONS = [5, 10] as const
export const PRINT_SCALE_OPTIONS = [1, 1.5, 2] as const

export const PDF_LAYOUT_OPTIONS = [
  { value: 'paged', label: '实际尺寸分页', hint: '按真实尺寸切成多页 A4，打印出来能垫在底板下照着摆' },
  { value: 'single', label: '单页全图', hint: '整张图压进一页，页面尺寸随图纸走，适合放大看和转发' },
] as const
