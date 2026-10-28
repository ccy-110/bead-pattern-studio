import type { EmbeddedFontMeta, GlyphTable } from './fonts.generated'

/**
 * 一个够用的 PDF 写入器。
 *
 * 为什么不引第三方库：项目从色彩科学到 SVG 导出都是自己实现的，唯一运行时依赖是 Vue。
 * PDF 是纯文本格式，我们需要的子集（页面树、内容流、标准字体、嵌入 TrueType 字体）
 * 写起来并不比已有的 SVG 导出难，而换来的是零依赖、零体积。
 *
 * 覆盖范围是**刻意的窄**：不加密、不签章、不做 PDF/A、不写增量更新。
 * 只做一件事 —— 把矢量图形和文字排成页面。
 *
 * 输出**完全确定**：同样的输入产出同样的字节（创建时间可注入），
 * 这样测试才能逐字节比对。
 */

/**
 * 字节数组。
 *
 * TypeScript 5.7 起 `Uint8Array` 带上了缓冲区类型的泛型参数，
 * `Uint8Array`（默认 `ArrayBufferLike`）不能直接喂给 `CompressionStream` 之类的
 * `BufferSource`。明确写成背后是 `ArrayBuffer` 就不用到处强转。
 */
export type Bytes = Uint8Array<ArrayBuffer>

/** 标准字体（PDF 阅读器自带，不嵌入）。ASCII 走这里，中文/符号走嵌入字体 */
export interface StandardFontSpec {
  /** 内容流里引用的资源名，如 'F1' */
  key: string
  /** 如 'Helvetica' / 'Helvetica-Bold' */
  baseFont: string
}

export interface EmbeddedFontSpec {
  key: string
  /** 家族名，实际写进 PDF 时会加 6 字母子集前缀 */
  family: string
  meta: EmbeddedFontMeta
  glyphs: GlyphTable
  bytes: Bytes
}

export interface PdfPageSpec {
  /** 页面尺寸，单位 pt（1pt = 1/72 英寸） */
  widthPt: number
  heightPt: number
  /** 未压缩的内容流 */
  content: string
}

export interface PdfDocSpec {
  pages: PdfPageSpec[]
  standardFonts?: StandardFontSpec[]
  embeddedFonts?: EmbeddedFontSpec[]
  title?: string
  creator?: string
  /** 可注入，保证测试可复现 */
  createdAt?: Date
}

const PT_PER_MM = 72 / 25.4

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM
}

/**
 * 用 deflate 压缩。
 *
 * 浏览器和 Node 都有 CompressionStream（Node 18+），拿不到就原样返回 ——
 * PDF 允许不压缩，功能不受影响，只是文件大一些。
 */
async function deflate(bytes: Bytes): Promise<{ data: Bytes; compressed: boolean }> {
  const Stream = (globalThis as { CompressionStream?: typeof CompressionStream })
    .CompressionStream
  if (typeof Stream !== 'function') return { data: bytes, compressed: false }
  try {
    const cs = new Stream('deflate')
    const writer = cs.writable.getWriter()
    void writer.write(bytes)
    void writer.close()
    const chunks: Bytes[] = []
    const reader = cs.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value as Bytes)
    }
    let total = 0
    for (const c of chunks) total += c.length
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return { data: out, compressed: true }
  } catch {
    return { data: bytes, compressed: false }
  }
}

/**
 * PDF 字符串字面量。
 *
 * 纯 ASCII 用普通括号串（转义反斜杠与括号）；含非 ASCII 的走
 * **UTF-16BE + BOM 的十六进制串** —— 这是元数据里表示非拉丁文字的标准做法。
 * 曾经的实现用八进制转义，而 PDF 的八进制转义最多三位，汉字（如"拼"=U+62FC）
 * 根本写不进去，结果标题在阅读器属性面板里是一串乱码。
 */
