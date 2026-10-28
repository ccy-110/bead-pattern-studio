<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { GridMode } from '@/core/render/grid'
import { computeGridLayout, renderPattern } from '@/core/render/grid'
import {
  beginStroke,
  cancelStroke,
  endStroke,
  fillCells,
  gridVersion,
  paintCell,
  pattern,
  tool,
} from '@/stores/project'

/**
 * 图纸画布。
 *
 * ## 为什么每次都重画，而不是缓存一张大图再缩放
 *
 * 缓存整张图纸的做法在放大时会糊（文字尤其明显），而且要按最大缩放级别
 * 分配画布 —— 150×150 的图纸在 64px/格下是 9600×9600，接近 370MB，直接崩掉。
 *
 * 所以这里**只渲染视口内看得见的那部分**：画布始终和容器一样大，
 * 每次视图变化就带着可见区域重画一遍。可见区域通常是几十行几十列，
 * 一两毫秒就画完了，比缓存方案又快又清晰。
 */

/** 单格边长的缩放上下限（CSS 像素）。下限保证格子还看得见，上限避免过度放大。 */
const MIN_CELL = 2
const MAX_CELL = 64

const props = defineProps<{
  mode: GridMode
  showRuler: boolean
  showGrid: boolean
  showCode: boolean
  majorEvery: number
}>()

const emit = defineEmits<{
  (e: 'hover', cell: { row: number; col: number } | null): void
}>()

const hostRef = ref<HTMLDivElement | null>(null)
const baseRef = ref<HTMLCanvasElement | null>(null)
const overlayRef = ref<HTMLCanvasElement | null>(null)

/** 单格边长（CSS 像素） */
const cellSize = ref(20)
/** 图纸左上角在容器内的位置（CSS 像素） */
const panX = ref(0)
const panY = ref(0)

const viewW = ref(0)
const viewH = ref(0)
const dpr = ref(1)

/** 正在拖拽涂抹 */
let painting = false
/** 上一次落笔的格子，用于在快速拖动时补齐中间的格子 */
let lastCell: { row: number; col: number } | null = null
let panning = false
let panStart = { x: 0, y: 0, panX: 0, panY: 0 }
let hoverCell: { row: number; col: number } | null = null
/** 重画合并到下一帧，避免一次拖动里连画几十遍 */
let frame = 0

const hasPattern = computed(() => pattern.value !== null)

const gridOpts = computed(() => ({
  cellSize: cellSize.value,
  mode: props.mode,
  majorEvery: props.showGrid ? props.majorEvery : 0,
  showRuler: props.showRuler,
  detail: (props.showCode ? 'auto' : 'none') as 'auto' | 'none',
  emptyColor: '#eef0f3',
  backgroundColor: '#ffffff',
  highlight: null,
  highlightColor: '#e8590c',
}))

const gridLayout = computed(() => {
  const p = pattern.value
  if (!p) return null
  return computeGridLayout(p.rows, p.cols, gridOpts.value)
})

/** 请求重画（合并到下一帧） */
function scheduleDraw(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

function draw(): void {
  const canvas = baseRef.value
  const ctx = canvas?.getContext('2d')
  const p = pattern.value
  if (!canvas || !ctx || !p) return

  const scale = dpr.value
  canvas.width = Math.max(1, Math.round(viewW.value * scale))
  canvas.height = Math.max(1, Math.round(viewH.value * scale))

  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, viewW.value, viewH.value)

  const layout = gridLayout.value
  if (!layout) return

  const cs = layout.cellSize
  const { originX, originY } = layout

  // 容器左上角对应图案空间的哪个坐标
  const left = -panX.value
  const top = -panY.value

  const region = {
    colStart: Math.floor((left - originX) / cs),
    colEnd: Math.ceil((left + viewW.value - originX) / cs),
    rowStart: Math.floor((top - originY) / cs),
    rowEnd: Math.ceil((top + viewH.value - originY) / cs),
  }

  // 裁到图纸范围内，缩小后就不会看到白底漫出图案之外
  ctx.save()
  ctx.translate(panX.value, panY.value)
  ctx.beginPath()
  ctx.rect(0, 0, layout.totalWidth, layout.totalHeight)
  ctx.clip()
  renderPattern(ctx, p, { ...gridOpts.value, region })
  ctx.restore()
}

