<script setup lang="ts">
import { computed } from 'vue'

import type { BeadSize } from '@/core/palette'
import { MAX_CELLS, MIN_CELLS, boardsNeeded, formatPhysical } from '@/core/pattern'
import {
  regenerateNow,
  setBeadSize,
  setBoardSize,
  setCells,
  setLockAspect,
  snapSizeToBoard,
  state,
} from '@/stores/project'
import SectionCard from './SectionCard.vue'

/**
 * 尺寸面板。
 *
 * 这里要回答用户唯一真正关心的问题：**成品多大、要几块底板、会不会不够摆**。
 * 所以行列数旁边永远跟着厘米数和底板数，改一个数字就能立刻看到后果。
 */

const BEAD_SIZES: { value: BeadSize; label: string; hint: string }[] = [
  { value: 2.6, label: '2.6mm', hint: '迷你豆' },
  { value: 5, label: '5mm', hint: '中豆 · 最常用' },
  { value: 10, label: '10mm', hint: '大豆 · 儿童用' },
]

const physicalW = computed(() => formatPhysical(state.cols, state.beadSizeMm))
const physicalH = computed(() => formatPhysical(state.rows, state.beadSizeMm))

const boards = computed(() => boardsNeeded(state.rows, state.cols, state.boardSize))

/** 离"刚好铺满整数块底板"还差几格，提示用户要不要对齐 */
const snapGap = computed(() => {
  const c = state.cols % state.boardSize
  const r = state.rows % state.boardSize
  return c === 0 && r === 0 ? null : { cols: c === 0 ? 0 : state.boardSize - c, rows: r === 0 ? 0 : state.boardSize - r }
})

const boardOptions = [14, 29]

function onCells(driver: 'rows' | 'cols', e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v)) return
  setCells(driver, v)
}

function onBoardSize(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v)) return
  setBoardSize(v)
}

function doSnap(): void {
  snapSizeToBoard()
  // 对齐会改动格数，等防抖就慢了，立刻重算
  regenerateNow()
}
</script>

<template>
  <SectionCard title="尺寸" :open="true" :badge="`${state.cols} × ${state.rows}`">
    <div class="field">
      <div class="field-label"><span>豆子规格</span></div>
      <div class="seg">
        <button
          v-for="opt in BEAD_SIZES"
          :key="opt.value"
          type="button"
          class="seg-item"
          :class="{ active: state.beadSizeMm === opt.value }"
          :title="opt.hint"
          @click="setBeadSize(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
      <p class="field-hint">
        {{ BEAD_SIZES.find((b) => b.value === state.beadSizeMm)?.hint }}。
        规格只影响成品物理尺寸与用量计算，图纸本身不变。
      </p>
    </div>

    <div class="field">
      <div class="field-label">
        <span>格数</span>
        <label class="row" style="gap: 6px">
          <input
            type="checkbox"
            :checked="state.lockAspect"
            @change="setLockAspect(($event.target as HTMLInputElement).checked)"
          />
          <span style="font-size: 11.5px">锁定比例</span>
        </label>
      </div>

      <div class="input-row">
        <label class="field-hint" style="width: 28px">宽</label>
        <input
          class="input input-num"
          type="number"
          :min="MIN_CELLS"
          :max="MAX_CELLS"
          :value="state.cols"
          @change="onCells('cols', $event)"
        />
        <span class="field-hint">格</span>
        <span class="header-spacer" />
        <span class="field-value">{{ physicalW }}</span>
      </div>

      <div class="input-row">
        <label class="field-hint" style="width: 28px">高</label>
        <input
          class="input input-num"
          type="number"
          :min="MIN_CELLS"
          :max="MAX_CELLS"
          :value="state.rows"
          @change="onCells('rows', $event)"
        />
        <span class="field-hint">格</span>
        <span class="header-spacer" />
        <span class="field-value">{{ physicalH }}</span>
      </div>

      <p class="field-hint">
        单边最多 {{ MAX_CELLS }} 格。改宽或高时另一边的比例会自动保持
        —— 否则图纸会被拉变形，人也看不出来。
      </p>
    </div>

    <div class="field">
      <div class="field-label">
        <span>底板</span>
        <span class="field-value">{{ boards.across }} × {{ boards.down }} = {{ boards.total }} 块</span>
      </div>
      <div class="input-row">
        <div class="seg">
          <button
            v-for="size in boardOptions"
            :key="size"
            type="button"
            class="seg-item"
            :class="{ active: state.boardSize === size }"
            @click="setBoardSize(size)"
          >
            {{ size }}×{{ size }}
          </button>
        </div>
        <input
          class="input input-num"
          type="number"
          min="2"
          max="100"
          :value="state.boardSize"
          @change="onBoardSize"
        />
      </div>
      <button type="button" class="btn btn-sm" :disabled="!snapGap" @click="doSnap">
        {{ snapGap ? `对齐到整块底板（宽 +${snapGap.cols} 格 / 高 +${snapGap.rows} 格）` : '已是整块底板' }}
      </button>
      <p class="field-hint">
        拼多块底板时，格数不是底板边长的整数倍会很难拼 —— 边缘那一条要跨板摆。
        对齐按向上取整，多出来的是空白边，原有内容不会被裁掉。
      </p>
    </div>
  </SectionCard>
</template>
