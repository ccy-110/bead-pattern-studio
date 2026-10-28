import type { BeadSize } from '../palette/types'

/**
 * 图纸尺寸的换算。
 *
 * 用户在三种语言之间切换：「我要 50 格宽」「我要 15 厘米宽」「我要正好铺满 4 块底板」。
 * 三者说的是同一件事，但换算关系容易算错，所以统一收在这里，并且有测试兜底。
 */

/** 常见底板的边长（格）。29×29 是国内最普及的规格。 */
export const DEFAULT_BOARD_SIZE = 29

/** 格数下限。再小就没有图案可言了。 */
export const MIN_CELLS = 2
/**
 * 格数上限。300 格配 5mm 豆就是 1.5 米见方，
 * 已经远超手工制作的合理范围，同时也要防止误输入把浏览器算死。
 */
export const MAX_CELLS = 300
/** 单边格数的默认值，也是"上传图片后立刻看到效果"的起点 */
export const DEFAULT_CELLS = 48

export function clampCells(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CELLS
  return Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.round(n)))
}

/** 成品物理尺寸（毫米）→ 格数 */
export function cellsForPhysicalMm(mm: number, beadSizeMm: BeadSize): number {
  if (!Number.isFinite(mm) || mm <= 0) return MIN_CELLS
  return clampCells(mm / beadSizeMm)
}

/** 格数 → 成品物理尺寸（毫米） */
export function physicalMmForCells(cells: number, beadSizeMm: BeadSize): number {
  return cells * beadSizeMm
}

export type SizeDriver = 'rows' | 'cols'

export interface CellSize {
  rows: number
  cols: number
}

/**
 * 保持宽高比地定出格数。
 *
 * @param driver 用户刚刚改动的那一维 —— 它是权威，另一维跟着它算。
 *               必须知道是谁驱动的，否则"改行"和"改列"会互相覆盖。
 * @param aspect 宽 / 高。取自裁剪区（或原图）的像素比，非法时按 1 处理。
 *
 * **先按比例缩放，最后才夹取。** 反过来的话，3:1 的图配 300 行时
 * 列会先被夹到 300，比例信息就丢了，结果是一个正方形 —— 图会被拉伸变形。
 * 正确做法是发现 900 列越界后，把行列一起除以 3，得到 100×300。
 *
 * 极扁/极长的比例在触到格数下限时仍会有轻微变形，
 * 但那种尺寸（比如 2×50 格）本就不可用，不值得为它把逻辑复杂化。
 */
export function resolveSize(
  input: CellSize,
  aspect: number,
  driver: SizeDriver,
): CellSize {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1

  const rawRows = driver === 'rows' ? input.rows : input.cols / a
  const rawCols = driver === 'cols' ? input.cols : input.rows * a

  const over = Math.max(rawRows, rawCols) / MAX_CELLS
  const k = over > 1 ? over : 1

  return {
    rows: clampCells(rawRows / k),
    cols: clampCells(rawCols / k),
  }
}

/**
 * 把格数对齐到底板的整数倍。
 *
 * 拼豆是拼在底板上的，图纸尺寸正好是底板的整数倍时，就能一块不多一块不少地拼完。
 * 多出来的零头意味着你要么空着半块板，要么把图案挪到板中间（然后边缘对不齐）。
 *
 * **一律向上取整，绝不向下。** 40 格吸到 29 会悄悄砍掉 11 列图案，
 * 而用户很可能到买豆子的时候才发现少了内容；吸到 58 只是多留 18 列空白，
 * 而且预览里一眼就能看见。宁可浪费底板，不可丢内容。
 * 这一点与 `boardsNeeded` 的向上取整保持一致 —— 两者说的必须是同一件事。
 */
export function snapToBoard(cells: number, boardSize: number): number {
  if (boardSize < 2) return clampCells(cells)
  const boards = Math.max(1, Math.ceil(cells / boardSize))
  return clampCells(boards * boardSize)
}

/** 需要几块底板（按正方形底板拼成 rows × cols 的矩形） */
export function boardsNeeded(
  rows: number,
  cols: number,
  boardSize: number,
): { across: number; down: number; total: number } {
  const size = Math.max(2, boardSize)
  const across = Math.ceil(cols / size)
  const down = Math.ceil(rows / size)
  return { across, down, total: across * down }
}

/** 成品尺寸的中文表述，例如 "24.0 × 24.0 厘米" */
export function formatPhysical(
  cells: number,
  beadSizeMm: BeadSize,
): string {
  const mm = physicalMmForCells(cells, beadSizeMm)
  return mm >= 100 ? `${(mm / 10).toFixed(1)} 厘米` : `${Math.round(mm)} 毫米`
}
