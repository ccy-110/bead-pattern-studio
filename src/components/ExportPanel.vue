<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  canvasToBlob,
  downloadBlob,
  downloadText,
  pagesPerSheet,
  paginatePattern,
  patternToPdf,
  patternToSvg,
  printPattern,
  renderToCanvas,
} from '@/core/export'
import { makeProjectFile } from '@/core/export/project-file'
import { estimatePdfPages } from '@/core/export/pdf/pattern'
import { suggestFileName } from '@/core/pattern'
import {
  activePalette,
  generationParams,
  loadPatternFile,
  pattern,
  setTitle,
  state,
  stats,
} from '@/stores/project'
import { PDF_LAYOUT_OPTIONS, PRINT_SCALE_OPTIONS, view } from '@/stores/view'
import SectionCard from './SectionCard.vue'

/**
 * 输出面板。
 *
 * 图纸做出来只是半成品 —— 用户要么拿它去下单买豆子，要么打印出来照着摆，
 * 要么存下来下次接着改。这三条路各对应一种导出格式，缺一条这个工具就不完整：
 *
 * - **PNG** 发朋友圈、发群里问人。
 * - **SVG / 打印** 真正照着摆的时候用，放大不糊、按实物尺寸出图。
 * - **JSON** 自己的工程文件，能再打开继续改。
 */

const busy = ref(false)
const notice = ref<string | null>(null)

const canExport = computed(() => pattern.value !== null)

function flash(message: string): void {
  notice.value = message
  setTimeout(() => {
    if (notice.value === message) notice.value = null
  }, 3200)
}

async function exportPng(): Promise<void> {
  const p = pattern.value
  if (!p || busy.value) return
  busy.value = true
  try {
    const canvas = renderToCanvas(p, {
      mode: view.mode,
      showRuler: view.showRuler,
      majorEvery: view.showGrid ? view.majorEvery : 0,
      showCode: view.showCode,
      targetWidth: view.exportWidth,
    })
    downloadBlob(await canvasToBlob(canvas), suggestFileName(p, 'png'))
    flash('PNG 已导出')
  } catch (err) {
    flash(err instanceof Error ? err.message : '导出失败')
  } finally {
    busy.value = false
  }
}

/**
 * 导出 PDF。
 *
 * 与 PNG 一样是重活（要把字体和整张图的绘制指令写出来），所以走 busy 状态；
 * 有错误就提示，不能像保存工程那样让异常静默逃逸。
 */
async function exportPdf(): Promise<void> {
  const p = pattern.value
  if (!p || busy.value) return
  busy.value = true
  try {
    const bytes = await patternToPdf(p, {
      layout: view.pdfLayout,
      beadSizeMm: p.beadSizeMm,
      printScale: view.printScale,
      showRuler: view.showRuler,
      majorEvery: view.showGrid ? view.majorEvery : 0,
      title: p.title,
      paletteName: activePalette.value.name,
      boardSize: state.boardSize,
      stats: stats.value,
    })
    // 二进制必须直接给 Blob：downloadText 会往 mime 后面拼 charset，
    // 那样下载下来的 PDF 声明就成了 application/pdf;charset=utf-8
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), suggestFileName(p, 'pdf'))
    flash('PDF 已导出')
  } catch (err) {
    flash(err instanceof Error ? err.message : '导出 PDF 失败')
  } finally {
    busy.value = false
  }
}

const pdfLayoutHint = computed(() => {
  const opt = PDF_LAYOUT_OPTIONS.find((o) => o.value === view.pdfLayout)
  const p = pattern.value
  const pages =
    p === null
      ? ''
      : `　当前这张会出 ${estimatePdfPages(p, {
          layout: view.pdfLayout,
          beadSizeMm: p.beadSizeMm,
          printScale: view.printScale,
          showRuler: view.showRuler,
        })} 页。`
  return `${opt?.hint ?? ''}${pages}`
})

function onPdfLayoutChange(event: Event): void {
  view.pdfLayout = (event.target as HTMLSelectElement).value as 'paged' | 'single'
}

