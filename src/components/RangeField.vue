<script setup lang="ts">
/**
 * 带数值显示的滑块。
 *
 * `input` 事件是拖动中的每一帧，`change` 是松手那一下。
 * 之所以把两者分开往外抛，是因为调用方需要区别对待：
 * 拖动中只重画预览（便宜、够看），松手才跑完整量化并记一个还原点。
 * 混在一起的话，拖一次滑块要跑几十遍完整量化，界面会卡住。
 */
const props = withDefaults(
  defineProps<{
    label: string
    modelValue: number
    min: number
    max: number
    step?: number
    /** 显示在后缀，如 'px' 或 '%' */
    suffix?: string
    /** 数值显示前的换算，默认原样显示 */
    format?: (v: number) => string
    disabled?: boolean
  }>(),
  { step: 1, suffix: '', disabled: false, format: undefined },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void
  (e: 'input', value: number): void
  (e: 'commit', value: number): void
}>()

function onInput(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  emit('update:modelValue', v)
  emit('input', v)
}

function onCommit(e: Event): void {
  emit('commit', Number((e.target as HTMLInputElement).value))
}

function display(): string {
  if (props.format) return props.format(props.modelValue)
  const sign = props.modelValue > 0 ? '+' : ''
  return `${sign}${props.modelValue}${props.suffix}`
}
</script>

<template>
  <div class="field">
    <div class="field-label">
      <span>{{ label }}</span>
      <span class="field-value">{{ display() }}</span>
    </div>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      @input="onInput"
      @change="onCommit"
    />
  </div>
</template>
