import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  CJK_GLYPHS,
  MATH_GLYPHS,
  PDF_FONTS,
  PDF_LABELS,
  SYMBOL_GLYPHS,
  embeddedGlyph,
} from '../src/core/export/pdf/fonts.generated'
import { estimatePdfPages, patternToPdf } from '../src/core/export/pdf/pattern'
import type { LoadedFont, PdfExportOptions } from '../src/core/export/pdf'
import { pagesPerSheet, paginatePattern } from '../src/core/export/page'
import { PALETTES, getPalette, selectColors, createPaletteFilter } from '../src/core/palette'
import { SYMBOL_SEQUENCE } from '../src/core/pattern/symbols'
import { toPatternColor } from '../src/core/pattern/types'
import type { Pattern } from '../src/core/pattern/types'

/**
 * PDF 导出的测试。
 *
 * 生成是**纯函数**（输入图纸，输出字节），所以主体测试不需要 DOM，直接在 node 里
 * 断言字节。最要紧的两类断言：
 *
 * 1. **结构正确**：xref 里每个偏移量都必须精确指向对应的 `N 0 obj` —— 这里写错
 *    的表现是"文件打不开"，而它离现场很远。
 * 2. **文字对得上**：解析出自己生成的 ToUnicode CMap，把正文还原回文字。
 *    没有它，PDF 里的中文虽然看着正常，复制和搜索却全是乱码。
 */

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function loadFonts(): LoadedFont[] {
  const read = (p: string) => {
    const buf = readFileSync(p)
    const out = new Uint8Array(buf.byteLength)
    out.set(buf)
    return out
  }
  return [
    { key: 'cjk', family: PDF_FONTS.cjk.family, meta: PDF_FONTS.cjk, glyphs: CJK_GLYPHS, bytes: read('src/assets/fonts/pdf-cjk.ttf') },
    { key: 'symbols', family: PDF_FONTS.symbols.family, meta: PDF_FONTS.symbols, glyphs: SYMBOL_GLYPHS, bytes: read('src/assets/fonts/pdf-symbols.ttf') },
    { key: 'math', family: PDF_FONTS.math.family, meta: PDF_FONTS.math, glyphs: MATH_GLYPHS, bytes: read('src/assets/fonts/pdf-math.ttf') },
  ]
}

const FONTS = loadFonts()

function color(code: string, hex: string) {
  return toPatternColor({ id: `t.${code}`, code, name: code, hex, rgb: [0, 0, 0], kind: 'solid' })
}

/** 棋盘图纸：格子按 (行+列) 轮换颜色，保证每种颜色都出现 */
function makePattern(rows: number, cols: number, colors = 4, beadSizeMm = 5): Pattern {
  const list = Array.from({ length: colors }, (_, i) =>
    color(`T${i + 1}`, ['#ff0000', '#0000ff', '#00ff00', '#ffff00', '#ff00ff', '#00ffff'][i % 6]!),
  )
  const grid = new Int16Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) grid[r * cols + c] = (r + c) % colors
  }
  return { title: '测试图纸', beadSizeMm: beadSizeMm as Pattern['beadSizeMm'], rows, cols, colors: list, grid }
}

const BASE: Omit<PdfExportOptions, 'layout'> = {
  beadSizeMm: 5,
  printScale: 1.5,
  showRuler: true,
  majorEvery: 5,
  paletteName: 'MARD 221 标准套装',
  boardSize: 29,
  createdAt: new Date(0),
  fonts: FONTS,
}

async function build(pattern: Pattern, extra: Partial<PdfExportOptions> = {}) {
  const bytes = await patternToPdf(pattern, { ...BASE, layout: 'paged', ...extra })
  // 测试里按 latin1 处理字节，二进制内容原样保留
  return { bytes, text: Buffer.from(bytes).toString('latin1') }
}

/** 从 PDF 里把对象体抠出来 */
function objectsOf(text: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const m of text.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)\bendobj/g)) {
    map.set(Number(m[1]), m[2]!)
  }
  return map
}

