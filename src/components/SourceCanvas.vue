<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { RGB } from '@/core/color/types'
import type { CropRect } from '@/core/quantize'
import {
  effectiveCrop,
  previewImage,
  previewVersion,
  setBackgroundReference,
  setCrop,
  state,
} from '@/stores/project'

/**
 * 原图预览。
 *
 * 这一层要同时承担三件事：看调色效果、看抠图结果、定裁剪框。
 * 三者都作用在同一张图上，所以合成一次绘制比叠三个画布更省事，
 * 也避免了对齐误差。
 *
 * 抠掉的背景用**棋盘格**显示。这是图像工具的通行语言，
 * 用户一眼就知道那块是"没有内容"而不是"白色内容"——
 * 后者会导致他们以为抠图没生效。
 */

const props = defineProps<{ picking: boolean }>()
const emit = defineEmits<{ (e: 'picked'): void }>()

const hostRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

const viewW = ref(0)
const viewH = ref(0)
const zoom = ref(1)
const panX = ref(0)
const panY = ref(0)

const dpr = Math.min(3, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)

/** 预览图相对工作图的缩放比。裁剪框存的是工作图坐标，换算时要用到。 */
const ratio = computed(() => {
  const img = previewImage.value
  if (!img || state.workingWidth === 0) return 1
  return state.workingWidth / img.width
})

/** 图像在容器里的摆放：缩放比 + 左上角位置 */
const view = computed(() => {
  const img = previewImage.value
  if (!img || viewW.value === 0 || viewH.value === 0) return null

  const base = Math.min(viewW.value / img.width, viewH.value / img.height)
  const s = base * zoom.value
  return {
    s,
    x: (viewW.value - img.width * s) / 2 + panX.value,
    y: (viewH.value - img.height * s) / 2 + panY.value,
  }
})

/** 裁剪框的屏幕坐标 */
const cropBox = computed(() => {
  const v = view.value
  if (!v) return null
  const c = effectiveCrop.value
  const k = 1 / ratio.value
  return {
    x: v.x + c.x * k * v.s,
    y: v.y + c.y * k * v.s,
    w: c.width * k * v.s,
    h: c.height * k * v.s,
  }
})

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

/**
 * 预览图的离屏副本。
 *
 * `putImageData` 不受变换矩阵影响，所以必须先落到离屏画布上，
 * 再用 `drawImage` 缩放画进可见画布。每次换图才重建一次。
 */
let offscreen: HTMLCanvasElement | null = null

function rebuildOffscreen(): void {
  const img = previewImage.value
  if (!img) {
    offscreen = null
    return
  }
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  offscreen = c
}

function draw(): void {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return

  canvas.width = Math.max(1, Math.round(viewW.value * dpr))
  canvas.height = Math.max(1, Math.round(viewH.value * dpr))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, viewW.value, viewH.value)

  const v = view.value
  if (!v || !offscreen) return

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // 不放大到 1 倍以上，否则只是把像素糊成方块，看不出任何新信息
  ctx.imageSmoothingEnabled = v.s < 8
  ctx.drawImage(offscreen, v.x, v.y, offscreen.width * v.s, offscreen.height * v.s)
}