function exportSvg(): void {
  const p = pattern.value
  if (!p) return
  try {
    const svg = patternToSvg(p, {
      mode: view.mode,
      showRuler: view.showRuler,
      majorEvery: view.showGrid ? view.majorEvery : 0,
      showCode: view.showCode,
      cellSize: 24,
      printScale: view.printScale,
    })
    downloadText(svg, suggestFileName(p, 'svg'), 'image/svg+xml')
    // 放得下才能说"按实际尺寸输出"。放不下时浏览器会把它缩到纸宽，
    // 尺寸就不准了 —— 这时候该走「打印」，那边会分页并保持真实尺寸。
    flash(
      pageInfo.value && pageInfo.value.total > 1
        ? `SVG 已导出；这张图纸有 ${pageInfo.value.total} 页，要按实物尺寸打印请用「打印」`
        : 'SVG 已导出，打印时按实际尺寸输出',
    )
  } catch (err) {
    flash(err instanceof Error ? err.message : '导出失败')
  }
}

function doPrint(): void {
  const p = pattern.value
  if (!p) return
  const opened = printPattern(p, {
    mode: view.mode,
    showRuler: view.showRuler,
    majorEvery: view.showGrid ? view.majorEvery : 0,
    showCode: view.showCode,
    cellSize: 24,
    printScale: view.printScale,
    stats: stats.value,
    boardSize: state.boardSize,
    paginate: view.paginate,
  })
  if (!opened) {
    flash('打印窗口被浏览器拦截了，请允许本站弹出窗口后重试')
  }
}

/**
 * 按当前倍率算一张 A4 能放几格、这张图纸要几页。
 *
 * 把这个数摆到界面上而不是让用户自己猜，是因为"印出来尺寸不对"
 * 在点打印之前完全看不出来 —— 而图纸尺寸错了整张就废了。
 */
const pageInfo = computed(() => {
  const p = pattern.value
  if (!p) return null
  const per = pagesPerSheet({
    beadSizeMm: p.beadSizeMm,
    printScale: view.printScale,
    showRuler: view.showRuler,
  })
  const pages = paginatePattern(p.rows, p.cols, per.rowsPerPage, per.colsPerPage)
  return {
    total: pages.length,
    rowsPerPage: per.rowsPerPage,
    colsPerPage: per.colsPerPage,
  }
})

async function saveJson(): Promise<void> {
  const p = pattern.value
  if (!p || busy.value) return
  busy.value = true
  try {
    // 与云端保存共用同一条生成路径，避免两边产出的文件不一样
    const { text } = makeProjectFile(p, generationParams())
    downloadText(text, suggestFileName(p, 'json'), 'application/json')
    flash('图纸文件已保存，之后可以再打开继续修改')
  } catch (err) {
    // 以前这里只有 finally：导出异常会变成未处理的 rejection，界面上毫无反馈
    flash(err instanceof Error ? err.message : '保存失败')
  } finally {
    busy.value = false
  }
}

const openRef = ref<HTMLInputElement | null>(null)

async function onOpenFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  try {
    loadPatternFile(await file.text())
    // loadPatternFile 自己吞掉了错误并写进 state.error，这里按结果给反馈
    flash(state.error ? state.error : `已打开「${file.name}」`)
  } catch (err) {
    flash(err instanceof Error ? err.message : '读取文件失败')
  }
}
</script>