/** 解开一个流对象（本例中都是 Flate 压缩） */
function streamBytes(body: string): Buffer | null {
  const i = body.indexOf('stream')
  if (i === -1) return null
  let start = i + 6
  if (body[start] === '\r') start++
  if (body[start] === '\n') start++
  const raw = Buffer.from(body.slice(start, body.lastIndexOf('endstream')), 'latin1')
  try {
    return zlib.inflateSync(raw)
  } catch {
    return raw
  }
}

/** 把整个 PDF 还原成可读文字：按当前字体选对 CMap，逐段解码 */
function extractText(text: string): string {
  const objects = objectsOf(text)

  // 资源名（F1/F2…）→ GID → 字符
  const cmapsByResource = new Map<string, Map<number, string>>()
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(body)) continue
    const fontDict = /\/Font\s*<<([^>]*)>>/.exec(body)
    if (!fontDict) continue
    for (const entry of fontDict[1]!.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      const [, name, num] = entry
      const fontObj = objects.get(Number(num)) ?? ''
      const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontObj)
      if (!tu) continue
      const cmapBytes = streamBytes(objects.get(Number(tu[1])) ?? '')
      if (!cmapBytes) continue
      const map = new Map<number, string>()
      for (const pair of cmapBytes.toString('latin1').matchAll(/<([0-9A-F]+)>\s*<([0-9A-F]+)>/g)) {
        const gid = parseInt(pair[1]!, 16)
        let s = ''
        for (let i = 0; i + 4 <= pair[2]!.length; i += 4) {
          s += String.fromCharCode(parseInt(pair[2]!.slice(i, i + 4), 16))
        }
        map.set(gid, s)
      }
      cmapsByResource.set(name!, map)
    }
  }

  const out: string[] = []
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(body)) continue
    const contents = /\/Contents\s+(\d+)\s+0\s+R/.exec(body)
    if (!contents) continue
    const bytes = streamBytes(objects.get(Number(contents[1])) ?? '')
    if (!bytes) continue
    const content = bytes.toString('latin1')

    let current: Map<number, string> | undefined
    for (const line of content.split('\n')) {
      const tf = /^\/(\w+)\s+[\d.]+\s+Tf$/.exec(line)
      if (tf) current = cmapsByResource.get(tf[1]!)
      const tj = /^<([0-9A-F]*)>\s*Tj$/.exec(line)
      if (tj && current) {
        for (let i = 0; i + 4 <= tj[1]!.length; i += 4) {
          out.push(current.get(parseInt(tj[1]!.slice(i, i + 4), 16)) ?? '')
        }
      }
    }
  }
  return out.join('')
}

/** 页面尺寸（pt） */
function pageSizes(text: string): { w: number; h: number }[] {
  return [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => ({
    w: Number(m[1]),
    h: Number(m[2]),
  }))
}

/**
 * 所有页面内容流解压后拼在一起。
 *
 * 内容流是压缩的，所以在原始字节里搜绘制指令是搜不到的 ——
 * 断言绘制细节必须走这里。
 */
function contentOf(text: string): string {
  const objects = objectsOf(text)
  const parts: string[] = []
  for (const body of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(body)) continue
    const contents = /\/Contents\s+(\d+)\s+0\s+R/.exec(body)
    if (!contents) continue
    const bytes = streamBytes(objects.get(Number(contents[1])) ?? '')
    if (bytes) parts.push(bytes.toString('latin1'))
  }
  return parts.join('\n')
}

/** 某个子串在还原出来的文字里出现了几次 */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const A4_W = 595.28
const A4_H = 841.89

// ---------------------------------------------------------------------------

