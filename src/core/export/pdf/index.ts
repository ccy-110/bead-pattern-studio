/**
 * PDF 导出。
 *
 * 模块划分：
 * - `writer.ts`   把页面与字体组装成 PDF 字节（不依赖 DOM）
 * - `content.ts`  内容流构造器：矩形、直线、文字
 * - `fonts.ts`    按需加载三张子集字体
 * - `pattern.ts`  图纸 → 页面：汇总页 + 图纸页，复用其它四路输出的版面计算
 *
 * 字体由 `scripts/gen-pdf-font.mjs` 在构建期子集化生成，产物在 `src/assets/fonts/`。
 */
export { patternToPdf, estimatePdfPages } from './pattern'
export type { PdfExportOptions, PdfPreviewImage } from './pattern'
export { loadPdfFonts } from './fonts'
export type { LoadedFont } from './fonts'
export { buildPdf, mmToPt } from './writer'
export type { Bytes, PdfDocSpec, PdfPageSpec } from './writer'
