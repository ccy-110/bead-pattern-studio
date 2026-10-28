<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import AccountPanel from './components/AccountPanel.vue'
import EditPanel from './components/EditPanel.vue'
import ExportPanel from './components/ExportPanel.vue'
import PalettePanel from './components/PalettePanel.vue'
import PatternCanvas from './components/PatternCanvas.vue'
import SizePanel from './components/SizePanel.vue'
import SourceCanvas from './components/SourceCanvas.vue'
import SourcePanel from './components/SourcePanel.vue'
import StatsPanel from './components/StatsPanel.vue'
import { boardsNeeded } from './core/pattern'
import type { GridMode } from './core/render/grid'
import {
  canRedo,
  canUndo,
  hasImage,
  openImageFile,
  pattern,
  redo,
  redoLabel,
  state,
  tool,
  undo,
  undoLabel,
} from './stores/project'
import { view } from './stores/view'

/**
 * 应用外壳。
 *
 * 三栏布局：左栏是"从原图到参数"的完整流程，中间是画布，右栏是编辑工具。
 * 之所以把编辑工具单独放到右边，是因为它和画布是同一件事的两半 ——
 * 选颜色、选工具、撤销，然后立刻在左边涂，视线不用横穿整个屏幕。
 */

type StageTab = 'pattern' | 'source'

const stageTab = ref<StageTab>('pattern')
const picking = ref(false)
const hoverCell = ref<{ row: number; col: number } | null>(null)
const sideCollapsed = ref(false)
const canvasRef = ref<InstanceType<typeof PatternCanvas> | null>(null)
const sourceRef = ref<InstanceType<typeof SourceCanvas> | null>(null)

const MODES: { value: GridMode; label: string; hint: string }[] = [
  { value: 'color', label: '彩色', hint: '带颜色和色号，屏幕上对照用' },
  { value: 'symbol', label: '符号', hint: '白底黑符号，黑白打印机也能看清' },
  { value: 'outline', label: '线稿', hint: '只有网格线，自己往格子里填色' },
]

const busy = computed(() => state.busy !== 'idle')
const empty = computed(() => !hasImage.value && !pattern.value)

const boards = computed(() =>
  pattern.value ? boardsNeeded(state.rows, state.cols, state.boardSize) : null,
)

// ---------------------------------------------------------------------------
// 打开文件
// ---------------------------------------------------------------------------

async function acceptFile(file: File): Promise<void> {
  picking.value = false
  stageTab.value = 'source'
  await openImageFile(file)
  if (pattern.value) stageTab.value = 'pattern'
}

// ---------------------------------------------------------------------------
// 拖放
// ---------------------------------------------------------------------------

const dropDepth = ref(0)
const dropping = computed(() => dropDepth.value > 0)

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  dropDepth.value++
}