function scheduleDraw(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

let frame = 0

watch([previewVersion, viewW, viewH, zoom, panX, panY], () => scheduleDraw())

watch(previewVersion, () => {
  rebuildOffscreen()
  draw()
})

// ---------------------------------------------------------------------------
// 坐标换算
// ---------------------------------------------------------------------------

/** 容器坐标 → 工作图像素坐标 */
function toWorking(clientX: number, clientY: number): { x: number; y: number } | null {
  const host = hostRef.value
  const v = view.value
  if (!host || !v) return null

  const rect = host.getBoundingClientRect()
  const k = ratio.value
  return {
    x: ((clientX - rect.left - v.x) / v.s) * k,
    y: ((clientY - rect.top - v.y) / v.s) * k,
  }
}

// ---------------------------------------------------------------------------
// 裁剪框拖动
// ---------------------------------------------------------------------------

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

const MIN_CROP = 8

let drag: {
  handle: Handle
  startX: number
  startY: number
  origin: CropRect
} | null = null

function beginDrag(handle: Handle, e: PointerEvent): void {
  const p = toWorking(e.clientX, e.clientY)
  if (!p) return
  drag = {
    handle,
    startX: p.x,
    startY: p.y,
    origin: { ...effectiveCrop.value },
  }
  ;(e.target as Element).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function onDragMove(e: PointerEvent): void {
  if (!drag) return
  const p = toWorking(e.clientX, e.clientY)
  if (!p) return

  const dx = p.x - drag.startX
  const dy = p.y - drag.startY
  const o = drag.origin
  const W = state.workingWidth
  const H = state.workingHeight

  let { x, y, width, height } = o

  if (drag.handle === 'move') {
    x = clamp(o.x + dx, 0, W - o.width)
    y = clamp(o.y + dy, 0, H - o.height)
  } else {
    const h = drag.handle
    if (h.includes('w')) {
      const nx = clamp(o.x + dx, 0, o.x + o.width - MIN_CROP)
      width = o.width + (o.x - nx)
      x = nx
    }
    if (h.includes('e')) {
      width = clamp(o.width + dx, MIN_CROP, W - o.x)
    }
    if (h.includes('n')) {
      const ny = clamp(o.y + dy, 0, o.y + o.height - MIN_CROP)
      height = o.height + (o.y - ny)
      y = ny
    }
    if (h.includes('s')) {
      height = clamp(o.height + dy, MIN_CROP, H - o.y)
    }
  }

  setCrop({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  })
}

function endDrag(): void {
  drag = null
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// ---------------------------------------------------------------------------
// 吸管 / 缩放
// ---------------------------------------------------------------------------

function onPointerDown(e: PointerEvent): void {
  const host = hostRef.value
  if (!host) return

  // 中键平移
  if (e.button === 1 || e.altKey) {
    panning = { x: e.clientX, y: e.clientY, panX: panX.value, panY: panY.value }
    host.setPointerCapture(e.pointerId)
    e.preventDefault()
    return
  }

  if (e.button !== 0) return

  if (props.picking) {
    const p = toWorking(e.clientX, e.clientY)
    const img = previewImage.value
    if (!p || !img) return

    const k = 1 / ratio.value
    const px = clamp(Math.round(p.x * k), 0, img.width - 1)
    const py = clamp(Math.round(p.y * k), 0, img.height - 1)
    const o = (py * img.width + px) * 4
    const rgb: RGB = [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!]
    setBackgroundReference(rgb)
    emit('picked')
  }
}

let panning: { x: number; y: number; panX: number; panY: number } | null = null

function onPointerMove(e: PointerEvent): void {
  if (panning) {
    panX.value = panning.panX + (e.clientX - panning.x)
    panY.value = panning.panY + (e.clientY - panning.y)
    return
  }
  onDragMove(e)
}

function onPointerUp(): void {
  endDrag()
  panning = null
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const host = hostRef.value
  if (!host) return

  const rect = host.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  const next = clamp(zoom.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 12)
  const k = next / zoom.value
  if (k === 1) return

  // 保持光标下的点不动
  panX.value = cx - (cx - panX.value) * k
  panY.value = cy - (cy - panY.value) * k
  zoom.value = next
}

function resetView(): void {
  zoom.value = 1
  panX.value = 0
  panY.value = 0
}

defineExpose({ resetView })

// ---------------------------------------------------------------------------

let observer: ResizeObserver | null = null

onMounted(() => {
  const host = hostRef.value
  if (!host) return

  observer = new ResizeObserver(() => {
    const rect = host.getBoundingClientRect()
    viewW.value = Math.max(1, Math.round(rect.width))
    viewH.value = Math.max(1, Math.round(rect.height))
  })
  observer.observe(host)

  const rect = host.getBoundingClientRect()
  viewW.value = Math.max(1, Math.round(rect.width))
  viewH.value = Math.max(1, Math.round(rect.height))

  rebuildOffscreen()
  draw()

  host.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('pointerup', onPointerUp)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('pointerup', onPointerUp)
  if (frame) cancelAnimationFrame(frame)
  offscreen = null
})

const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
</script>

<template>
  <div
    ref="hostRef"
    class="source-canvas checker"
    :class="{ picking }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @contextmenu.prevent
  >
    <canvas ref="canvasRef" class="canvas-layer" />

    <div
      v-if="cropBox && !picking"
      class="crop-box"
      :style="{
        left: `${cropBox.x}px`,
        top: `${cropBox.y}px`,
        width: `${cropBox.w}px`,
        height: `${cropBox.h}px`,
      }"
      @pointerdown.stop="beginDrag('move', $event)"
    >
      <div
        v-for="h in handles"
        :key="h"
        class="crop-handle"
        :class="`h-${h}`"
        @pointerdown.stop="beginDrag(h, $event)"
      />
    </div>

    <div v-if="picking" class="pick-hint">点击图中要抠掉的背景色</div>
  </div>
</template>

<style scoped>
.source-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
  background-color: #fff;
}

.source-canvas.picking {
  cursor: crosshair;
}

.canvas-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

/* 裁剪框外侧压暗，让"保留哪一块"一目了然。
   用超大 box-shadow 而不是四个遮罩 div，省掉一堆定位代码。 */
.crop-box {
  position: absolute;
  box-shadow: 0 0 0 9999px rgb(0 0 0 / 45%);
  outline: 1px solid rgb(255 255 255 / 90%);
  cursor: move;
  touch-action: none;
}

.crop-handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #fff;
  border: 1px solid var(--accent);
  border-radius: 2px;
}

.h-nw { left: -6px; top: -6px; cursor: nwse-resize; }
.h-n  { left: calc(50% - 6px); top: -6px; cursor: ns-resize; }
.h-ne { right: -6px; top: -6px; cursor: nesw-resize; }
.h-e  { right: -6px; top: calc(50% - 6px); cursor: ew-resize; }
.h-se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.h-s  { left: calc(50% - 6px); bottom: -6px; cursor: ns-resize; }
.h-sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.h-w  { left: -6px; top: calc(50% - 6px); cursor: ew-resize; }

.pick-hint {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 999px;
  background: rgb(0 0 0 / 72%);
  color: #fff;
  font-size: 12px;
  pointer-events: none;
  white-space: nowrap;
}
</style>