function drawOverlay(): void {
  const canvas = overlayRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return

  const scale = dpr.value
  canvas.width = Math.max(1, Math.round(viewW.value * scale))
  canvas.height = Math.max(1, Math.round(viewH.value * scale))

  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, viewW.value, viewH.value)

  const cell = hoverCell
  const layout = gridLayout.value
  if (!cell || !layout) return

  const x = panX.value + layout.originX + cell.col * layout.cellSize
  const y = panY.value + layout.originY + cell.row * layout.cellSize

  ctx.strokeStyle = '#e8590c'
  ctx.lineWidth = 2
  ctx.strokeRect(x - 1, y - 1, layout.cellSize + 2, layout.cellSize + 2)
}

// ---------------------------------------------------------------------------
// 坐标换算
// ---------------------------------------------------------------------------

function toCell(clientX: number, clientY: number): { row: number; col: number } | null {
  const p = pattern.value
  const host = hostRef.value
  const layout = gridLayout.value
  if (!p || !host || !layout) return null

  const rect = host.getBoundingClientRect()

  const px = clientX - rect.left - panX.value
  const py = clientY - rect.top - panY.value

  const col = Math.floor((px - layout.originX) / layout.cellSize)
  const row = Math.floor((py - layout.originY) / layout.cellSize)

  if (row < 0 || col < 0 || row >= p.rows || col >= p.cols) return null
  return { row, col }
}

// ---------------------------------------------------------------------------
// 视图操作
// ---------------------------------------------------------------------------

function fit(): void {
  const p = pattern.value
  if (!p) return

  const availW = Math.max(40, viewW.value - 32)
  const availH = Math.max(40, viewH.value - 32)

  // 反推每格多少像素才能刚好铺满
  const rulerGuess = props.showRuler ? 1.9 : 0
  const cell = Math.min(availW / (p.cols + rulerGuess), availH / (p.rows + rulerGuess))
  cellSize.value = Math.max(MIN_CELL, Math.min(MAX_CELL, cell))

  const layout = gridLayout.value
  if (layout) {
    panX.value = (viewW.value - layout.totalWidth) / 2
    panY.value = (viewH.value - layout.totalHeight) / 2
  }

  scheduleDraw()
}

function zoomAt(factor: number, cx: number, cy: number): void {
  const next = Math.max(MIN_CELL, Math.min(MAX_CELL, cellSize.value * factor))
  const k = next / cellSize.value
  if (k === 1) return

  // 让光标下的那个点在缩放前后停在原地
  panX.value = cx - (cx - panX.value) * k
  panY.value = cy - (cy - panY.value) * k
  cellSize.value = next
  scheduleDraw()
}

function zoomCenter(factor: number): void {
  zoomAt(factor, viewW.value / 2, viewH.value / 2)
}

defineExpose({ fit, zoomCenter, zoomAt, cellSize })

// ---------------------------------------------------------------------------
// 指针交互
// ---------------------------------------------------------------------------

/**
 * 在两点之间补齐格子。
 *
 * 快速拖动时指针事件是稀疏的：一次从第 3 列跳到第 8 列，
 * 中间 4 格会被漏掉，画出来的线断断续续。用 Bresenham 把中间的格子补上，
 * 手感才跟得上。
 */
function strokeLine(
  from: { row: number; col: number },
  to: { row: number; col: number },
): void {
  let { row: r0, col: c0 } = from
  const { row: r1, col: c1 } = to

  const dr = Math.abs(r1 - r0)
  const dc = Math.abs(c1 - c0)
  const sr = r0 < r1 ? 1 : -1
  const sc = c0 < c1 ? 1 : -1
  let err = dc - dr

  for (;;) {
    paintCell(r0, c0)
    if (r0 === r1 && c0 === c1) break
    const e2 = err * 2
    if (e2 > -dr) {
      err -= dr
      c0 += sc
    }
    if (e2 < dc) {
      err += dc
      r0 += sr
    }
  }
}

