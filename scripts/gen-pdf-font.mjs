/**
 * 生成导出 PDF 用的子集字体与字表。
 *
 * 为什么必须子集化：PDF 内置的 14 个标准字体（Helvetica 等）只有 Latin-1，
 * 中文必须自己嵌字体；而完整的思源/Noto 中文字库有十几 MB，塞进每份 PDF 不现实。
 * 这里在**构建期**把字体裁到"PDF 里真正会出现的字符"，产出二十几 KB 的 TTF。
 *
 * 为什么用 subset-font 而不是 fontkit 自己的 subset：源字体是 CFF 轮廓，
 * fontkit 的 createSubset() 产出 99 个字形却要 3.9 MB；subset-font（harfbuzz）
 * 顺带把 CFF 转成了 glyf —— 那正是 PDF 的 FontFile2 需要的格式，且只有 25 KB。
 *
 * 用法：node scripts/gen-pdf-font.mjs
 * 幂等：同样的输入产出完全相同的文件。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'
import * as fontkit from 'fontkit'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FONT_DIR = join(ROOT, 'src', 'assets', 'fonts')
const OUT_DIR = join(ROOT, 'src', 'core', 'export', 'pdf')

/**
 * 源字体。都是 OFL 许可，可随应用分发。
 * 版本写死，保证任何人在任何时间跑这个脚本都拿到同一份字体。
 */
const SOURCES = {
  cjk: {
    // fontsource 把 Noto Sans SC 按 unicode-range 切成多个分片，简中在这个分片里
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.2.5/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
    license: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.2.5/LICENSE',
    out: 'pdf-cjk.ttf',
    family: 'Noto Sans SC',
  },
  symbols: {
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-symbols-2@5.2.5/files/noto-sans-symbols-2-symbols-400-normal.woff2',
    license: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-symbols-2@5.2.5/LICENSE',
    out: 'pdf-symbols.ttf',
    family: 'Noto Sans Symbols 2',
  },
  // Noto Sans Symbols 2 不含数学运算符（⊕⊗⊘⊚），由 Math 补上。
  // 这么小的字体能覆盖 4 个符号，换来的是"PDF 能画出应用能产生的每一个符号"，
  // 不必为极端情况留一条降级路径。
  math: {
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-math@5.2.5/files/noto-sans-math-math-400-normal.woff2',
    license: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-math@5.2.5/LICENSE',
    out: 'pdf-math.ttf',
    family: 'Noto Sans Math',
  },
}

/**
 * PDF 里所有中文文案的**唯一真相**。
 *
 * 这个列表同时决定三件事：字体子集包含哪些字、生成的 labels 模块导出什么、
 * 界面用它渲染。所以文案要改就必须重跑本脚本 —— 而脚本会校验每个字都有字形，
 * 漏字会直接报错，不会静默产出一份缺字的 PDF。
 */
const LABELS = {
  appName: '拼豆图纸工坊',
  defaultTitle: '拼豆图纸',
  denseHint: '图案较密时，请放大 PDF 以清晰查看格内标注。',
  symbolHint: '格内标注是图纸格子里印的内容：色号放得下就印色号，放不下就印符号，符号与下表一一对应。',
  colorDisclaimer: '色值为屏幕参考值，不等同实物；买豆对色请以手中实物色卡为准。',

  // 下面是带占位符的整句模板。
  // **不要在代码里拼中文**：内联的全角标点（（）、　）不会出现在这张表里，
  // 于是也不会进字体子集，到了 PDF 里就变成一个个问号。所有文案走这里，
  // 生成脚本才能保证每一个字都有字形。
  brandLine: '适配品牌：{name}',
  gridLine: '网格尺寸：{w} × {h} 格',
  totalLine: '总计：{n} 颗',
  finishedLine: '成品约 {w} × {h} 毫米',
  boardLine: '底板 {across} × {down} = {total} 块（{size} × {size}）',
  colorListWithCount: '颜色购物清单（{n}）',
  purchaseLine: '备货 {n}',
  sizeLine: '{w} × {h} 格',
  pageCaption: '第 {n} / {total} 页　行 {r1}–{r2} · 列 {c1}–{c2}',
}

/** 除中文标签外，符号表里的几何形状也要覆盖（见 symbols.ts 的 SYMBOL_SEQUENCE） */
const GEOMETRIC_SYMBOLS = [
  '●', '○', '■', '□', '▲', '△', '▼', '▽', '◆', '◇',
  '★', '☆', '✦', '✧', '✚', '✖', '◐', '◑', '◒', '◓',
  '⬤', '◼', '◻', '⬥', '⬦', '⊕', '⊗', '⊙', '⊘', '⊚',
]

