<script setup lang="ts">
import { computed, ref } from 'vue'

import { toHex } from '@/core/palette'
import {
  hasImage,
  previewAdjustments,
  commitAdjustments,
  resetAdjustments,
  resetCrop,
  setBackground,
  setBackgroundReference,
  previewBackgroundTolerance,
  commitBackground,
  state,
} from '@/stores/project'
import RangeField from './RangeField.vue'
import SectionCard from './SectionCard.vue'

/**
 * 源图面板：上传、影调、抠图、裁剪。
 *
 * 这三项放在同一个面板里，是因为它们是**同一条流水线上的先后步骤**：
 * 先调干净影调 → 再把背景抠掉 → 最后框定要转换的区域。
 * 顺序颠倒会出问题（先抠图后调亮度会让已抠掉的区域重新泛白），
 * 面板里的排列顺序就是建议的操作顺序。
 */

defineProps<{ picking: boolean }>()
const emit = defineEmits<{
  (e: 'pick'): void
  (e: 'file', file: File): void
}>()

const fileRef = ref<HTMLInputElement | null>(null)

const adjustActive = computed(
  () =>
    state.adjustments.brightness !== 0 ||
    state.adjustments.contrast !== 0 ||
    state.adjustments.saturation !== 0,
)

const detectedHex = computed(() =>
  state.detectedReference ? toHex(state.detectedReference) : null,
)

const manualHex = computed(() => (state.bgReference ? toHex(state.bgReference) : null))

/** 自动推断的可信度描述。低可信度时提示用户手动指定，比让算法瞎猜好。 */
const confidenceText = computed(() => {
  const c = state.detectedConfidence
  if (c <= 0) return ''
  if (c >= 0.75) return '自动识别可靠'
  if (c >= 0.45) return '自动识别把握一般，效果不对就点吸管手动指定'
  return '自动识别把握不大，建议用吸管指定背景色'
})

function pickFile(): void {
  fileRef.value?.click()
}

function onFile(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) emit('file', file)
  // 清空以便连续选择同一个文件也能触发 change
  input.value = ''
}
</script>

<template>
  <div>
    <SectionCard title="原图" :open="true" :badge="state.fileName ? '' : '未选择'">
      <input
        ref="fileRef"
        type="file"
        accept="image/*"
        class="sr-only"
        @change="onFile"
      />
      <button type="button" class="btn btn-block" @click="pickFile">
        {{ hasImage ? '更换图片' : '选择图片' }}
      </button>
      <p v-if="hasImage" class="field-hint">
        也可直接把图片拖进中间区域。支持 JPG / PNG / WebP / GIF，GIF 取第一帧。
      </p>
    </SectionCard>

    <SectionCard
      v-if="hasImage"
      title="影调"
      :open="true"
      :badge="adjustActive ? '已调整' : '原始'"
    >
      <p class="field-hint">
        照片往往偏暗或发灰，先在把图调干净，转出来的图纸会规整很多。
      </p>

      <RangeField
        label="亮度"
        :model-value="state.adjustments.brightness"
        :min="-100"
        :max="100"
        @input="(v) => previewAdjustments({ brightness: v })"
        @commit="() => commitAdjustments('调整亮度')"
      />
      <RangeField
        label="对比度"
        :model-value="state.adjustments.contrast"
        :min="-100"
        :max="100"
        @input="(v) => previewAdjustments({ contrast: v })"
        @commit="() => commitAdjustments('调整对比度')"
      />
      <RangeField
        label="饱和度"
        :model-value="state.adjustments.saturation"
        :min="-100"
        :max="100"
        @input="(v) => previewAdjustments({ saturation: v })"
        @commit="() => commitAdjustments('调整饱和度')"
      />

      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="!adjustActive"
        @click="resetAdjustments"
      >
        重置影调
      </button>
    </SectionCard>

    <SectionCard
      v-if="hasImage"
      title="背景"
      :badge="state.bgEnabled ? '已开启' : '关闭'"
    >
      <label class="switch">
        <input
          type="checkbox"
          :checked="state.bgEnabled"
          @change="setBackground(($event.target as HTMLInputElement).checked)"
        />
        <span class="switch-track"><span class="switch-thumb" /></span>
        <span class="switch-label">抠掉背景</span>
      </label>

      <template v-if="state.bgEnabled">
        <div class="row-between">
          <span class="field-hint">
            背景色
            <span v-if="manualHex" class="muted">（手动指定）</span>
            <span v-else-if="detectedHex" class="muted">（自动识别）</span>
          </span>
          <span
            v-if="manualHex || detectedHex"
            class="stat-swatch"
            :style="{ background: manualHex ?? detectedHex ?? '#fff' }"
          />
        </div>

        <div class="row">
          <button
            type="button"
            class="btn btn-sm"
            :class="{ active: picking }"
            @click="emit('pick')"
          >
            {{ picking ? '点击图中背景…' : '吸管指定' }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="!state.bgReference"
            @click="setBackgroundReference(null)"
          >
            恢复自动
          </button>
        </div>

        <RangeField
          label="容差"
          :model-value="state.bgTolerance"
          :min="0"
          :max="255"
          @input="previewBackgroundTolerance"
          @commit="() => commitBackground()"
        />
        <p class="field-hint">
          容差越大，和背景越接近的颜色也会一起被抠掉。调太大可能连主体边缘都吃掉，
          调太小则背景会残留一圈。看中间的预览来定，抠干净为准。
        </p>

        <p v-if="!state.bgReference && confidenceText" class="field-hint">
          {{ confidenceText }}
        </p>
      </template>
    </SectionCard>

    <SectionCard v-if="hasImage" title="裁剪">
      <p class="field-hint">
        同一张图里如果有多个主体，或者边缘有多余的东西，框出要转换的部分即可。
        框选后行列数会按新比例自动重算。
      </p>
      <div class="row-between">
        <span class="field-hint">
          {{ state.crop ? `已框选 ${state.crop.width} × ${state.crop.height} 像素` : '当前使用整张图' }}
        </span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="!state.crop"
          @click="resetCrop"
        >
          还原整图
        </button>
      </div>
    </SectionCard>
  </div>
</template>
