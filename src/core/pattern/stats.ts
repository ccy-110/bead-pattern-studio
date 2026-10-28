import type {
  ColorStat,
  Pattern,
  PatternStats,
  PurchaseOptions,
} from './types'
import { DEFAULT_PURCHASE_OPTIONS } from './types'

/**
 * 统计豆子用量。
 *
 * 这张表才是用户真正拿去下单的依据 —— 图纸画得再漂亮，
 * 「每种颜色买多少颗」算错了，整个产品的价值就没了。
 *
 * 两个容易被忽略但很实际的点：
 *  - **损耗**：熨烫会烫坏、拼的过程中会掉粒、不同批次有色差需要补。
 *    按经验多备 5%~10%，默认 8%。
 *  - **整包折算**：拼豆按包卖，买 3 颗也要买一整包。
 *    把"需要几包"直接算出来，用户才不用自己拿计算器除。
 */
export function computeStats(
  pattern: Pattern,
  purchase: PurchaseOptions = DEFAULT_PURCHASE_OPTIONS,
): PatternStats {
  const { rows, cols, colors, grid, beadSizeMm } = pattern

  const counts = new Int32Array(colors.length)
  let totalBeads = 0
  let emptyCells = 0

  for (let i = 0; i < grid.length; i++) {
    const v = grid[i]!
    if (v === -1) {
      emptyCells++
      continue
    }
    // 越界下标说明图纸数据已损坏，宁可报错也不要静默产出错误统计
    if (v < 0 || v >= colors.length) {
      throw new Error(`图纸数据损坏：第 ${i} 格的色号下标 ${v} 超出范围`)
    }
    counts[v] = counts[v]! + 1
    totalBeads++
  }

  const stats: ColorStat[] = []
  for (let i = 0; i < colors.length; i++) {
    const count = counts[i]!
    if (count === 0) continue

    // 含损耗的建议备货量，向上取整
    const purchaseCount = Math.ceil(count * (1 + purchase.wasteRatio))
    const packs = Math.max(1, Math.ceil(purchaseCount / purchase.beadsPerPack))

    stats.push({
      colorIndex: i,
      color: colors[i]!,
      count,
      purchase: purchaseCount,
      packs,
    })
  }

  // 按用量降序 —— 用户买豆子时最关心"哪种用得最多"
  stats.sort((a, b) => b.count - a.count)

  const totalCells = rows * cols

  return {
    totalBeads,
    emptyCells,
    colorCount: stats.length,
    fillRatio: totalCells === 0 ? 0 : totalBeads / totalCells,
    colors: stats,
    widthMm: cols * beadSizeMm,
    heightMm: rows * beadSizeMm,
  }
}

/**
 * 图纸在真实底板上的分板方案。
 *
 * 真实拼豆底板是固定尺寸的（常见 29×29），一张 50×50 的图纸
 * 实际是用多块底板拼起来的，相邻底板之间有**重叠的连接区**。
 * 没有分板图，用户面对一整张大图会不知道从哪下手。
 *
 * 分板按"从左到右、从上到下"编号，每块板带自己的行列偏移，
 * 渲染时只画落在该板范围内的格子。
 */
export interface BoardTile {
  /** 板序号，从 1 开始，按行优先 */
  index: number
  /** 该板左上角在整张图纸中的位置（格坐标） */
  rowOffset: number
  colOffset: number
  /** 该板实际覆盖的行列数（边缘板可能不足一整块） */
  rows: number
  cols: number
  /** 板内格数 */
  cells: number
}

export interface BoardPlan {
  boardRows: number
  boardCols: number
  /** 每块底板的边长（格） */
  boardSize: number
  /** 相邻底板的重叠格数，真实拼法需要重叠才能连接 */
  overlap: number
  tiles: BoardTile[]
  totalBoards: number
}

/**
 * 计算分板方案。
 *
 * 步长 = 板边长 - 重叠量。重叠是真实拼豆的必需操作：
 * 两块底板必须共用若干列/行格子，成品才能连成一体。
 * 默认重叠 1 格（大多数拼法用到的连接量）。
 */
export function planBoards(
  rows: number,
  cols: number,
  boardSize = 29,
  overlap = 1,
): BoardPlan {
  if (boardSize < 2) throw new Error('底板边长至少为 2 格')
  if (overlap < 0 || overlap >= boardSize) {
    throw new Error('重叠格数必须小于底板边长')
  }

  const step = boardSize - overlap
  const rowStarts = axisStarts(rows, boardSize, step)
  const colStarts = axisStarts(cols, boardSize, step)

  const tiles: BoardTile[] = []
  let index = 1
  for (const r of rowStarts) {
    for (const c of colStarts) {
      const h = Math.min(boardSize, rows - r)
      const w = Math.min(boardSize, cols - c)
      tiles.push({
        index: index++,
        rowOffset: r,
        colOffset: c,
        rows: h,
        cols: w,
        cells: h * w,
      })
    }
  }

  return {
    boardRows: rowStarts.length,
    boardCols: colStarts.length,
    boardSize,
    overlap,
    tiles,
    totalBoards: tiles.length,
  }
}

/**
 * 计算一个方向上每块底板的起始格坐标。
 *
 * 终止条件是"这一块已经覆盖到末尾"，而不是"起点还在范围内"。
 * 这个区别在图纸尺寸接近底板边长时是致命的：
 * 29 行的图纸配 29 格底板，若按起点判断会切出第二块只含第 28 行的废板，
 * 而那一行本来就已经被第一块板盖住了。
 *
 * 相邻起点的间距固定为 step，因此重叠量始终一致 —— 这符合真实拼法，
 * 用户需要靠这点重叠把两块板连成一体。
 */
function axisStarts(n: number, boardSize: number, step: number): number[] {
  const starts: number[] = []
  let s = 0
  for (;;) {
    starts.push(s)
    if (s + boardSize >= n) break
    s += step
  }
  return starts
}
