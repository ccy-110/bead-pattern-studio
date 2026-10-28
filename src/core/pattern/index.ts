export type {
  Pattern,
  PatternColor,
  PatternSourceInfo,
  PatternGenerationParams,
  ColorStat,
  PatternStats,
  PurchaseOptions,
} from './types'
export { toPatternColor, DEFAULT_PURCHASE_OPTIONS } from './types'

export { computeStats } from './stats'
export type { BoardTile, BoardPlan } from './stats'
export { planBoards } from './stats'

export {
  PATTERN_FORMAT,
  PATTERN_VERSION,
  PatternParseError,
  serializePattern,
  parsePatternFile,
  suggestFileName,
} from './serialize'
export type { PatternFileV1, SerializeExtras } from './serialize'

export { SYMBOL_SEQUENCE, symbolFor, isDarkColor, contrastTextColor } from './symbols'

export {
  DEFAULT_BOARD_SIZE,
  DEFAULT_CELLS,
  MIN_CELLS,
  MAX_CELLS,
  clampCells,
  cellsForPhysicalMm,
  physicalMmForCells,
  resolveSize,
  snapToBoard,
  boardsNeeded,
  formatPhysical,
} from './sizing'
export type { CellSize, SizeDriver } from './sizing'