<template>
  <SectionCard title="输出" :open="false" :badge="pattern ? `${pattern.cols}×${pattern.rows}` : ''">
    <div class="field">
      <div class="field-label"><span>图纸标题</span></div>
      <input
        class="input"
        type="text"
        placeholder="拼豆图纸"
        :value="state.title"
        @input="setTitle(($event.target as HTMLInputElement).value)"
      />
      <p class="field-hint">标题会用在导出的文件名和打印页的抬头。</p>
    </div>

    <p class="field-hint">
      图纸样式（彩色 / 符号 / 线稿）和标尺、网格线在画布上方的工具栏里调，
      导出时会照搬那边的设置。
    </p>

    <div class="field">
      <div class="field-label">
        <span>打印倍率</span>
        <span class="field-value">
          {{ pattern ? `${(pattern.cols * pattern.beadSizeMm * view.printScale / 10).toFixed(1)} 厘米宽` : '' }}
        </span>
      </div>
      <div class="seg">
        <button
          v-for="s in PRINT_SCALE_OPTIONS"
          :key="s"
          type="button"
          class="seg-item"
          :class="{ active: view.printScale === s }"
          @click="view.printScale = s"
        >
          {{ s }}×
        </button>
      </div>
      <p class="field-hint">
        1 倍是实际大小，可以垫在底板下面照着摆；但 5 毫米的格子印不下色号，
        想看清色号要用 1.5 倍以上。
      </p>
    </div>

    <div class="field">
      <div class="field-label">
        <span>分页打印</span>
        <span v-if="pageInfo" class="field-value">
          {{ pageInfo.total > 1 ? `共 ${pageInfo.total} 页` : '一页放得下' }}
        </span>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :class="{ active: view.paginate }"
        @click="view.paginate = !view.paginate"
      >
        {{ view.paginate ? '已开启' : '已关闭' }}
      </button>
      <p v-if="pageInfo" class="field-hint">
        <template v-if="pageInfo.total > 1">
          按 {{ view.printScale }} 倍印，一张 A4 放得下
          {{ pageInfo.colsPerPage }} × {{ pageInfo.rowsPerPage }} 格，这张图纸要
          {{ pageInfo.total }} 页。相邻页重叠 1 行/列，照着重叠的那一行对齐。
        </template>
        <template v-else>
          按 {{ view.printScale }} 倍印，这张图纸一张 A4 就放得下。
        </template>
      </p>
      <p v-if="pageInfo && pageInfo.total > 1 && !view.paginate" class="field-hint warn">
        分页关着，整张图纸会被压成一页印 —— 格子比实际小，垫在底板下面照着摆就对不上了。
      </p>
    </div>

    <div class="field">
      <div class="field-label"><span>导出</span></div>
      <div class="row">
        <button type="button" class="btn btn-sm" :disabled="!canExport || busy" @click="exportPng">
          PNG
        </button>
        <button type="button" class="btn btn-sm" :disabled="!canExport" @click="exportSvg">
          SVG
        </button>
        <button type="button" class="btn btn-sm" :disabled="!canExport || busy" @click="exportPdf">
          PDF
        </button>
        <button type="button" class="btn btn-sm" :disabled="!canExport" @click="doPrint">
          打印
        </button>
      </div>
      <p class="field-hint">
        PNG 适合发出去给别人看；SVG、PDF 和打印适合自己照着摆 —— 放大多少倍都不会糊。
      </p>

      <div class="field-label" style="margin-top: 8px">
        <span>PDF 排版</span>
      </div>
      <select
        class="palette-select"
        :value="view.pdfLayout"
        :title="pdfLayoutHint"
        @change="onPdfLayoutChange"
      >
        <option v-for="opt in PDF_LAYOUT_OPTIONS" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <p class="field-hint">{{ pdfLayoutHint }}</p>
    </div>

    <div class="field">
      <div class="field-label"><span>工程文件</span></div>
      <input
        ref="openRef"
        type="file"
        accept="application/json,.json"
        class="sr-only"
        @change="onOpenFile"
      />
      <div class="row">
        <button type="button" class="btn btn-sm" :disabled="!canExport || busy" @click="saveJson">
          保存图纸
        </button>
        <button type="button" class="btn btn-sm" @click="openRef?.click()">
          打开图纸
        </button>
      </div>
      <p class="field-hint">
        保存下来的是可以再次打开继续改的工程文件，不是图片。
        改动很大之前先存一份，比指望撤销靠谱。
      </p>
    </div>

    <p v-if="notice" class="banner banner-info">{{ notice }}</p>
  </SectionCard>
</template>