describe('PDF 结构', () => {
  it('是一份完整的 PDF：有头部、有结尾、只有一个 startxref', async () => {
    const { text } = await build(makePattern(10, 10))
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text.match(/startxref/g)).toHaveLength(1)
  })

  it('xref 的每个偏移量都精确指向对应的对象', async () => {
    // 这里错一位，阅读器就会说"文件损坏"，而字节看上去完全正常
    const { text } = await build(makePattern(10, 10))

    const startxref = Number(/startxref\s+(\d+)/.exec(text)![1])
    const table = text.slice(startxref)
    const header = /xref\s+0 (\d+)\s/.exec(table)!
    const count = Number(header[1])
    const entries = [...table.matchAll(/^(\d{10}) (\d{5}) ([nf])\s*$/gm)]
    expect(entries).toHaveLength(count)

    for (let i = 1; i < count; i++) {
      const offset = Number(entries[i]![1])
      const at = text.slice(offset, offset + 24)
      expect(at.startsWith(`${i} 0 obj`), `对象 ${i} 的偏移量指向了 ${JSON.stringify(at)}`).toBe(true)
    }
  })

  it('trailer 指向的 Root 确实是 Catalog，Size 与对象数一致', async () => {
    const { text } = await build(makePattern(10, 10))
    const objects = objectsOf(text)
    const trailer = /trailer\s*<<([\s\S]*?)>>/.exec(text)![1]!
    const size = Number(/\/Size (\d+)/.exec(trailer)![1])
    const root = Number(/\/Root (\d+)\s+0\s+R/.exec(trailer)![1])

    expect(size).toBe(objects.size + 1)
    expect(objects.get(root)).toContain('/Type /Catalog')
  })

  it('嵌入字体带 FontFile2、ToUnicode 与 Identity-H 编码', async () => {
    const { text } = await build(makePattern(10, 10))
    expect(text).toContain('/Subtype /CIDFontType2')
    expect(text).toContain('/FontFile2')
    expect(text).toContain('/Encoding /Identity-H')
    expect(text).toContain('/ToUnicode')
    // 子集前缀是规范约定的六字母标签
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansSC/)
  })

  it('压缩后的字体流长度与原始字体一致（Length1）', async () => {
    const { text } = await build(makePattern(10, 10))
    const length1 = [...text.matchAll(/\/Length1 (\d+)/g)].map((m) => Number(m[1]))
    expect(length1.sort((a, b) => a - b)).toEqual(
      FONTS.map((f) => f.bytes.length).sort((a, b) => a - b),
    )
  })

  it('ASCII 标题里的括号与反斜杠被转义，不会撑破 PDF 字符串', async () => {
    const pattern = { ...makePattern(4, 4), title: 'a(b)c\\d' }
    const { text } = await build(pattern, { title: 'a(b)c\\d' })
    expect(text).toContain('/Title (a\\(b\\)c\\\\d)')
  })

  it('中文标题在元数据里写成 UTF-16BE，而不是坏掉的八进制转义', async () => {
    // 早先的实现用八进制转义，而 PDF 的八进制最多三位，汉字根本写不进去，
    // 标题在阅读器的属性面板里会是一串乱码
    const { text } = await build(makePattern(4, 4))
    expect(text).toMatch(/\/Title <FEFF[0-9A-F]+>/)
  })
})

describe('页面尺寸与分页', () => {
  it('第一页是 A4 横向的汇总页，其余是 A4 纵向的图纸页', async () => {
    const sizes = pageSizes((await build(makePattern(60, 60))).text)
    expect(sizes.length).toBeGreaterThan(1)

    expect(sizes[0]!.w).toBeCloseTo(A4_H, 1) // 297mm
    expect(sizes[0]!.h).toBeCloseTo(A4_W, 1) // 210mm
    for (const page of sizes.slice(1)) {
      expect(page.w).toBeCloseTo(A4_W, 1)
      expect(page.h).toBeCloseTo(A4_H, 1)
    }
  })

  it('图纸页数与分页算法完全一致（多出来的只有汇总页）', async () => {
    const pattern = makePattern(80, 100)
    const per = pagesPerSheet({ beadSizeMm: 5, printScale: 1.5, showRuler: true })
    const expected = paginatePattern(80, 100, per.rowsPerPage, per.colsPerPage).length

    const sizes = pageSizes((await build(pattern)).text)
    expect(sizes).toHaveLength(expected + 1)
    expect(estimatePdfPages(pattern, { layout: 'paged', beadSizeMm: 5, printScale: 1.5, showRuler: true })).toBe(expected + 1)
  })

  it('单页模式只有两页，且图纸页尺寸随图纸走', async () => {
    const pattern = makePattern(30, 40)
    const sizes = pageSizes((await build(pattern, { layout: 'single' })).text)

    expect(sizes).toHaveLength(2)
    // 320/40 = 8mm，被上限压到 6mm；40 格 × 6mm + 标尺 + 页边距
    const gridMm = 40 * 6
    expect(sizes[1]!.w / (72 / 25.4)).toBeGreaterThan(gridMm)
    expect(sizes[1]!.w / (72 / 25.4)).toBeLessThan(gridMm + 40)
  })

  it('单页模式的页面随图纸变大而变大，但始终是一页', async () => {
    const small = pageSizes((await build(makePattern(20, 20), { layout: 'single' })).text)[1]!
    const big = pageSizes((await build(makePattern(104, 104), { layout: 'single' })).text)[1]!
    expect(big.w).toBeGreaterThan(small.w)
    expect(big.w / (72 / 25.4)).toBeLessThan(450) // 毫米，仍是一张能看的尺寸
  })
})

