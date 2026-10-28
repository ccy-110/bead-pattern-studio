/**
 * 从 data-sources/ 的原始快照生成 src/core/palette/data/*.ts。
 *
 * 为什么不手写数据文件：九张色卡加起来两千多个颜色，手抄既容易出错、又没法审计。
 * 脚本化之后，「这个色号的颜色值从哪来」有唯一的答案，重新生成的结果每次都一样。
 *
 * 用法：node scripts/gen-palettes.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'data-sources')
const OUT = join(ROOT, 'src', 'core', 'palette', 'data')
const SNAPSHOT_DATE = '2026-09-19'

// ---------------------------------------------------------------------------
// 读取来源
// ---------------------------------------------------------------------------

/** 读 pindou-color-data 的 colors.json */
function loadPindou(name) {
  const raw = JSON.parse(readFileSync(join(SRC, 'pindou-color-data', `${name}.json`), 'utf8'))
  const sourceQualities = new Set()
  for (const s of raw.sources ?? []) sourceQualities.add(s.quality)
  return {
    id: raw.id,
    title: raw.title,
    count: raw.count,
    groups: raw.groups,
    urls: (raw.sources ?? []).map((s) => s.url),
    sourceQualities: [...sourceQualities],
    colors: raw.colors.map((c) => ({
      code: String(c.code),
      hex: String(c.hex).toLowerCase(),
      group: c.group,
    })),
  }
}

/** 读 beadcolors 的 CSV：`参考色号,名称,红,绿,蓝,贡献者` */
function loadBeadcolors(name) {
  const text = readFileSync(join(SRC, 'beadcolors', `${name}.csv`), 'utf8')
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [code, colorName, r, g, b] = line.split(',')
      return {
        code,
        name: colorName,
        hex: hexOf([Number(r), Number(g), Number(b)]),
      }
    })
}

function hexOf([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** 两个色值的最大通道差 */
function channelDelta(a, b) {
  const x = rgbOf(a)
  const y = rgbOf(b)
  return Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]))
}

// ---------------------------------------------------------------------------
// 材质判定
// ---------------------------------------------------------------------------

/**
 * 按名称关键词判定材质。
 *
 * 只在名称里出现明确词时才判定，判不出来的就是纯色 —— 宁可漏标也不能错标：
 * 纯色被误标成特殊色会让这个颜色永远进不了自动配色的候选集，用户完全无从察觉。
 */
const KIND_KEYWORDS = [
  [/\bglow\b/i, 'glow'],
  // 用子串而不是 \bpearl\b：Artkal 的珠光系列写作 "Pearlescent"，
  // 加词边界会整系列漏判成纯色，而"特殊色被误标成纯色"正是最危险的失效方向。
  [/pearl/i, 'pearl'],
  [/\b(transparent|translucent|clear)\b/i, 'transparent'],
  [/\b(neon|fluorescent)\b/i, 'neon'],
  // gold/silver 保留词边界：Marigold、Goldenrod 是植物名的纯色，不能误判
  [/\b(metallic|gold|silver|bronze|copper)\b/i, 'metallic'],
  [/\b(glitter|sparkle)\b/i, 'glitter'],
]

/**
 * 关键词覆盖不到的特例。每条都要写清楚理由，不许凭感觉加。
 */
const KIND_OVERRIDES = {
  hama: {
    // Hama 的夜光豆命名是 "Green (Glow in the Dark)"，关键词已能命中，此处仅留结构备用
  },
  perler: {
    // "Toasted Marshmallow"（烤棉花糖）是纯色，不因 marshmallow 被误判
  },
}

function kindFromName(paletteId, name) {
  const overrides = KIND_OVERRIDES[paletteId] ?? {}
  if (name in overrides) return overrides[name]
  for (const [re, kind] of KIND_KEYWORDS) {
    if (re.test(name)) return kind
  }
  return 'solid'
}

/** MARD 的扩展系列：三处独立来源（用户描述、色号大全站、1688 在售套装）一致 */
const MARD_GROUP_KIND = {
  P: 'pearl', // 珠光 23 色
  Q: 'thermo', // 温变 5 色
  R: 'transparent', // 果冻（半透明）28 色
  T: 'transparent', // 透明 1 色
  Y: 'glow', // 夜光 5 色
  ZG: 'uv', // 光变 8 色
}