function onDragOver(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(): void {
  dropDepth.value = Math.max(0, dropDepth.value - 1)
}

function onDrop(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  dropDepth.value = 0
  const file = e.dataTransfer?.files?.[0]
  if (file) void acceptFile(file)
}

// ---------------------------------------------------------------------------
// 吸管
// ---------------------------------------------------------------------------

function startPicking(): void {
  picking.value = true
  stageTab.value = 'source'
}

function stopPicking(): void {
  picking.value = false
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()

  if (mod && key === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if (mod && key === 'y') {
    e.preventDefault()
    redo()
    return
  }
  if (mod || e.altKey) return
  if (isTypingTarget(e.target)) return

  switch (key) {
    case 'b':
      tool.value = 'brush'
      break
    case 'g':
      tool.value = 'fill'
      break
    case 'e':
      tool.value = 'erase'
      break
    case 'escape':
      picking.value = false
      break
    default:
      return
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <div
    class="app"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <header class="app-header">
      <div class="brand">
        拼豆图纸
        <span class="brand-sub">上传图片，自动转成可照摆的图纸</span>
      </div>

      <span class="header-spacer" />

      <div v-if="state.fileName || pattern" class="file-chip" :title="state.fileName || state.title">
        <span class="file-chip-name">
          {{ state.fileName || state.title || '未命名图纸' }}
        </span>
        <span v-if="state.originalWidth" class="file-chip-meta">
          {{ state.originalWidth }}×{{ state.originalHeight }}
        </span>
      </div>

      <div class="header-group">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="!canUndo"
          :title="canUndo ? `撤销「${undoLabel}」(Ctrl+Z)` : '没有可撤销的操作'"
          @click="undo"
        >
          ↶
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="!canRedo"
          :title="canRedo ? `重做「${redoLabel}」(Ctrl+Shift+Z)` : '没有可重做的操作'"
          @click="redo"
        >
          ↷
        </button>
      </div>

      <div class="header-divider" />

      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :title="sideCollapsed ? '展开右侧工具面板' : '收起右侧工具面板'"
        @click="sideCollapsed = !sideCollapsed"
      >
        {{ sideCollapsed ? '◀' : '▶' }}
      </button>
    </header>

    <div class="app-body" :class="{ 'side-collapsed': sideCollapsed }">
      <!-- 左栏：从原图到参数 -->
      <aside class="panel panel-left">
        <div v-if="busy" class="progress">
          <div
            class="progress-fill"
            :class="{ 'progress-indeterminate': state.progress <= 0 }"
            :style="state.progress > 0 ? { width: `${Math.round(state.progress * 100)}%` } : {}"
          />
        </div>

        <div class="panel-scroll">
          <p v-if="state.error" class="banner banner-danger" style="margin: 12px 16px 0">
            {{ state.error }}
            <button
              type="button"
              class="banner-close"
              title="关闭"
              @click="state.error = null"
            >
              ×
            </button>
          </p>

          <AccountPanel />
          <SourcePanel :picking="picking" @pick="startPicking" @file="acceptFile" />
          <SizePanel v-if="pattern" />
          <PalettePanel />
          <StatsPanel />
          <ExportPanel />
        </div>
      </aside>

      <!-- 中间：画布 -->
      <main class="stage">
        <div class="stage-bar">
          <div class="seg">
            <button
              type="button"
              class="seg-item"
              :class="{ active: stageTab === 'pattern' }"
              :disabled="!pattern"
              @click="stageTab = 'pattern'"
            >
              图纸
            </button>
            <button
              type="button"
              class="seg-item"
              :class="{ active: stageTab === 'source' }"
              :disabled="!hasImage"
              @click="stageTab = 'source'"
            >
              原图
            </button>
          </div>

          <div class="header-divider" />

          <div class="seg">
            <button
              v-for="m in MODES"
              :key="m.value"
              type="button"
              class="seg-item"
              :class="{ active: view.mode === m.value }"
              :title="m.hint"
              @click="view.mode = m.value"
            >
              {{ m.label }}
            </button>
          </div>

          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: view.showGrid }"
            title="显示/隐藏网格线"
            @click="view.showGrid = !view.showGrid"
          >
            网格
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: view.showRuler }"
            title="显示/隐藏行列标尺"
            @click="view.showRuler = !view.showRuler"
          >
            标尺
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: view.showCode }"
            title="显示/隐藏格子里的色号"
            @click="view.showCode = !view.showCode"
          >
            色号
          </button>

          <span class="header-spacer" />

          <span v-if="boards" class="field-value" style="margin-right: 6px">
            {{ state.cols }}×{{ state.rows }} 格 · {{ boards.total }} 块底板
          </span>

          <template v-if="stageTab === 'pattern' && pattern">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              title="缩小"
              @click="canvasRef?.zoomCenter(1 / 1.25)"
            >
              −
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              title="放大"
              @click="canvasRef?.zoomCenter(1.25)"
            >
              ＋
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              title="缩放到刚好铺满"
              @click="canvasRef?.fit()"
            >
              适应
            </button>
          </template>

          <template v-else-if="stageTab === 'source' && hasImage">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              @click="sourceRef?.resetView()"
            >
              适应
            </button>
          </template>
        </div>

        <div class="stage-canvas">
          <div v-if="empty" class="stage-empty">
            <h2>把图片拖进来，或者</h2>
            <p>
              选一张图，工具会自动把它拆成一颗一颗的色块，匹配到真实能买到的色号上，
              并算出每种颜色要买多少颗。<br />
              卡通、像素画、线稿、图标效果最好；照片也能转，但建议先裁剪出主体、
              调亮一点再转。
            </p>
          </div>

          <SourceCanvas
            v-else-if="stageTab === 'source' && hasImage"
            ref="sourceRef"
            :picking="picking"
            @picked="stopPicking"
          />

          <PatternCanvas
            v-else-if="pattern"
            ref="canvasRef"
            :mode="view.mode"
            :show-ruler="view.showRuler"
            :show-grid="view.showGrid"
            :show-code="view.showCode"
            :major-every="view.majorEvery"
            @hover="hoverCell = $event"
          />

          <div v-else class="stage-empty">
            <h2>正在生成图纸…</h2>
            <p>首次生成需要一两秒，之后调整参数都会很快。</p>
          </div>
        </div>
      </main>

      <!-- 右栏：编辑工具 -->
      <aside class="panel panel-right">
        <EditPanel
          :hover="hoverCell"
          @fit="canvasRef?.fit()"
          @zoom="(f) => canvasRef?.zoomCenter(f)"
        />
      </aside>
    </div>

    <div v-if="dropping" class="drop-veil">
      <div class="drop-card">松手即可载入图片</div>
    </div>
  </div>
</template>
