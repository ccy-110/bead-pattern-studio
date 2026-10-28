import { PDF_FONTS, embeddedGlyph } from './fonts.generated'
import type { PdfFontKey } from './fonts.generated'

/**
 * PDF 内容流构造器。
 *
 * 坐标系沿用应用里那套"px、y 向下"的空间（与 `computeGridLayout`、`planCellLabels`
 * 一致），最后用一次坐标变换整体映射到页面。这样 PDF 的版面计算能和屏幕 / PNG /
 * SVG / 打印**共用同一份代码**，不必再写一套 PDF 专用的排版。
 *
 * 变换矩阵是 `s 0 0 -s 0 H`：把 (x, y) 映到 (s·x, H − s·y)，即水平缩放 s、
 * 垂直翻转并平移到页面高度 H。文字再用 `1 0 0 -1 x y` 的文本矩阵翻回来，
 * 两次翻转抵消，字就是正的。
 */

/** 一个字符在某个字体里的落位 */
interface GlyphRun {
  font: PdfFontKey
  /** 大写十六进制 GID 串，Identity-H 编码下这就是"文本" */
  hex: string
  /** 该串的总宽（px，与传入的 fontSize 同单位） */
  width: number
}

function num(v: number): string {
  // PDF 里 0.30000000000000004 这种数会白白撑大文件
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1]!, 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

export interface TextOptions {
  /** 字号，单位与坐标系一致（px）；PDF 侧会被整体缩放 */
  size: number
  color?: string
  align?: 'left' | 'center' | 'right'
  /** 画不出来的字符会换成 '?' 并调用它，便于测试断言"不该发生" */
  onMissing?: (ch: string) => void
}

export class PdfContent {
  private readonly parts: string[] = []
  /** 当前坐标系的缩放比（px → pt），文字基线偏移要用 */
  private scale = 1

  private push(s: string): void {
    this.parts.push(s)
  }

  /** 保存图形状态（与 restore 配对） */
  save(): this {
    this.push('q')
    return this
  }

  restore(): this {
    this.push('Q')
    return this
  }

  /**
   * 设定用户空间：按 scale 缩放、垂直翻转，原点落在页面的 (originX, originY)。
   * 调用后所有坐标都用"px、y 向下"。**会压入一个图形状态**，调用方负责 restore()。
   */
  userSpace(scale: number, originX: number, originY: number): this {
    this.scale = scale
    this.push(
      `q ${num(scale)} 0 0 ${num(-scale)} ${num(originX)} ${num(originY)} cm`,
    )
    return this
  }

  /** 当前 px→pt 的缩放比（文字基线偏移等地方要用） */
  get userScale(): number {
    return this.scale
  }

  fillColor(hex: string): this {
    const [r, g, b] = rgbOf(hex)
    this.push(`${num(r)} ${num(g)} ${num(b)} rg`)
    return this
  }

  strokeColor(hex: string): this {
    const [r, g, b] = rgbOf(hex)
    this.push(`${num(r)} ${num(g)} ${num(b)} RG`)
    return this
  }

  lineWidth(w: number): this {
    this.push(`${num(w)} w`)
    return this
  }

  /** 填充矩形 */
  rect(x: number, y: number, w: number, h: number): this {
    this.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`)
    return this
  }

  /** 描边矩形（线宽由 lineWidth 决定） */
  rectStroke(x: number, y: number, w: number, h: number): this {
    this.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re S`)
    return this
  }

  // 路径：批量画线时用，一次 stroke 比每条线各画一次省得多
  beginPath(): this {
    this.push('newpath')
    return this
  }

  moveTo(x: number, y: number): this {
    this.push(`${num(x)} ${num(y)} m`)
    return this
  }

  lineTo(x: number, y: number): this {
    this.push(`${num(x)} ${num(y)} l`)
    return this
  }

  stroke(): this {
    this.push('S')
    return this
  }

  /**
   * 画一段文字。
   *
   * 字符串会按"哪个字体能画这个字"切成若干段，逐段换字体。位置由**我们自己**
   * 用字体的真实字宽累加算出（所以能左/中/右对齐），而不是交给阅读器。
   */
  text(x: number, y: number, str: string, opts: TextOptions): this {
    if (str === '') return this
    const size = opts.size
    const runs = this.shape(str, size, opts.onMissing)
    if (runs.length === 0) return this

    let total = 0
    for (const r of runs) total += r.width

    const align = opts.align ?? 'left'
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x

    if (opts.color) this.fillColor(opts.color)

    // 基线与"视觉中心"的偏移：画布的 textBaseline='middle' 大致相当于
    // 大写字母高度的一半，用字体的 capHeight 算更准
    const capOffset = (PDF_FONTS.cjk.capHeight / PDF_FONTS.cjk.upem) * 0.5 * size
    const baseline = y + capOffset

    for (const run of runs) {
      this.push('BT')
      this.push(`/${run.font} ${num(size)} Tf`)
      this.push(`1 0 0 -1 ${num(cx)} ${num(baseline)} Tm`)
      this.push(`<${run.hex}> Tj`)
      this.push('ET')
      cx += run.width
    }
    return this
  }

  /** 量一段文字的宽度（px），用于自己排版（比如右对齐的数字列） */
  measure(str: string, size: number): number {
    let total = 0
    for (const r of this.shape(str, size)) total += r.width
    return total
  }

  private shape(
    str: string,
    size: number,
    onMissing?: (ch: string) => void,
  ): GlyphRun[] {
    const runs: GlyphRun[] = []
    let cur: GlyphRun | null = null

    for (const raw of str) {
      let ch = raw
      let g = embeddedGlyph(ch)
      if (g === null) {
        // 画不出来的字符。留空会让 PDF 里凭空少一块，换成 '?' 至少看得见
        onMissing?.(ch)
        ch = '?'
        g = embeddedGlyph(ch)
        if (g === null) continue
      }

      const width = (g.width / 1000) * size
      if (cur !== null && cur.font === g.font) {
        cur.hex += g.gid.toString(16).padStart(4, '0').toUpperCase()
        cur.width += width
      } else {
        cur = {
          font: g.font,
          hex: g.gid.toString(16).padStart(4, '0').toUpperCase(),
          width,
        }
        runs.push(cur)
      }
    }
    return runs
  }

  build(): string {
    return this.parts.join('\n')
  }
}
