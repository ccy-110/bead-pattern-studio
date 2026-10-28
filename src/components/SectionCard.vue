<script setup lang="ts">
import { ref } from 'vue'

/**
 * 可折叠分区。
 *
 * 左侧面板有六七个分区，全部展开会很长，用户每次都要滚半天才能找到
 * 自己要改的那一项。折叠让"当前在调什么"这件事靠折叠状态就能看出来，
 * 也省得滚动。默认展开前两个 —— 那两步是必经流程。
 */

const props = withDefaults(
  defineProps<{
    title: string
    /** 标题右侧的摘要文字，折叠时也能看到关键信息 */
    badge?: string
    /** 初始是否展开 */
    open?: boolean
    /** 强制禁用折叠（内容很少时没必要折叠） */
    fixed?: boolean
  }>(),
  { badge: '', open: false, fixed: false },
)

const expanded = ref(props.open || props.fixed)
</script>

<template>
  <section class="section">
    <button
      v-if="!fixed"
      type="button"
      class="section-head"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <svg
        class="section-caret"
        :class="{ open: expanded }"
        viewBox="0 0 12 12"
        aria-hidden="true"
      >
        <path
          d="M4 2.5 8 6l-4 3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="section-title">{{ title }}</span>
      <span v-if="badge" class="section-badge">{{ badge }}</span>
    </button>

    <div v-else class="section-head">
      <span class="section-title">{{ title }}</span>
      <span v-if="badge" class="section-badge">{{ badge }}</span>
    </div>

    <div v-show="expanded" class="section-body">
      <slot />
    </div>
  </section>
</template>