// ---------------------------------------------------------------------------
// MARD：四个来源合并成一张表
// ---------------------------------------------------------------------------

const MARD_GROUP_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M', 'P', 'Q', 'R', 'T', 'Y', 'ZG']

function groupOf(code) {
  const m = /^([A-Za-z]+)/.exec(code)
  return m ? m[1].toUpperCase() : ''
}

function codeNumber(code) {
  const m = /(\d+)$/.exec(code)
  return m ? Number(m[1]) : 0
}

function sortMard(colors) {
  const rank = (c) => {
    const g = MARD_GROUP_ORDER.indexOf(groupOf(c.code))
    return g === -1 ? MARD_GROUP_ORDER.length : g
  }
  return [...colors].sort((a, b) => rank(a) - rank(b) || codeNumber(a.code) - codeNumber(b.code))
}

/**
 * 合并 MARD 的多个公开来源。
 *
 * 关键发现：`alfonse`（豆豆工坊核对版）与 `github`（get-colors 公开源码库版）
 * 在 77 个色号上不一致，最大通道差 38 —— 这不是取色噪声，是两套不同的色卡口径。
 * 因此**只用单一来源**，绝不混用：A–H+M 与扩展色都取自 github291，
 * 这样 221 与 291 两张色卡、以及它和另外四个国产品牌（同出一源）口径一致。
 * 差异完整记录到 data-sources/mard-differences.md 供人工裁定。
 */
function buildMard() {
  const alfonse = loadPindou('mard-221-alfonse-doudou')
  const github221 = loadPindou('mard-221-github')
  const github291 = loadPindou('mard-291-github')
  const beadcolors = loadBeadcolors('mard')

  const byCode = (list) => new Map(list.map((c) => [c.code, c.hex]))
  const maps = {
    alfonse: byCode(alfonse.colors),
    github221: byCode(github221.colors),
    github291: byCode(github291.colors),
    beadcolors: byCode(beadcolors),
  }

  const base = github291.colors.filter((c) => !(groupOf(c.code) in MARD_GROUP_KIND))
  const extra = github291.colors.filter((c) => groupOf(c.code) in MARD_GROUP_KIND)

  // 与本表采用的来源逐色比对：同源的 github221 应当完全一致，其余两个记录差异
  const diffs = new Map()
  for (const name of ['alfonse', 'beadcolors']) {
    const list = []
    for (const c of base) {
      const other = maps[name].get(c.code)
      if (other === undefined) continue
      const worst = channelDelta(other, c.hex)
      if (worst > 8) list.push({ code: c.code, mine: c.hex, other, worst })
    }
    list.sort((a, b) => b.worst - a.worst)
    diffs.set(name, list)
  }

  return { base, extra, diffs, maps, github291 }
}

/** 把来源差异写成可审计的 Markdown */
function writeMardDifferences(diffs, maps) {
  const lines = [
    '# MARD 色号：公开来源之间的差异',
    '',
    '生成本文件的脚本会重新计算这份差异。**本项目的色卡采用 `github291` 一套口径**，',
    '不与其他来源混用；这里列出差异是为了让口径选择可被人工复核。',
    '',
    '判定门槛：任一通道差超过 8 才记录（小于这个数是取色噪声，不影响对色）。',
    '',
  ]
  for (const [name, list] of diffs) {
    lines.push(`## 与 ${name} 的差异：${list.length} 个色号超过门槛`)
    lines.push('')
    if (list.length === 0) {
      lines.push('（无）')
      lines.push('')
      continue
    }
    lines.push('| 色号 | 本表采用 (github291) | ' + name + ' | 最大通道差 |')
    lines.push('|---|---|---|---|')
    for (const d of list) {
      lines.push(`| ${d.code} | ${d.mine} | ${d.other} | ${d.worst} |`)
    }
    lines.push('')
  }
  writeFileSync(join(SRC, 'mard-differences.md'), lines.join('\n'), 'utf8')
  void maps
}

// ---------------------------------------------------------------------------
// 生成 TS
// ---------------------------------------------------------------------------