describe('物理尺寸', () => {
  it('分页模式下每格正好是「豆径 × 倍率」毫米', async () => {
    const pattern = makePattern(30, 23)
    const { text } = await build(pattern)
    const decoded = extractText(text)
    expect(decoded).toContain('行 1–30 · 列 1–23')

    // 每页的格数由纸张与格子物理尺寸共同决定，A4 上 5mm×1.5 = 7.5mm 一格是 23×34
    const per = pagesPerSheet({ beadSizeMm: 5, printScale: 1.5, showRuler: true })
    expect(per.colsPerPage).toBe(23)
    expect(per.rowsPerPage).toBe(34)

    // 一格的物理宽度：整页内容宽（去页边距）减去标尺后除以格数
    const content = contentOf(text)
    // 单格 7.5mm = 21.26pt，在内部 px 空间里是 40px，所以缩放大致 0.53
    expect(content).toMatch(/q 0\.53\d* 0 0 -0\.53\d* /)
  })

  it('倍率改变会改变格子的物理大小，但不改变页面尺寸', async () => {
    const a = await build(makePattern(20, 20), { printScale: 1 })
    const b = await build(makePattern(20, 20), { printScale: 2 })
    // 同样 20 格，2 倍下每格 10mm 而不是 5mm，于是 20 格的图更宽；
    // 但纸张固定是 A4，所以页面尺寸不变、只是分页不同
    expect(pageSizes(a.text)[1]!.w).toBeCloseTo(pageSizes(b.text)[1]!.w, 1)
  })
})

describe('文字正确性（解析自己生成的 ToUnicode）', () => {
  it('汇总页上的中文与数据都能被还原出来', async () => {
    const pattern = { ...makePattern(12, 12, 3), title: '拼豆图纸' }
    const { text } = await build(pattern)
    const decoded = extractText(text)

    expect(decoded).toContain('拼豆图纸') // 标题（在字体子集里）
    expect(decoded).toContain('MARD 221 标准套装') // 色卡名
    expect(decoded).toContain('12 × 12 格')
    expect(decoded).toContain('颜色购物清单（3）')
    expect(decoded).toContain('T1')
    expect(decoded).toContain('备货')
  })

  it('标题里有字体画不出来的字时，退回默认标题而不是印成问号', async () => {
    // 图纸标题是用户随便输的，字体子集是构建期定死的，覆盖不了所有汉字。
    // "测试"这两个字就不在子集里 —— 印成「??图纸」比不印更糟
    const pattern = { ...makePattern(12, 12, 3), title: '测试图纸' }
    const { text } = await build(pattern)
    const decoded = extractText(text)

    expect(decoded).not.toContain('?')
    expect(decoded).toContain('拼豆图纸') // 退回默认标题

    // 但元数据里保留用户的原始标题（UTF-16BE，不受字形限制）
    expect(text).toMatch(/\/Title <FEFF[0-9A-F]+>/)
    const hex = /\/Title <FEFF([0-9A-F]+)>/.exec(text)![1]!
    let metaTitle = ''
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      metaTitle += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    }
    expect(metaTitle).toBe('测试图纸')
  })

  it('中文标点没有被打成问号（字体子集必须覆盖全部文案）', async () => {
    const { text } = await build(makePattern(12, 12))
    const decoded = extractText(text)
    // 全角括号、全角空格、顿号这些都是容易漏掉进子集的
    expect(decoded).toContain('（')
    expect(decoded).toContain('）')
    expect(decoded).toContain('：')
    expect(decoded).not.toContain('?')
  })

  it('图纸页的页眉带页码与行列范围', async () => {
    const { text } = await build(makePattern(80, 60, 4))
    const decoded = extractText(text)
    expect(decoded).toContain('第 1 / ')
    expect(decoded).toMatch(/行 1–\d+ · 列 1–\d+/)
  })

  it('色号放得下就印色号 —— 格子够大时直接写', async () => {
    // 10×10 的单页图每格有 6mm，短色号到处都是：每格一个
    const short = extractText((await build(makePattern(10, 10), { layout: 'single' })).text)
    expect(countOf(short, 'T1')).toBeGreaterThan(10)
  })

  it('色号放不下就印符号 —— 与其它四路输出同一套判断', async () => {
    // 104 列的单页图每格只有约 3mm，8 个字符塞不下，格内应退成符号。
    // 注意 10×10 那种小图**不会**退：格子大，长色号也放得下。
    const long = { ...makePattern(104, 104) }
    long.colors = long.colors.map((c, i) => color(`80-1900${i + 1}`, '#ff0000'))
    const decoded = extractText((await build(long, { layout: 'single' })).text)

    // 清单里仍是完整色号，而且只出现一次 —— 出现多次就说明格子里也印了
    expect(countOf(decoded, '80-19001')).toBe(1)
    // 格内印的是符号（A、B、C、D），上万格子里到处都是
    expect(countOf(decoded, 'A')).toBeGreaterThan(100)
  })
})