/**
 * ASCII 也放进中文字体的子集里，而不是走 PDF 标准字体 Helvetica。
 *
 * 原因是**字宽**：文字排版要知道每个字多宽才能把后续内容摆对位置，而 Helvetica
 * 的字宽表只能靠手抄。放进子集后所有宽度都从字体里精确读出，顺带也没有了
 * WinAnsi 编码只能表示 Latin-1 的限制。
 *
 * 顺带一提，色号与名称**全是 ASCII**：MARD / COCO / 漫漫 / 盼盼 / 咪小窝 没有颜色名，
 * Hama / Perler / Artkal 的名字是英文。所以中文只出现在我们自己写的文案里。
 */
const ASCII = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'

/**
 * Latin-1 补充区（U+00A0–U+00FF）也要覆盖。
 *
 * 颜色名是照抄来源里的原文，里面真的带重音字母（Artkal 有个色号叫 "é"）。
 * 早先只放了 ASCII，那个字在 PDF 里就成了问号 —— 是测试抓出来的。
 *
 * **但要剔掉不换行空格（U+00A0）与软连字符（U+00AD）**：这两个字符我们自己从不输出，
 * 而它们在字体里和普通空格（U+0020）、连字符（U+002D）**共用同一个字形**。
 * 一旦同时进子集，GID 就会撞车，而 ToUnicode 一个 GID 只能映射一个字符，
 * 结果是 PDF 里复制出来的空格变成不换行空格、`80-19001` 变成 `80‑19001`（软连字符），
 * 搜索、复制全对不上 —— 这种错在屏幕上完全看不出来。
 */
const EXCLUDED_LATIN1 = new Set([0x00a0, 0x00ad]) // 不换行空格、软连字符
const LATIN1_SUPPLEMENT = Array.from({ length: 0x100 - 0xa0 }, (_, i) => 0xa0 + i)
  .filter((cp) => !EXCLUDED_LATIN1.has(cp))
  .map((cp) => String.fromCharCode(cp))
  .join('')

