<script setup lang="ts">
import { computed, ref } from 'vue'

import { COLOR_KIND_LABEL, colorLabel } from '@/core/palette'
import type { PatternColor } from '@/core/pattern'
import {
  brushColorId,
  candidateColors,
  canRedo,
  canUndo,
  redo,
  redoLabel,
  pattern,
  tool,
  undo,
  undoLabel,
} from '@/stores/project'
import type { EditTool } from '@/stores/project'

/**
 * 编辑面板。
 *
 * 放在画布右边而不是左边，是因为它和画布是**同一件事的两半**：
 * 选颜色、选工具、撤销，然后立刻在左边涂。放在左栏的话，
 * 每涂一笔都要把视线和鼠标在屏幕上横穿一次。
 */

const emit = defineEmits<{
  (e: 'zoom', factor: number): void
  (e: 'fit'): void
}>()

const props = defineProps<{ hover: { row: number; col: number } | null }>()

const showAll = ref(false)

const TOOLS: { value: EditTool; label: string; hint: string }[] = [
  { value: 'brush', label: '画笔', hint: '拖动涂抹，快捷键 B' },
  { value: 'fill', label: '填充', hint: '把相连的同色区域一次填满，快捷键 G' },
  { value: 'erase', label: '擦除', hint: '把格子清空（不摆豆），快捷键 E' },
]

/** 图纸里实际用到的颜色，排在前面 —— 改图时用得最多的就是它们 */
const usedColors = computed<{ color: PatternColor; index: number }[]>(() => {
  const p = pattern.value
  if (!p) return []
  const seen = new Set<number>()
  for (let i = 0; i < p.grid.length; i++) {
    const v = p.grid[i]!
    if (v >= 0) seen.add(v)
  }
  return [...seen]
    .sort((a, b) => a - b)
    .map((index) => ({ color: p.colors[index]!, index }))
})

/** 候选色里还没用到的，供手动补充 */
const otherColors = computed(() => {
  const p = pattern.value
  const used = new Set(p?.colors.map((c) => c.id) ?? [])
  return candidateColors.value.filter((c) => !used.has(c.id))
})

const hoverText = computed(() => {
  const cell = props.hover
  const p = pattern.value
  if (!cell || !p) return null
  const v = p.grid[cell.row * p.cols + cell.col]
  const color = v !== undefined && v >= 0 ? p.colors[v] : null
  return {
    pos: `第 ${cell.row + 1} 行 · 第 ${cell.col + 1} 列`,
    color: color ? colorLabel(color) : '空格（不摆豆）',
    hex: color?.hex ?? null,
  }
})
</script>

<template>
  <div class="panel-scroll">
    <div class="section">
      <div class="section-head">
        <span class="section-title">编辑</span>
        <span class="section-badge">{{ pattern ? `${pattern.cols}×${pattern.rows}` : '—' }}</span>
      </div>
      <div class="section-body">
        <div class="seg">
          <button
            v-for="t in TOOLS"
            :key="t.value"
            type="button"
            class="seg-item"
            :class="{ active: tool === t.value }"
            :title="t.hint"
            :disabled="!pattern"
            @click="tool = t.value"
          >
            {{ t.label }}
          </button>
        </div>

        <div class="row">
          <button
            type="button"
            class="btn btn-sm"
            style="flex: 1"
            :disabled="!canUndo"
            :title="canUndo ? `撤销「${undoLabel}」` : '没有可撤销的操作'"
            @click="undo"
          >
            ↶ 撤销
          </button>
          <button
            type="button"
            class="btn btn-sm"
            style="flex: 1"
            :disabled="!canRedo"
            :title="canRedo ? `重做「${redoLabel}」` : '没有可重做的操作'"
            @click="redo"
          >
            ↷ 重做
          </button>
        </div>
        <p class="field-hint">
          连续涂抹算一步，撤销是按「一笔」退的，不是按格子。
          调滑块也只在松手时记一步。
        </p>

        <div class="row">
          <button type="button" class="btn btn-sm" style="flex: 1" @click="emit('zoom', 1.25)">
            放大
          </button>
          <button type="button" class="btn btn-sm" style="flex: 1" @click="emit('zoom', 0.8)">
            缩小
          </button>
          <button type="button" class="btn btn-sm" @click="emit('fit')">适应</button>
        </div>

        <p v-if="hoverText" class="field-hint">
          {{ hoverText.pos }}<br />
          <span class="row" style="gap: 6px">
            <span
              v-if="hoverText.hex"
              class="stat-swatch"
              :style="{ background: hoverText.hex }"
            />
            {{ hoverText.color }}
          </span>
        </p>
        <p v-else class="field-hint">把鼠标移到图纸上，这里会显示格子的位置和颜色。</p>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <span class="section-title">画笔颜色</span>
        <button
          v-if="brushColorId"
          type="button"
          class="btn btn-ghost btn-sm"
          @click="brushColorId = null"
        >
          取消
        </button>
      </div>
      <div class="section-body">
        <template v-if="usedColors.length > 0">
          <div class="field-label"><span>图纸里用到的</span></div>
          <div class="color-grid">
            <button
              v-for="entry in usedColors"
              :key="entry.color.id"
              type="button"
              class="color-swatch"
              :class="{ selected: brushColorId === entry.color.id }"
              :style="{ background: entry.color.hex }"
              :title="colorLabel(entry.color)"
              @click="brushColorId = entry.color.id"
            />
          </div>
        </template>

        <template v-if="pattern">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            @click="showAll = !showAll"
          >
            {{ showAll ? '收起全部可用色' : `从全部可用色里选（${otherColors.length}）` }}
          </button>

          <div v-if="showAll" class="color-grid">
            <button
              v-for="color in otherColors"
              :key="color.id"
              type="button"
              class="color-swatch"
              :class="{ selected: brushColorId === color.id }"
              :style="{ background: color.hex }"
              :title="`${colorLabel(color)} · ${COLOR_KIND_LABEL[color.kind]}`"
              @click="brushColorId = color.id"
            />
          </div>
          <p v-if="showAll" class="field-hint">
            这里只列「配色」面板里已启用的颜色。手动涂上去的颜色不计入自动配色，
            但会照常出现在用量表里。
          </p>
        </template>

        <p v-else class="empty-note">生成图纸后即可在图上涂抹修改。</p>
      </div>
    </div>
  </div>
</template>