/** 单引号字符串字面量。名称里有撇号（Perler 的 "Robin's Egg"）必须转义。 */
function q(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function colorLine(c, indent = '    ') {
  const parts = [`code: ${q(c.code)}`, `name: ${q(c.name)}`, `hex: ${q(c.hex)}`]
  if (c.kind && c.kind !== 'solid') parts.push(`kind: ${q(c.kind)}`)
  return `${indent}{ ${parts.join(', ')} },`
}

/** 组装一个完整的色卡数据文件：import 在最前，然后是文件头注释、共享常量、各色卡 */
function emitFile({ headerLines, prelude = '', palettes }) {
  const header = headerLines.map((l) => (l === '' ? ' *' : ` * ${l}`)).join('\n')
  const parts = [
    `import type { Palette } from '../types'`,
    `import { defineColors } from '../types'`,
    '',
    '/**',
    header,
    ' */',
  ]
  if (prelude) parts.push('', prelude)
  for (const p of palettes) parts.push('', paletteLiteral(p))
  return parts.join('\n') + '\n'
}

/** 只含一张色卡的文件 */
function emitPalette({ headerLines, ...palette }) {
  return emitFile({ headerLines, palettes: [palette] })
}

function paletteLiteral({ constName, id, title, source, note, colorExpr }) {
  return `export const ${constName}: Palette = {
  id: ${q(id)},
  name: ${q(title)},
  version: '1.0.0',
  source:
    ${q(source)},
  note:
    ${q(note)},
  colors: ${colorExpr},
}`
}

/** 把颜色数组渲染成 defineColors(...) 调用，按分组插入注释分隔行 */
function renderColors(paletteId, colors, groupLabel) {
  const lines = []
  let lastGroup = null
  for (const c of colors) {
    const g = c.group ?? ''
    if (groupLabel && g !== lastGroup) {
      lines.push(`    // ── ${groupLabel(g)} ${'─'.repeat(Math.max(0, 44 - groupLabel(g).length))}`)
      lastGroup = g
    }
    lines.push(colorLine(c))
  }
  return `defineColors(${q(paletteId)}, [\n${lines.join('\n')}\n  ])`
}

/**
 * 把长说明排进注释块。
 *
 * 中文没有词间空格，必须能逐字断行；但英文词、URL、文件名又不能从中间断开
 * （曾把 beadcolors 切成 "beadco / lors"）。所以按「中日韩字符算 2 宽、ASCII 词
 * 整体不可分」来打包。
 */
const WIDE = /[　-〿一-鿿＀-￯]/

function displayWidth(s) {
  let n = 0
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1
  return n
}

function wrapText(text, maxWidth = 72) {
  const tokens = text.match(/\s+|[A-Za-z0-9_./:@#+-]+|./gu) ?? []
  const lines = []
  let line = ''
  for (const t of tokens) {
    if (/^\s+$/.test(t) && line === '') continue
    if (line !== '' && displayWidth(line) + displayWidth(t) > maxWidth) {
      lines.push(line.trimEnd())
      line = /^\s+$/.test(t) ? '' : t
    } else {
      line += t
    }
  }
  if (line.trim() !== '') lines.push(line.trimEnd())
  return lines
}

function assertUnique(paletteId, colors) {
  const seen = new Set()
  for (const c of colors) {
    if (seen.has(c.code)) throw new Error(`${paletteId} 色号重复: ${c.code}`)
    seen.add(c.code)
    if (!/^#[0-9a-f]{6}$/.test(c.hex)) throw new Error(`${paletteId} ${c.code} 色值非法: ${c.hex}`)
    if (!c.name) throw new Error(`${paletteId} ${c.code} 缺少名称`)
  }
}

function write(fileName, content) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, fileName), content, 'utf8')
  return fileName
}

const PALETTE_SOURCE_BASE =
  '屏幕参考值，非厂商公布的 sRGB。数据来自开源色卡汇总仓库（MIT 许可），原始快照与许可全文见仓库 data-sources/ 目录。'

const CODE_ONLY_NOTE =
  '本品牌色卡没有颜色名——所有公开数据源与商家均按色号销售（如「A1 一包」），因此颜色名一栏就是色号本身。色值为屏幕参考值，不等同实物；塑料豆受批次与光线影响，同一色号不同批次可能有肉眼可见差异，买豆对色请以手中实物色卡为准。'

// ---------------------------------------------------------------------------

const written = []

// ---- MARD 221 + 291（共用一张基准表）----
{
  const { base, extra, diffs, maps, github291 } = buildMard()
  writeMardDifferences(diffs, maps)

  const mardBase = sortMard(base).map((c) => ({ ...c, name: c.code }))
  const mardExtra = sortMard(extra).map((c) => ({
    ...c,
    name: c.code,
    kind: MARD_GROUP_KIND[groupOf(c.code)],
  }))
  assertUnique('mard', mardBase)
  assertUnique('mard291', [...mardBase, ...mardExtra])

  const groupLabel = (g) => {
    const names = {
      A: '黄橙系',
      B: '绿色系',
      C: '蓝青系',
      D: '紫色系',
      E: '粉玫红系',
      F: '红棕系',
      G: '肤色 / 棕色',
      H: '黑白灰',
      M: '莫兰迪低饱和',
      P: '珠光（扩展）',
      Q: '温变（扩展）',
      R: '果冻半透明（扩展）',
      T: '透明（扩展）',
      Y: '夜光（扩展）',
      ZG: '光变（扩展）',
    }
    return names[g] ?? g
  }

  const alfonseDiffs = diffs.get('alfonse') ?? []
  const beadDiffs = diffs.get('beadcolors') ?? []

  const diffSummary =
    `MARD 的公开数据存在多套互相冲突的口径：另有「豆豆工坊核对版」在 ${alfonseDiffs.length} 个色号上与本表相差超过 8（最大 ${alfonseDiffs[0]?.worst ?? 0}），` +
    `国际汇总仓库 beadcolors 则差得更多（${beadDiffs.length} 个色号，最大 ${beadDiffs[0]?.worst ?? 0}）。` +
    `本表采用公开源码库版一套口径、不与其他来源混用，完整差异见仓库 data-sources/mard-differences.md。`

  const baseConst = `const MARD_BASE = [\n${mardBase.map((c) => colorLine(c, '  ')).join('\n')}\n]`
  const extraConst = `const MARD_EXTRA = [\n${mardExtra.map((c) => colorLine(c, '  ')).join('\n')}\n]`

  const sharedHeader = [
    'MARD 拼豆色卡（国内通用参考体系）。',
    '',
    `数据来源：HansBug/pindou-color-data（MIT，快照 ${SNAPSHOT_DATE}）的 mard-291-github 版，`,
    '  原始出处 https://git.xiongxiao.me/abearxiong/get-colors-from-beans',
    ...wrapText(diffSummary),
    '',
    '221 色 = A–H + M 九个色系；291 色在此基础上多出 P/Q/R/T/Y/ZG 七十个',
    '扩展色（珠光 23、温变 5、果冻 28、透明 1、夜光 5、光变 8）。',
    '',
    '两个色卡共用同一份基准表，因此共用色号的色值必然一致——否则用户会在',
    '两张色卡上看到同一个 A1 颜色不同，无从判断哪个对。',
  ]

  written.push(
    write(
      'mard.ts',
      emitFile({
        headerLines: sharedHeader,
        prelude: `${baseConst}\n\n${extraConst}`,
        palettes: [
          {
            constName: 'mard221Palette',
            id: 'mard221',
            title: 'MARD 221 标准套装',
            source: `社区实测近似值。MARD 是国内零售与图纸交流的实际默认色号体系。${PALETTE_SOURCE_BASE}`,
            note: `${CODE_ONLY_NOTE}${diffSummary}`,
            colorExpr: "defineColors('mard221', [...MARD_BASE])",
          },
          {
            constName: 'mard291Palette',
            id: 'mard291',
            title: 'MARD 291 全色系',
            source: `社区实测近似值。291 色 = 221 色 + 70 个扩展色。${PALETTE_SOURCE_BASE}`,
            note: `${CODE_ONLY_NOTE}扩展色（P 珠光 / Q 温变 / R 果冻 / T 透明 / Y 夜光 / ZG 光变）默认不参与自动配色，需要时在类别里勾选。`,
            colorExpr: "defineColors('mard291', [...MARD_BASE, ...MARD_EXTRA])",
          },
        ],
      }),
    ),
  )

  console.log(`MARD 基准表 ${mardBase.length} 色 + 扩展 ${mardExtra.length} 色，均取自 ${github291.id}`)
  for (const [name, list] of diffs) {
    console.log(`  与 ${name} 差异 >8 的色号：${list.length} 个，最大通道差 ${list[0]?.worst ?? 0}`)
    for (const d of list.slice(0, 3)) console.log(`    ${d.code}: 本表 ${d.mine} vs ${d.other}`)
  }
}

// ---- Artkal S（5mm）----
{
  const colors = loadBeadcolors('artkal_s').map((c) => ({
    ...c,
    group: /^([A-Z]+)/.exec(c.code)?.[1] ?? '',
    kind: kindFromName('artkalS', c.name),
  }))
  assertUnique('artkalS', colors)
  const specials = colors.filter((c) => c.kind !== 'solid')
  const series = [...new Set(colors.map((c) => c.group))]
  const hash = Object.fromEntries(
    series.map((s) => [s, colors.filter((c) => c.group === s).length]),
  )
  written.push(
    write(
      'artkal.ts',
      emitPalette({
        constName: 'artkalSPalette',
        id: 'artkalS',
        title: 'Artkal S（5mm）',
        source: `社区实测近似值。Artkal（优肯）S 系列为 5mm 规格。${PALETTE_SOURCE_BASE}`,
        note: `色值来自玩家社区实物取色。特殊材质由色名判定（Glow / Pearl / Transparent / Neon / Metallic 等关键词），共 ${specials.length} 色，默认不参与自动配色。色值为屏幕参考值，不等同实物。`,
        colorExpr: renderColors(
          'artkalS',
          colors,
          (g) => `${{ S: 'S 实色', SE: 'SE 系列', SG: 'SG 系列', SL: 'SL 系列', SN: 'SN 系列', SP: 'SP 系列', ST: 'ST 系列' }[g] ?? g}`,
        ),
        headerLines: [
          'Artkal（优肯）S 系列 5mm 融合豆色卡。',
          '',
          `数据来源：maxcleme/beadcolors（MIT，快照 ${SNAPSHOT_DATE}），来源字段 "Perlervault"。`,
          `系列构成：${series.map((s) => `${s}(${hash[s]})`).join(', ')}`,
          '',
          'Artkal 另有 C 系列 197 色与 M 系列 221 色（后者编号 MA1/MB1… 为官方兼容',
          'MARD 的体系），但那两套是 2.6mm 迷你豆，与本表的 5mm 规格不同。',
          '',
          '色名保留厂商的英文原名，未做翻译——中文拼豆圈对照国外教程时用的就是这些名字。',
        ],
      }),
    ),
  )
  console.log(`Artkal S: ${colors.length} 色，特殊色 ${specials.length}`)
}

// ---- Hama ----
{
  const colors = loadBeadcolors('hama').map((c) => ({
    ...c,
    kind: kindFromName('hama', c.name),
  }))
  assertUnique('hama', colors)
  const specials = colors.filter((c) => c.kind !== 'solid')
  written.push(
    write(
      'hama.ts',
      emitPalette({
        constName: 'hamaPalette',
        id: 'hama',
        title: 'Hama（丹麦）',
        source: `社区实测近似值。Hama 是欧洲主流的 midi 5mm 融合豆品牌。${PALETTE_SOURCE_BASE}`,
        note: `色值来自玩家社区实物取色，贡献者见来源仓库。色号形如 H01、H119，中间有跳号，共 ${colors.length} 色。特殊材质由色名判定，共 ${specials.length} 色，默认不参与自动配色。色值为屏幕参考值，不等同实物。`,
        colorExpr: renderColors('hama', colors, () => '全部色号'),
        headerLines: [
          'Hama（丹麦）midi 5mm 融合豆色卡。',
          '',
          `数据来源：maxcleme/beadcolors（MIT，快照 ${SNAPSHOT_DATE}）。`,
          '色值由多位玩家分别贡献（Jeppewl / LThanda / galaxy / Exodeca1 / Tryk47 / rYonder），',
          '因此同一张表内的取色条件不完全一致。',
          '',
          '注意：Hama 官方产品目录里的色号是纯数字（01、18…），社区资料普遍写成',
          'H01、H18 以便与其他品牌区分，本表沿用社区写法。',
        ],
      }),
    ),
  )
  console.log(`Hama: ${colors.length} 色，特殊色 ${specials.length}`)
}

// ---- Perler ----
{
  const colors = loadBeadcolors('perler').map((c) => ({
    ...c,
    kind: kindFromName('perler', c.name),
  }))
  assertUnique('perler', colors)
  const specials = colors.filter((c) => c.kind !== 'solid')
  written.push(
    write(
      'perler.ts',
      emitPalette({
        constName: 'perlerPalette',
        id: 'perler',
        title: 'Perler（美国）',
        source: `社区实测近似值。色号为 Perler 官方物料号（80-19001 形式，80-19004=Orange、80-19005=Red）。${PALETTE_SOURCE_BASE}`,
        note: `色值来自 Perlervault 的实物取色。色号较长（80-19001），图纸格子里放不下时整张图纸会退化为符号标注，靠图例对照——Perler 的官方图纸本来也是这么做的。本表覆盖的是 Perler 的实色线，特殊色只识别出 ${specials.length} 色；Perler 另有夜光、珠光、半透明等产品线，本数据源没有收录，不是软件漏掉了。色值为屏幕参考值，不等同实物。`,
        colorExpr: renderColors('perler', colors, () => 'Perler 物料号'),
        headerLines: [
          'Perler（美国）融合豆色卡。',
          '',
          `数据来源：maxcleme/beadcolors（MIT，快照 ${SNAPSHOT_DATE}），来源字段 "Perlervault"。`,
          '',
          '色号是 Perler 的官方物料号，形如 80-19001；前半段 80- 是产品线前缀，',
          '后半段才是颜色编号。社区资料里常直接写成 19001。',
          '',
          '本表 103 色。部分资料称 Perler 有 117 色，差异来自套装与停产的统计口径，',
          '以及是否计入 Perler Mini / Caps（那是另外两种规格）。',
        ],
      }),
    ),
  )
  console.log(`Perler: ${colors.length} 色，特殊色 ${specials.length}`)
}

// ---- 国产品牌：COCO / 漫漫 / 盼盼 / 咪小窝 ----
const DOMESTIC = [
  { file: 'coco-291', id: 'coco', constName: 'cocoPalette', title: 'COCO', specials: 'none' },
  { file: 'manman-278', id: 'manman', constName: 'manmanPalette', title: '漫漫家', specials: 'none' },
  { file: 'panpan-289', id: 'panpan', constName: 'panpanPalette', title: '盼盼家', specials: 'none' },
  { file: 'mixiaowo-290', id: 'mixiaowo', constName: 'mixiaowoPalette', title: '咪小窝', specials: 'none' },
]

for (const spec of DOMESTIC) {
  const data = loadPindou(spec.file)
  // 盼盼 / 咪小窝 的 code 是裸数字，group 是中文色系名；COCO / 漫漫 的 code 自带字母前缀
  const colors = data.colors.map((c) => ({ ...c, name: c.code, kind: 'solid' }))
  assertUnique(spec.id, colors)
  const groupOrder = Object.keys(data.groups ?? {})
  const hasChineseGroups = groupOrder.some((g) => /[一-龥]/.test(g))

  written.push(
    write(
      `${spec.id}.ts`,
      emitPalette({
        constName: spec.constName,
        id: spec.id,
        title: spec.title,
        source: `社区实测近似值。${PALETTE_SOURCE_BASE}`,
        note: `${CODE_ONLY_NOTE}本表所有颜色均标为纯色——数据来源没有提供材质分类（哪些色号是珠光/夜光/透明），我们不做推测；如果你手里有特殊材质的豆，请在类别或色号层面手动排除。`,
        colorExpr: renderColors(
          spec.id,
          colors,
          hasChineseGroups ? (g) => g : () => '全部色号',
        ),
        headerLines: [
          `${spec.title}拼豆色卡。`,
          '',
          `数据来源：HansBug/pindou-color-data（MIT，快照 ${SNAPSHOT_DATE}），`,
          `  质量标注：${data.sourceQualities.join(', ')}`,
          ...(data.urls.length ? [`  原始出处 ${data.urls[0]}`] : []),
          '',
          `色系构成：${Object.entries(data.groups ?? {}).map(([g, n]) => `${g}(${n})`).join(', ')}`,
          '',
          '这个品牌没有颜色名，色号本身就是购买标识。',
          ...(spec.id === 'panpan' || spec.id === 'mixiaowo'
            ? [
                '',
                '注意：本表的色值序列与 MARD 色卡高度一致（同一份公开数据换了编号），',
                '因此它反映的是该公开数据源的口径，不一定等于品牌方现在的实际色卡。',
              ]
            : []),
          '',
          '数据来源未提供材质分类，本表所有颜色一律标为纯色，不做推测。',
        ],
      }),
    ),
  )
  console.log(`${spec.title}: ${colors.length} 色`)
}

console.log(`\n已生成 ${written.length} 个文件到 src/core/palette/data/`)