describe('字体覆盖', () => {
  it('9 张色卡的全部色号与颜色名都能被嵌入字体画出来', () => {
    const missing: string[] = []
    for (const palette of PALETTES) {
      for (const ch of palette.name) if (!embeddedGlyph(ch)) missing.push(`${palette.id}:${ch}`)
      for (const c of palette.colors) {
        for (const ch of c.code) if (!embeddedGlyph(ch)) missing.push(`${c.id}:${ch}`)
        for (const ch of c.name) if (!embeddedGlyph(ch)) missing.push(`${c.id}名:${ch}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('全部 92 个符号都能被画出来', () => {
    // maxColors 钳在 64，所以实际只会用到前 64 个；但符号表在这儿，
    // 就一次性覆盖全，免得哪天上限放开后 PDF 里少字
    const missing = SYMBOL_SEQUENCE.filter((s) => !embeddedGlyph(s))
    expect(missing).toEqual([])
    expect(SYMBOL_SEQUENCE.length).toBeGreaterThanOrEqual(90)
  })

  it('所有 PDF 文案的字符都被覆盖', () => {
    const missing: string[] = []
    for (const value of Object.values(PDF_LABELS)) {
      for (const ch of value.replace(/\{\w+\}/g, '')) {
        if (!embeddedGlyph(ch)) missing.push(`${ch}(U+${ch.codePointAt(0)!.toString(16)})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('覆盖率是构造保证的：三张字体的字表都不为空且 GID 非零', () => {
    for (const table of [CJK_GLYPHS, SYMBOL_GLYPHS, MATH_GLYPHS]) {
      expect(table.gid.size).toBeGreaterThan(0)
      for (const [, gid] of table.gid) expect(gid).toBeGreaterThan(0)
    }
  })

  it('没有两个字符共用同一个字形 —— 否则 ToUnicode 只能二选一', () => {
    // 字体里字符共用字形很常见（空格 U+0020 与不换行空格 U+00A0 就是一对）。
    // 一旦共用，ToUnicode 一个 GID 只能映射一个字符，另一个字符复制出来就是错的：
    // 「空格变成不换行空格」「连字符变成软连字符」，搜索和复制全对不上。
    // 生成脚本已经把这类字符排除在子集之外，这里守住它。
    for (const [name, table] of [
      ['cjk', CJK_GLYPHS],
      ['symbols', SYMBOL_GLYPHS],
      ['math', MATH_GLYPHS],
    ] as const) {
      expect(table.reverse.size, `${name} 有字符共用字形`).toBe(table.gid.size)
    }
  })

  it('空格与连字符在 PDF 里复制出来必须是普通字符', async () => {
    // 这条是上一条的实际后果：如果共用字形，这里的空格会变成 U+00A0
    const { text } = await build(makePattern(10, 10))
    const decoded = extractText(text)
    expect(decoded).toContain('第 1 / ')
    // 明确用码点写：这两个字符肉眼看不见，直接嵌在源码里没人读得出来
    expect(decoded.includes('\u00a0')).toBe(false) // 不换行空格
    expect(decoded.includes('\u00ad')).toBe(false) // 软连字符
  })
})

describe('确定性', () => {
  it('同样的图纸与创建时间，两次生成字节完全相同', async () => {
    const pattern = makePattern(24, 24, 5)
    const a = await patternToPdf(pattern, { ...BASE, layout: 'paged' })
    const b = await patternToPdf(pattern, { ...BASE, layout: 'paged' })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('不传创建时间也能生成（用当前时间）', async () => {
    const bytes = await patternToPdf(makePattern(8, 8), {
      ...BASE,
      layout: 'single',
      createdAt: undefined,
    })
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('不同排版生成的文件不同，但都是合法 PDF', async () => {
    const pattern = makePattern(40, 40)
    const paged = await patternToPdf(pattern, { ...BASE, layout: 'paged' })
    const single = await patternToPdf(pattern, { ...BASE, layout: 'single' })
    expect(Buffer.from(paged).equals(Buffer.from(single))).toBe(false)
    for (const bytes of [paged, single]) {
      expect(Buffer.from(bytes).toString('latin1').startsWith('%PDF-')).toBe(true)
    }
  })
})

describe('边界情况', () => {
  it('小到 1×1 的图纸也能生成', async () => {
    const { text } = await build(makePattern(1, 1, 1))
    expect(pageSizes(text).length).toBeGreaterThanOrEqual(2)
  })

  it('空格子按背景色画，不会被当成某个颜色', async () => {
    const pattern = makePattern(10, 10, 2)
    pattern.grid[0] = -1
    pattern.grid[1] = -1
    const { text } = await build(pattern)
    const content = contentOf(text)
    // #f1f3f5 换算成 0~1 就是 0.945 0.953 0.961
    expect(content).toContain('0.945 0.953 0.961 rg')
    expect(content).toContain('re f')
  })

  it('全部是空格的图纸不会崩，页数照常', async () => {
    const pattern = makePattern(6, 6, 1)
    pattern.grid.fill(-1)
    const sizes = pageSizes((await build(pattern)).text)
    expect(sizes.length).toBeGreaterThanOrEqual(2)
  })

  it('不传 stats 时自己算，清单内容仍然完整', async () => {
    const pattern = makePattern(12, 12, 3)
    const { text } = await build(pattern, { stats: undefined })
    const decoded = extractText(text)
    expect(decoded).toContain('颜色购物清单（3）')
    // 12×12 = 144 格，3 种颜色各 48 颗
    expect(decoded).toContain('48')
  })

  it('300×300 的大图纸不会产生 NaN 坐标', async () => {
    const pattern = makePattern(300, 300, 6)
    const bytes = await patternToPdf(pattern, { ...BASE, layout: 'single' })
    const text = Buffer.from(bytes).toString('latin1')
    expect(text).not.toContain('NaN')
    expect(pageSizes(text)[1]!.w).toBeGreaterThan(0)
  })

  it('色卡全部 9 张都能当作出图来源', async () => {
    for (const palette of PALETTES) {
      const colors = selectColors(palette, createPaletteFilter()).slice(0, 6).map(toPatternColor)
      const pattern: Pattern = {
        ...makePattern(8, 8, 1),
        colors,
      }
      for (let i = 0; i < pattern.grid.length; i++) pattern.grid[i] = i % colors.length
      const bytes = await patternToPdf(pattern, {
        ...BASE,
        layout: 'single',
        paletteName: palette.name,
      })
      expect(bytes.length, palette.id).toBeGreaterThan(1000)
    }
  })
})