function pdfString(s: string): string {
  if (/[^\x20-\x7e]/.test(s)) {
    let hex = 'FEFF' // BOM：告诉阅读器这是 UTF-16BE
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0
      if (cp > 0xffff) {
        // 需要代理对
        const v = cp - 0x10000
        hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0')
        hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0')
      } else {
        hex += cp.toString(16).padStart(4, '0')
      }
    }
    return `<${hex.toUpperCase()}>`
  }

  let out = '('
  for (const ch of s) {
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch
    else out += ch
  }
  return out + ')'
}

/** PDF 日期串：D:YYYYMMDDHHmmSS+HH'mm' */
function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`
  )
}

/** 2004 年 1 月 1 日，作为 PDF 的"零时刻"，也是我们给子集字体用的前缀 */
const SUBSET_TAG = 'ABCDEF'

interface PdfObject {
  /** 字典（不含 `<<` `>>`），若带流则是流字典 */
  dict: string
  stream?: Bytes
}

/**
 * 把对象序列化成完整文件。
 *
 * xref 的每个偏移量都必须精确指向 `N 0 obj` 的起始位置 —— 这是最容易写错、
 * 也最容易在阅读器里表现为"文件打不开"的地方，所以有测试逐条核对。
 */
export async function buildPdf(spec: PdfDocSpec): Promise<Bytes> {
  const objects: PdfObject[] = []

  /** 占一个对象号（PDF 从 1 开始） */
  const add = (obj: PdfObject): number => {
    objects.push(obj)
    return objects.length
  }
  /** 先占号后填内容：互相引用的对象需要预留编号 */
  const reserve = (): number => {
    objects.push({ dict: '' })
    return objects.length
  }
  const fill = (num: number, obj: PdfObject): void => {
    objects[num - 1] = obj
  }

  // ---- 字体资源 ----
  const standardFonts = spec.standardFonts ?? []
  const embeddedFonts = spec.embeddedFonts ?? []

  const fontRefs = new Map<string, number>()

  for (const f of standardFonts) {
    const num = add({ dict: `/Type /Font /Subtype /Type1 /BaseFont /${f.baseFont} /Encoding /WinAnsiEncoding` })
    fontRefs.set(f.key, num)
  }

  for (const f of embeddedFonts) {
    const baseName = `${SUBSET_TAG}+${f.family.replace(/\s+/g, '')}`
    const fileName = `FontFile2-${f.key}`

    const { data: fontBytes, compressed } = await deflate(f.bytes)
    const fileNum = add({
      dict:
        `/Length ${fontBytes.length} /Length1 ${f.bytes.length}` +
        (compressed ? ' /Filter /FlateDecode' : ''),
      stream: fontBytes,
    })

    const descriptorNum = add({
      dict:
        `/Type /FontDescriptor /FontName /${baseName} ` +
        // Flags 4 = Symbolic。中文子集里既有汉字也有标点，用 Symbolic 最不容易被
        // 阅读器拿去套用系统字体
        `/Flags 4 /FontBBox [${f.meta.bbox.join(' ')}] /ItalicAngle 0 ` +
        `/Ascent ${f.meta.ascent} /Descent ${f.meta.descent} ` +
        `/CapHeight ${f.meta.capHeight} /StemV 80 /FontFile2 ${fileNum} 0 R`,
    })

    // /DW 1000 是绝大多数中文字形的宽度（全角），只有宽度不等于它的才写进 /W，
    // 这样中文字体几乎不需要 W 数组
    const widths: string[] = []
    const sortedGids = [...f.glyphs.width.keys()].sort((a, b) => a - b)
    for (const gid of sortedGids) {
      const w = f.glyphs.width.get(gid)!
      if (w !== 1000) widths.push(`${gid} [${w}]`)
    }

    const descendantNum = add({
      dict:
        `/Type /Font /Subtype /CIDFontType2 /BaseFont /${baseName} ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${descriptorNum} 0 R /DW 1000 ` +
        (widths.length > 0 ? `/W [${widths.join(' ')}] ` : '') +
        `/CIDToGIDMap /Identity`,
    })

    const toUnicode = buildToUnicode(f.glyphs)
    const { data: cmapBytes, compressed: cmapCompressed } = await deflate(
      new TextEncoder().encode(toUnicode),
    )
    const cmapNum = add({
      dict: `/Length ${cmapBytes.length}` + (cmapCompressed ? ' /Filter /FlateDecode' : ''),
      stream: cmapBytes,
    })

    const type0Num = add({
      dict:
        `/Type /Font /Subtype /Type0 /BaseFont /${baseName} /Encoding /Identity-H ` +
        `/DescendantFonts [${descendantNum} 0 R] /ToUnicode ${cmapNum} 0 R`,
    })
    fontRefs.set(f.key, type0Num)
    void fileName
  }

  // ---- 页面 ----
  const kids: number[] = []
  const pagesNum = reserve()

  for (const page of spec.pages) {
    const { data: contentBytes, compressed } = await deflate(
      new TextEncoder().encode(page.content),
    )
    const contentNum = add({
      dict: `/Length ${contentBytes.length}` + (compressed ? ' /Filter /FlateDecode' : ''),
      stream: contentBytes,
    })

    const fontEntries: string[] = []
    for (const [key, num] of fontRefs) fontEntries.push(`/${key} ${num} 0 R`)

    const resources =
      fontEntries.length > 0 ? `/Resources << /Font << ${fontEntries.join(' ')} >> >> ` : ''

    const pageNum = add({
      dict:
        `/Type /Page /Parent ${pagesNum} 0 R ` +
        `/MediaBox [0 0 ${round(page.widthPt)} ${round(page.heightPt)}] ` +
        resources +
        `/Contents ${contentNum} 0 R`,
    })
    kids.push(pageNum)
  }

  fill(pagesNum, {
    dict: `/Type /Pages /Count ${kids.length} /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}]`,
  })

  const infoNum = add({
    dict:
      '/Producer ' +
      pdfString(spec.creator ?? 'Bead Pattern Studio') +
      (spec.title ? ` /Title ${pdfString(spec.title)}` : '') +
      ` /CreationDate ${pdfString(pdfDate(spec.createdAt ?? new Date()))}`,
  })

  const catalogNum = add({ dict: `/Type /Catalog /Pages ${pagesNum} 0 R` })

  // ---- 序列化 ----
  const head = new TextEncoder().encode('%PDF-1.4\n%\xb5\xb5\xb5\xb5\n')
  const chunks: Bytes[] = [head]
  let offset = head.length
  const offsets: number[] = []

  const push = (text: string) => {
    const bytes = new TextEncoder().encode(text)
    chunks.push(bytes)
    offset += bytes.length
  }

  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset)
    const obj = objects[i]!
    push(`${i + 1} 0 obj\n<< ${obj.dict} >>\n`)
    if (obj.stream) {
      push('stream\n')
      chunks.push(obj.stream)
      offset += obj.stream.length
      push('\nendstream\n')
    }
    push('endobj\n')
  }

  const xrefOffset = offset
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  push(xref)
  push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R /Info ${infoNum} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  )

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * ToUnicode CMap：GID → Unicode。
 *
 * 没有它，PDF 里的中文虽然显示正常，但**复制、搜索、无障碍朗读全是乱码** ——
 * 因为 Identity-H 编码写的是字形编号，不是字符。
 */
function buildToUnicode(glyphs: GlyphTable): string {
  const entries = [...glyphs.reverse.entries()].sort((a, b) => a[0] - b[0])
  const blocks: string[] = []
  // 规范建议每个 beginbfchar 块不超过 100 条
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100)
    blocks.push(
      `${slice.length} beginbfchar\n` +
        slice
          .map(([gid, ch]) => {
            const utf16 = [...ch]
              .map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(4, '0'))
              .join('')
              .toUpperCase()
            return `<${gid.toString(16).padStart(4, '0').toUpperCase()}> <${utf16}>`
          })
          .join('\n') +
        '\nendbfchar',
    )
  }

  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${blocks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`
}
