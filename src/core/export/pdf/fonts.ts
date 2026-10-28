import {
  CJK_GLYPHS,
  MATH_GLYPHS,
  PDF_FONTS,
  SYMBOL_GLYPHS,
} from './fonts.generated'
import type { EmbeddedFontMeta, GlyphTable, PdfFontKey } from './fonts.generated'
import type { Bytes } from './writer'

/**
 * PDF 用的嵌入字体。字体文件是**按需加载**的：只有第一次导出 PDF 时才去取，
 * 首屏和日常使用不付这份代价（合计约 50KB）。
 *
 * 字体本身由 `scripts/gen-pdf-font.mjs` 在构建期子集化生成 —— 详见那个脚本。
 */

export interface LoadedFont {
  key: PdfFontKey
  family: string
  meta: EmbeddedFontMeta
  glyphs: GlyphTable
  bytes: Bytes
}

const TABLES: Record<PdfFontKey, GlyphTable> = {
  cjk: CJK_GLYPHS,
  symbols: SYMBOL_GLYPHS,
  math: MATH_GLYPHS,
}

/** Vite 会把 `?url` 解析成构建后的资源地址（base 是相对路径，两种部署都对） */
async function fetchFont(url: string): Promise<Bytes> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`字体加载失败（HTTP ${res.status}）`)
  return new Uint8Array(await res.arrayBuffer())
}

let pending: Promise<LoadedFont[]> | null = null

/** 加载三张子集字体。重复调用共用同一次请求。 */
export function loadPdfFonts(): Promise<LoadedFont[]> {
  pending ??= (async () => {
    // 动态 import：连资源 URL 都落在懒加载的 chunk 里，不进首屏
    const [cjk, symbols, math] = await Promise.all([
      import('../../../assets/fonts/pdf-cjk.ttf?url'),
      import('../../../assets/fonts/pdf-symbols.ttf?url'),
      import('../../../assets/fonts/pdf-math.ttf?url'),
    ])
    const [cjkBytes, symbolBytes, mathBytes] = await Promise.all([
      fetchFont(cjk.default),
      fetchFont(symbols.default),
      fetchFont(math.default),
    ])
    return (['cjk', 'symbols', 'math'] as const).map((key) => ({
      key,
      family: PDF_FONTS[key].family,
      meta: PDF_FONTS[key],
      glyphs: TABLES[key],
      bytes: key === 'cjk' ? cjkBytes : key === 'symbols' ? symbolBytes : mathBytes,
    }))
  })()
  return pending
}
