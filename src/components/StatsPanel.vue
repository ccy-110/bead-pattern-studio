<script setup lang="ts">
import { computed } from 'vue'

import { colorLabel, displayName } from '@/core/palette'
import { boardsNeeded, symbolFor } from '@/core/pattern'
import { brushColorId, setPurchase, stats, state } from '@/stores/project'
import SectionCard from './SectionCard.vue'

/**
 * 用量统计。
 *
 * 这张表是用户真正会带去下单的东西 —— 图纸本身只是过程，
 * "买多少颗豆"才是结果。所以「备货」列默认已经含了损耗余量，
 * 而不是让用户自己心算 8%。
 */

const boards = computed(() =>
  boardsNeeded(state.rows, state.cols, state.boardSize),
)

const topColor = computed(() => stats.value?.colors[0] ?? null)

function pickAsBrush(colorId: string): void {
  brushColorId.value = brushColorId.value === colorId ? null : colorId
}

const wastePercent = computed(() => Math.round(state.purchase.wasteRatio * 100))

function onWaste(e: Event): void {
  const pct = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(pct)) return
  setPurchase({ wasteRatio: Math.max(0, Math.min(100, pct)) / 100 })
}

function onPackSize(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v)) return
  setPurchase({ beadsPerPack: Math.max(1, Math.round(v)) })
}
</script>

<template>
  <SectionCard
    title="用量"
    :open="true"
    :badge="stats ? `${stats.totalBeads} 颗 · ${stats.colorCount} 色` : '尚未生成'"
  >
    <template v-if="stats">
      <div class="stat-table">
        <table>
          <thead>
            <tr>
              <th>色号</th>
              <th class="num">颗数</th>
              <th class="num">备货</th>
              <th class="num">包</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in stats.colors"
              :key="row.color.id"
              :class="{ picked: brushColorId === row.color.id }"
              :title="
                brushColorId === row.color.id
                  ? `再点一次取消画笔 · ${colorLabel(row.color)}`
                  : `点击设为画笔颜色 · ${colorLabel(row.color)}`
              "
              @click="pickAsBrush(row.color.id)"
            >
              <td>
                <span class="stat-color">
                  <span class="stat-swatch" :style="{ background: row.color.hex }" />
                  <span class="stat-symbol">{{ symbolFor(row.colorIndex) }}</span>
                  <span class="stat-code">{{ row.color.code }}</span>
                  <!-- 没有颜色名的品牌（MARD、COCO…）不重复渲染色号 -->
                  <span v-if="displayName(row.color)" class="stat-name">
                    {{ displayName(row.color) }}
                  </span>
                </span>
              </td>
              <td class="num">{{ row.count }}</td>
              <td class="num">{{ row.purchase }}</td>
              <td class="num">{{ row.packs }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="field">
        <div class="field-label">
          <span>损耗余量</span>
          <span class="field-value">{{ wastePercent }}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="40"
          step="1"
          :value="wastePercent"
          @input="onWaste"
        />
      </div>

      <div class="field">
        <div class="field-label"><span>每包颗数</span></div>
        <input
          class="input input-num"
          type="number"
          min="1"
          :value="state.purchase.beadsPerPack"
          @change="onPackSize"
        />
        <p class="field-hint">
          散装按包卖时用它折算要买几包。熨烫失败、掉粒、同批次色差补色都会消耗豆子，
          留一点余量比拼到一半发现缺色再等快递好。
        </p>
      </div>

      <div class="stat-table">
        <table>
          <tbody>
            <tr>
              <td>成品尺寸</td>
              <td class="num">
                {{ (stats.widthMm / 10).toFixed(1) }} × {{ (stats.heightMm / 10).toFixed(1) }} 厘米
              </td>
            </tr>
            <tr>
              <td>底板</td>
              <td class="num">
                {{ boards.across }} × {{ boards.down }} = {{ boards.total }} 块
              </td>
            </tr>
            <tr>
              <td>占格率</td>
              <td class="num">{{ Math.round(stats.fillRatio * 100) }}%</td>
            </tr>
            <tr v-if="topColor">
              <td>用得最多</td>
              <td class="num">
                {{ colorLabel(topColor.color) }} · {{ topColor.count }} 颗
              </td>
            </tr>
            <tr v-if="stats.emptyCells > 0">
              <td>空格（不摆豆）</td>
              <td class="num">{{ stats.emptyCells }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="field-hint">
        点表格里的任意一行可以把它设为画笔颜色，再到图纸上涂抹修改。
      </p>
    </template>

    <p v-else class="empty-note">生成图纸后这里会列出每种颜色要买多少颗。</p>
  </SectionCard>
</template>
