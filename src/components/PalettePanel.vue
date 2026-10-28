<script setup lang="ts">
import { computed } from 'vue'

import { SAMPLE_MODE_LABEL } from '@/core/imaging'
import type { SampleMode } from '@/core/imaging'
import {
  COLOR_KIND_LABEL,
  PALETTES,
  SPECIAL_KINDS,
  colorLabel,
  groupByKind,
  indexPalette,
} from '@/core/palette'
import type { PaletteColor } from '@/core/palette'
import {
  activePalette,
  candidateColors,
  candidateCount,
  commitQuantize,
  previewQuantizeParams,
  setPalette,
  setQuantizeParams,
  state,
  toggleExcluded,
  toggleKind,
  setExcludedIds,
} from '@/stores/project'
import RangeField from './RangeField.vue'
import SectionCard from './SectionCard.vue'

/**
 * 配色面板 —— 这个工具最核心的一屏。
 *
 * 与常见做法最大的不同：**候选色是一个封闭集合**。
 * 量化器只会在这个集合里挑颜色，绝不会产出集合外的色号。
 * 所以用户取消勾选某个色号，成品里就一定不会有它 ——
 * 这对"我手里只有这 30 个色"的实际场景是决定性的，
 * 否则用户拿到图纸还得自己一个个替换。
 */

const kindCounts = computed(() => indexPalette(activePalette.value).kindCounts)

/** 面板里展示的颜色：只列已启用类别的。类别没启用就不该出现在选择器里。 */
const visibleGroups = computed(() =>
  groupByKind(
    activePalette.value.colors.filter((c) => state.activeKinds.includes(c.kind)),
  ),
)

const excludedSet = computed(() => new Set(state.excludedIds))

const SAMPLE_MODES: SampleMode[] = ['auto', 'mode', 'average', 'median']

function kindCount(kind: PaletteColor['kind']): number {
  return kindCounts.value.get(kind) ?? 0
}

/** 当前色卡里出现过的类别，按固定顺序排好 */
const availableKinds = computed(() => {
  const present = activePalette.value.colors.map((c) => c.kind)
  const order = ['solid', ...SPECIAL_KINDS] as const
  return order.filter((k) => present.includes(k))
})

function isExcluded(color: PaletteColor): boolean {
  return excludedSet.value.has(color.id)
}

function clearExclusions(): void {
  setExcludedIds([])
}

/** 把已启用类别下的颜色全部选上（清空排除项） */
function selectAllVisible(): void {
  const enabled = new Set(
    activePalette.value.colors
      .filter((c) => state.activeKinds.includes(c.kind))
      .map((c) => c.id),
  )
  setExcludedIds(state.excludedIds.filter((id) => !enabled.has(id)))
}

/** 没有颜色名的品牌（MARD、COCO…）不要显示成「A1 A1」 */
function swatchTitle(color: PaletteColor): string {
  const bits = [colorLabel(color), COLOR_KIND_LABEL[color.kind]]
  if (color.note) bits.push(color.note)
  if (color.discontinued) bits.push('已停产/难购买')
  bits.push(isExcluded(color) ? '点击恢复使用' : '点击标记为「我没有这个色」')
  return bits.join(' · ')
}

function onPaletteChange(event: Event): void {
  const target = event.target as HTMLSelectElement
  setPalette(target.value)
}
</script>