function onPointerDown(e: PointerEvent): void {
  const host = hostRef.value
  if (!host || !pattern.value) return

  // 中键 / 空格 / 右键 → 平移
  if (e.button === 1 || e.button === 2 || e.altKey) {
    panning = true
    panStart = { x: e.clientX, y: e.clientY, panX: panX.value, panY: panY.value }
    host.setPointerCapture(e.pointerId)
    e.preventDefault()
    return
  }

  if (e.button !== 0) return

  const cell = toCell(e.clientX, e.clientY)
  if (!cell) return

  host.setPointerCapture(e.pointerId)

  if (tool.value === 'fill') {
    beginStroke()
    fillCells(cell.row, cell.col)
    endStroke()
    scheduleDraw()
    return
  }

  painting = true
  lastCell = cell
  // 整笔只记一个还原点，抬起时才压入历史
  beginStroke()
  paintCell(cell.row, cell.col)
  updateHover(cell)
  scheduleDraw()
}

function onPointerMove(e: PointerEvent): void {
  const host = hostRef.value
  if (!host) return

  if (panning) {
    panX.value = panStart.panX + (e.clientX - panStart.x)
    panY.value = panStart.panY + (e.clientY - panStart.y)
    scheduleDraw()
    return
  }

  const cell = toCell(e.clientX, e.clientY)
  updateHover(cell)

  if (!painting || !cell) return
  if (lastCell && cell.row === lastCell.row && cell.col === lastCell.col) return

  if (lastCell) strokeLine(lastCell, cell)
  else paintCell(cell.row, cell.col)

  lastCell = cell
  scheduleDraw()
}

function endPaint(): void {
  if (panning) {
    panning = false
    return
  }
  if (painting) {
    painting = false
    lastCell = null
    endStroke()
    return
  }
  cancelStroke()
}

function onPointerUp(): void {
  endPaint()
}

function onPointerLeave(): void {
  updateHover(null)
}

function updateHover(cell: { row: number; col: number } | null): void {
  const same =
    (cell === null && hoverCell === null) ||
    (cell !== null && hoverCell !== null && cell.row === hoverCell.row && cell.col === hoverCell.col)
  if (same) return

  hoverCell = cell
  emit('hover', cell)
  drawOverlay()
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const host = hostRef.value
  if (!host) return

  const rect = host.getBoundingClientRect()
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top)
}

// ---------------------------------------------------------------------------
// 尺寸监听
// ---------------------------------------------------------------------------

let resizeObserver: ResizeObserver | null = null

function measure(): void {
  const host = hostRef.value
  if (!host) return
  const rect = host.getBoundingClientRect()
  const nextW = Math.max(1, Math.round(rect.width))
  const nextH = Math.max(1, Math.round(rect.height))
  const changed = nextW !== viewW.value || nextH !== viewH.value

  viewW.value = nextW
  viewH.value = nextH
  dpr.value = Math.min(3, window.devicePixelRatio || 1)

  if (changed) scheduleDraw()
}

onMounted(() => {
  const host = hostRef.value
  if (!host) return

  resizeObserver = new ResizeObserver(() => {
    const first = viewW.value === 0
    measure()
    if (first) fit()
  })
  resizeObserver.observe(host)
  measure()

  window.addEventListener('pointerup', onPointerUp)
  host.addEventListener('wheel', onWheel, { passive: false })
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('pointerup', onPointerUp)
  if (frame) cancelAnimationFrame(frame)
})

// 网格变了、图案换了、视图选项变了都要重画
watch(
  [
    gridVersion,
    pattern,
    () => props.mode,
    () => props.showRuler,
    () => props.showGrid,
    () => props.showCode,
  ],
  () => scheduleDraw(),
)

// 换图纸时自动重新适配视图
watch(
  () => pattern.value,
  (p, old) => {
    if (p && !old) fit()
  },
)

watch(viewW, () => drawOverlay())
</script>

<template>
  <div
    ref="hostRef"
    class="pattern-canvas"
    :class="{ 'is-painting': tool !== 'fill' }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @pointerup="onPointerUp"
    @contextmenu.prevent
  >
    <canvas ref="baseRef" class="canvas-layer" />
    <canvas ref="overlayRef" class="canvas-layer overlay" />
    <div v-if="!hasPattern" class="canvas-placeholder">尚未生成图纸</div>
  </div>
</template>

<style scoped>
.pattern-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  cursor: crosshair;
}

.canvas-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.overlay {
  pointer-events: none;
}

.canvas-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgb(255 255 255 / 70%);
  font-size: 13px;
}
</style>