async function fetchCached(url, cacheName) {
  const cacheDir = join(ROOT, 'data-sources', 'fonts')
  const cachePath = join(cacheDir, cacheName)
  if (existsSync(cachePath)) return readFileSync(cachePath)
  mkdirSync(cacheDir, { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(cachePath, buf)
  return buf
}

/** 某个字体覆盖了这些字符里的哪些 */
function coverage(spec, chars) {
  const font = fontkit.create(readFileSync(cachePathFor(spec)))
  const covered = []
  const missing = []
  for (const ch of chars) {
    const g = font.glyphsForString(ch)[0]
    if (g && g.id !== 0) covered.push(ch)
    else missing.push(ch)
  }
  return { covered, missing }
}

function cachePathFor(spec) {
  return join(ROOT, 'data-sources', 'fonts', spec.out.replace('.ttf', '.src.woff2'))
}

/** 把字符集裁成子集，并抽出 PDF 需要的字表 */
async function buildFont(spec, chars, label) {
  if (chars.size === 0) return null
  await fetchCached(spec.url, spec.out.replace('.ttf', '.src.woff2'))

  const text = [...chars].join('')
  const sub = await subsetFont(readFileSync(cachePathFor(spec)), text, {
    targetFormat: 'truetype',
  })

  // 用 fontkit 读回子集，取出 GID 与字宽。
  // 注意：这一步是**校验**，不是生成 —— 子集是 harfbuzz 产的
  const font = fontkit.create(Buffer.from(sub))

  const missing = []
  const glyphs = []
  const gidOwners = new Map()
  for (const ch of [...chars].sort()) {
    const g = font.glyphsForString(ch)[0]
    if (!g || g.id === 0) {
      missing.push(`${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase()})`)
      continue
    }
    // 用**码点**而不是字符本身做键：字符表是空格分隔的，而空格字符本身就在表里，
    // 直接写字符会被自己的分隔符切碎（曾经因此丢掉所有空格）
    const cp = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase()
    glyphs.push(`${cp}:${g.id}:${g.advanceWidth}`)

    const owners = gidOwners.get(g.id) ?? []
    owners.push(ch)
    gidOwners.set(g.id, owners)
  }

  const shared = [...gidOwners.entries()].filter(([, owners]) => owners.length > 1)
  if (shared.length > 0) {
    // 不报错，但要说出来：共用字形会让 ToUnicode 只能二选一，
    // 于是其中一个字符在 PDF 里复制出来是另一个
    console.warn(
      `  ⚠ ${label}：${shared.length} 组字符共用字形 —— ` +
        shared
          .map(
            ([gid, owners]) =>
              `gid${gid} [${owners.map((c) => `U+${c.codePointAt(0).toString(16)}`).join(' ')}]`,
          )
          .join('，'),
    )
  }

  if (missing.length > 0) {
    // 缺字必须当场炸掉：静默产出的字体在 PDF 里会显示成空白或方框，
    // 而那时候已经离现场很远了
    throw new Error(
      `${label} 子集缺少 ${missing.length} 个字形，${spec.family} 覆盖不了这些字符：\n  ${missing.join(' ')}`,
    )
  }

  const os2 = font['OS/2']
  const head = font.head
  const hhea = font.hhea

  return {
    bytes: Buffer.from(sub),
    meta: {
      family: spec.family,
      upem: font.unitsPerEm,
      ascent: Math.round(hhea.ascent),
      descent: Math.round(hhea.descent),
      capHeight: os2?.sCapHeight ?? Math.round(hhea.ascent * 0.7),
      bbox: [
        Math.round(head.xMin),
        Math.round(head.yMin),
        Math.round(head.xMax),
        Math.round(head.yMax),
      ],
      glyphs: glyphs.join(' '),
      glyphCount: font.numGlyphs,
    },
  }
}

function tsString(s) {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// ---------------------------------------------------------------------------

/**
 * 色卡名会印在 PDF 的参数行上（"适配品牌：MARD 221 标准套装"），
 * 而它是**运行时数据**，不在上面的文案表里。所以从色卡数据文件里把它们抠出来，
 * 一并放进子集 —— 否则那些字在 PDF 里会变成问号。
 *
 * 色号与颜色名不用管：它们全是 ASCII（MARD 等品牌没有颜色名，国外品牌的名字是英文）。
 */
function paletteNames() {
  const dir = join(ROOT, 'src', 'core', 'palette', 'data')
  const names = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(join(dir, file), 'utf8')
    // 色卡名是**行首两空格缩进**的 name，颜色项是行内四空格缩进的，不会误匹配
    for (const m of text.matchAll(/^ {2}name: '([^']+)',$/gm)) names.push(m[1])
  }
  if (names.length < 9) {
    throw new Error(`只从色卡数据里找到 ${names.length} 个色卡名，应当是 9 个 —— 数据文件格式变了？`)
  }
  return names
}

const cardNames = paletteNames()
const labelChars = new Set([
  ...Object.values(LABELS).join(''),
  ...ASCII,
  ...LATIN1_SUPPLEMENT,
  ...cardNames.join(''),
])
// 先落盘两个符号字体的源文件，才能判断各自覆盖了哪些符号
await fetchCached(SOURCES.symbols.url, SOURCES.symbols.out.replace('.ttf', '.src.woff2'))
await fetchCached(SOURCES.math.url, SOURCES.math.out.replace('.ttf', '.src.woff2'))

const viaSymbols = coverage(SOURCES.symbols, GEOMETRIC_SYMBOLS)
const viaMath = coverage(SOURCES.math, viaSymbols.missing)
if (viaMath.missing.length > 0) {
  throw new Error(
    `没有任何源字体覆盖这些符号：${viaMath.missing.join(' ')}。` +
      `要么换字体，要么把它们从 symbols.ts 的符号表里去掉。`,
  )
}

const cjk = await buildFont(SOURCES.cjk, labelChars, '中文字体')
const sym = await buildFont(SOURCES.symbols, new Set(viaSymbols.covered), '符号字体')
const math = await buildFont(SOURCES.math, new Set(viaMath.covered), '数学运算符字体')

mkdirSync(FONT_DIR, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

writeFileSync(join(FONT_DIR, 'pdf-cjk.ttf'), cjk.bytes)
writeFileSync(join(FONT_DIR, 'pdf-symbols.ttf'), sym.bytes)
writeFileSync(join(FONT_DIR, 'pdf-math.ttf'), math.bytes)

// OFL 要求随字体一起分发许可全文
const ofl = await fetchCached(SOURCES.cjk.license, 'OFL.txt')
writeFileSync(join(FONT_DIR, 'OFL.txt'), ofl)

const emitFont = (name, meta) => `  ${name}: {
    family: ${tsString(meta.family)},
    upem: ${meta.upem},
    ascent: ${meta.ascent},
    descent: ${meta.descent},
    capHeight: ${meta.capHeight},
    bbox: [${meta.bbox.join(', ')}] as const,
    /** \`码点:GID:字宽\`（十六进制码点）的空格分隔表，运行时解析一次。
     *  用码点而不是字符，是因为表里就有空格字符，直接写会被分隔符切碎 */
    glyphs: ${tsString(meta.glyphs)},
  },`

const out = `/**
 * 由 scripts/gen-pdf-font.mjs 生成，**不要手改**。
 * 改动请改脚本里的 LABELS / GEOMETRIC_SYMBOLS 后重跑。
 *
 * 字体来源：${SOURCES.cjk.family} / ${SOURCES.symbols.family} / ${SOURCES.math.family}
 * （均为 OFL 许可，许可全文见 src/assets/fonts/OFL.txt）。
 * ASCII 不在这些子集里 —— 它走 PDF 内置的 Helvetica，不占体积。
 */

export interface EmbeddedFontMeta {
  family: string
  upem: number
  ascent: number
  descent: number
  capHeight: number
  readonly bbox: readonly [number, number, number, number]
  readonly glyphs: string
}

export const PDF_LABELS = {
${Object.entries(LABELS)
  .map(([k, v]) => `  ${k}: ${tsString(v)},`)
  .join('\n')}
} as const

export type PdfLabelKey = keyof typeof PDF_LABELS

export const PDF_FONTS = {
${emitFont('cjk', cjk.meta)}
${emitFont('symbols', sym.meta)}
${emitFont('math', math.meta)}
} as const satisfies Record<string, EmbeddedFontMeta>

export type PdfFontKey = keyof typeof PDF_FONTS

export interface GlyphTable {
  /** 字符 → GID */
  readonly gid: ReadonlyMap<string, number>
  /** GID → 字符（生成 ToUnicode 用） */
  readonly reverse: ReadonlyMap<number, string>
  /** GID → 字宽（千分之一 em，PDF 的 W 数组就用这个单位） */
  readonly width: ReadonlyMap<number, number>
}

function parseGlyphs(spec: EmbeddedFontMeta): GlyphTable {
  const gid = new Map<string, number>()
  const reverse = new Map<number, string>()
  const width = new Map<number, number>()
  for (const entry of spec.glyphs.split(' ')) {
    const [cp, g, w] = entry.split(':')
    if (!cp || g === undefined || w === undefined) continue
    const ch = String.fromCodePoint(parseInt(cp, 16))
    const gidNum = Number(g)
    gid.set(ch, gidNum)
    width.set(gidNum, Math.round((Number(w) / spec.upem) * 1000))
    // 一个字形可能被多个字符共用（字体里很常见，比如空格与不换行空格）。
    // ToUnicode 一个 GID 只能映射一个字符，所以必须**确定地**选一个：
    // 取码点小的那个 —— 空格 U+0020 赢过不换行空格 U+00A0，
    // 连字符 U+002D 赢过软连字符 U+00AD，都是我们真正会输出的那个。
    const existing = reverse.get(gidNum)
    if (existing === undefined || ch.codePointAt(0)! < existing.codePointAt(0)!) {
      reverse.set(gidNum, ch)
    }
  }
  return { gid, reverse, width }
}

export const CJK_GLYPHS: GlyphTable = parseGlyphs(PDF_FONTS.cjk)
export const SYMBOL_GLYPHS: GlyphTable = parseGlyphs(PDF_FONTS.symbols)
export const MATH_GLYPHS: GlyphTable = parseGlyphs(PDF_FONTS.math)

/** 嵌入字体的一张总表：字符 → 该用哪个字体、GID 是多少、多宽 */
export interface EmbeddedGlyph {
  font: PdfFontKey
  gid: number
  /** 千分之一 em */
  width: number
}

const EMBEDDED = new Map<string, EmbeddedGlyph>()
for (const [key, table] of [
  ['cjk', CJK_GLYPHS],
  ['symbols', SYMBOL_GLYPHS],
  ['math', MATH_GLYPHS],
] as const) {
  for (const [ch, gid] of table.gid) {
    EMBEDDED.set(ch, { font: key, gid, width: table.width.get(gid) ?? 1000 })
  }
}

/**
 * 查一个非 ASCII 字符该用哪个嵌入字体。
 *
 * 返回 null 表示没有字体能画它 —— 调用方必须降级（画序号而不是留空），
 * 而不是画出一个方框。生成脚本已保证应用自己的文案与符号表 100% 有覆盖，
 * 这个分支只在用户自己往颜色表里塞了生僻字时才可能走到。
 */
export function embeddedGlyph(ch: string): EmbeddedGlyph | null {
  return EMBEDDED.get(ch) ?? null
}
`


writeFileSync(join(OUT_DIR, 'fonts.generated.ts'), out, 'utf8')

console.log(`色卡名 ${cardNames.length} 个：${cardNames.join('、')}`)
console.log(`主字体（中文+ASCII） ${(cjk.bytes.length / 1024).toFixed(1)} KB  ${cjk.meta.glyphs.split(' ').length} 个字符`)
console.log(`符号字体            ${(sym.bytes.length / 1024).toFixed(1)} KB  ${sym.meta.glyphs.split(' ').length} 个字符`)
console.log(`数学运算符字体       ${(math.bytes.length / 1024).toFixed(1)} KB  ${math.meta.glyphs.split(' ').length} 个字符（${viaMath.covered.join(' ')}）`)
console.log('已生成 src/assets/fonts/pdf-{cjk,symbols,math}.ttf、OFL.txt 与 fonts.generated.ts')