<template>
  <SectionCard
    title="配色"
    :open="true"
    :badge="`${candidateCount} 色可用`"
  >
    <div class="field">
      <div class="field-label"><span>色卡</span></div>
      <!--
        九张色卡用分段控件在 336px 侧栏里必然挤爆（号码长的品牌名要占很多字），
        原生 select 既不会破版，键盘和读屏也都直接可用。
      -->
      <select
        class="palette-select"
        :value="state.paletteId"
        :title="`数据版本 ${activePalette.version}`"
        @change="onPaletteChange"
      >
        <option v-for="p in PALETTES" :key="p.id" :value="p.id">
          {{ p.name }} · {{ p.colors.length }} 色
        </option>
      </select>
      <p class="field-hint">{{ activePalette.note }}</p>
      <p class="field-hint field-source">{{ activePalette.source }}</p>
    </div>

    <div class="field">
      <div class="field-label">
        <span>颜色类别</span>
        <span class="field-value">{{ candidateCount }} 色</span>
      </div>
      <div class="kind-row">
        <button
          v-for="kind in availableKinds"
          :key="kind"
          type="button"
          class="kind-chip"
          :class="{ on: state.activeKinds.includes(kind) }"
          @click="toggleKind(kind)"
        >
          {{ COLOR_KIND_LABEL[kind] }}
          <span class="kind-count">{{ kindCount(kind) }}</span>
        </button>
      </div>
      <p class="field-hint">
        默认只开纯色。金属、珠光、夜光这些特殊色手里通常没有，
        混进自动配色会让你拿着图纸买不到对应的豆子 —— 想用再手动勾上。
      </p>
    </div>

    <div class="field">
      <div class="field-label">
        <span>可用颜色</span>
        <span class="field-value">
          {{ candidateCount }} / {{ activePalette.colors.length }}
        </span>
      </div>

      <template v-if="visibleGroups.length > 0">
        <div v-for="group in visibleGroups" :key="group.kind" class="field">
          <div v-if="visibleGroups.length > 1" class="field-label">
            <span>{{ COLOR_KIND_LABEL[group.kind] }}</span>
            <span class="field-value">{{ group.colors.length }}</span>
          </div>
          <div class="color-grid">
            <button
              v-for="color in group.colors"
              :key="color.id"
              type="button"
              class="color-swatch"
              :class="{ excluded: isExcluded(color) }"
              :style="{ background: color.hex }"
              :title="swatchTitle(color)"
              :aria-pressed="!isExcluded(color)"
              @click="toggleExcluded(color.id)"
            />
          </div>
        </div>
      </template>
      <p v-else class="field-hint banner banner-warn">
        一个颜色类别都没启用，无法生成图纸。请至少勾选「纯色」。
      </p>

      <div class="row">
        <button type="button" class="btn btn-ghost btn-sm" @click="selectAllVisible">
          全部启用
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="state.excludedIds.length === 0"
          @click="clearExclusions"
        >
          清除排除（{{ state.excludedIds.length }}）
        </button>
      </div>
      <p class="field-hint">
        点色块可以标记「我没有这个色」，被排除的色不会出现在自动配色结果里。
        鼠标悬停能看到色号和名称。
      </p>
    </div>

    <div class="field">
      <div class="field-label">
        <span>取色方式</span>
      </div>
      <div class="seg seg-wrap">
        <button
          v-for="mode in SAMPLE_MODES"
          :key="mode"
          type="button"
          class="seg-item"
          :class="{ active: state.sampleMode === mode }"
          @click="setQuantizeParams({ sampleMode: mode })"
        >
          {{ SAMPLE_MODE_LABEL[mode].split('（')[0] }}
        </button>
      </div>
      <p class="field-hint">
        {{ SAMPLE_MODE_LABEL[state.sampleMode] }}。
        卡通和线稿用主色法边缘最干净；照片用平均值过渡更自然。
      </p>
    </div>

    <RangeField
      label="最多用色数"
      :model-value="state.maxColors"
      :min="2"
      :max="64"
      suffix=" 色"
      @input="(v) => previewQuantizeParams({ maxColors: v })"
      @commit="commitQuantize"
    />
    <p class="field-hint">
      限制的是最终图纸里最多出现多少种颜色。数量少省钱、拼装快、容易买到齐；
      数量多还原度高。20~30 色是多数图案的甜点区。
    </p>

    <RangeField
      label="过滤零散色块"
      :model-value="state.minBeads"
      :min="1"
      :max="60"
      suffix=" 颗"
      @input="(v) => previewQuantizeParams({ minBeads: v })"
      @commit="commitQuantize"
    />
    <p class="field-hint">
      少于这个颗数的颜色会被并到相邻颜色里。孤立的一两颗豆子既费钱又几乎看不见，
      但调太大会抹掉眼睛、高光这类关键小细节。
    </p>

    <p class="field-hint muted">
      候选色共 {{ candidateColors.length }} 个，全部来自「{{ activePalette.name }}」。
    </p>
  </SectionCard>
</template>
