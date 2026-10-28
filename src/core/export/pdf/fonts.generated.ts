/**
 * 由 scripts/gen-pdf-font.mjs 生成，**不要手改**。
 * 改动请改脚本里的 LABELS / GEOMETRIC_SYMBOLS 后重跑。
 *
 * 字体来源：Noto Sans SC / Noto Sans Symbols 2 / Noto Sans Math
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
  appName: '拼豆图纸工坊',
  defaultTitle: '拼豆图纸',
  denseHint: '图案较密时，请放大 PDF 以清晰查看格内标注。',
  symbolHint: '格内标注是图纸格子里印的内容：色号放得下就印色号，放不下就印符号，符号与下表一一对应。',
  colorDisclaimer: '色值为屏幕参考值，不等同实物；买豆对色请以手中实物色卡为准。',
  brandLine: '适配品牌：{name}',
  gridLine: '网格尺寸：{w} × {h} 格',
  totalLine: '总计：{n} 颗',
  finishedLine: '成品约 {w} × {h} 毫米',
  boardLine: '底板 {across} × {down} = {total} 块（{size} × {size}）',
  colorListWithCount: '颜色购物清单（{n}）',
  purchaseLine: '备货 {n}',
  sizeLine: '{w} × {h} 格',
  pageCaption: '第 {n} / {total} 页　行 {r1}–{r2} · 列 {c1}–{c2}',
} as const

export type PdfLabelKey = keyof typeof PDF_LABELS

export const PDF_FONTS = {
  cjk: {
    family: 'Noto Sans SC',
    upem: 1000,
    ascent: 1160,
    descent: -288,
    capHeight: 812,
    bbox: [-264, -1048, 2928, 1808] as const,
    /** `码点:GID:字宽`（十六进制码点）的空格分隔表，运行时解析一次。
     *  用码点而不是字符，是因为表里就有空格字符，直接写会被分隔符切碎 */
    glyphs: '20:1:224 21:2:323 22:3:474 23:4:555 24:5:555 25:6:921 26:7:680 27:8:278 28:9:338 29:10:338 2A:11:467 2B:12:555 2C:13:278 2D:14:347 2E:15:278 2F:16:392 30:17:555 31:18:555 32:19:555 33:20:555 34:21:555 35:22:555 36:23:555 37:24:555 38:25:555 39:26:555 3A:27:278 3B:28:278 3C:29:555 3D:30:555 3E:31:555 3F:32:474 40:33:946 41:34:608 42:35:657 43:36:638 44:37:688 45:38:589 46:39:552 47:40:689 48:41:728 49:42:293 4A:43:535 4B:44:646 4C:45:543 4D:46:812 4E:47:723 4F:48:742 50:49:633 51:50:742 52:51:635 53:52:596 54:53:599 55:54:721 56:55:575 57:56:878 58:57:573 59:58:531 5A:59:603 5B:60:338 5C:61:392 5D:62:338 5E:63:555 5F:64:559 60:65:606 61:66:563 62:67:618 63:68:510 64:69:620 65:70:554 66:71:325 67:72:564 68:73:607 69:74:275 6A:75:275 6B:76:552 6C:77:284 6D:78:926 6E:79:610 6F:80:606 70:81:620 71:82:620 72:83:388 73:84:468 74:85:377 75:86:607 76:87:521 77:88:802 78:89:498 79:90:521 7A:91:475 7B:92:338 7C:93:270 7D:94:338 7E:95:555 A1:96:323 A2:97:555 A3:98:555 A4:99:555 A5:100:555 A6:101:270 A7:102:1000 A8:103:606 A9:104:832 AA:105:386 AB:106:479 AC:107:555 AE:108:473 AF:109:606 B0:110:370 B1:111:1000 B2:112:411 B3:113:411 B4:114:606 B5:115:628 B6:116:1000 B7:192:1000 B8:117:606 B9:118:411 BA:119:407 BB:120:479 BC:121:873 BD:122:903 BE:123:889 BF:124:474 C0:125:608 C1:126:608 C2:127:608 C3:128:608 C4:129:608 C5:130:608 C6:131:918 C7:132:638 C8:133:589 C9:134:589 CA:135:589 CB:136:589 CC:137:293 CD:138:293 CE:139:293 CF:140:293 D0:141:712 D1:142:723 D2:143:742 D3:144:742 D4:145:742 D5:146:742 D6:147:742 D7:148:1000 D8:149:742 D9:150:721 DA:151:721 DB:152:721 DC:153:721 DD:154:531 DE:155:652 DF:156:643 E0:157:563 E1:158:563 E2:159:563 E3:160:563 E4:161:563 E5:162:563 E6:163:877 E7:164:510 E8:165:554 E9:166:554 EA:167:554 EB:168:554 EC:169:275 ED:170:275 EE:171:275 EF:172:275 F0:173:608 F1:174:610 F2:175:606 F3:176:606 F4:177:606 F5:178:606 F6:179:606 F7:180:1000 F8:181:606 F9:182:607 FA:183:607 FB:184:607 FC:185:607 FD:186:521 FE:187:620 FF:188:521 2013:189:536 3000:190:1000 3002:191:1000 4E00:193:1000 4E0B:194:1000 4E0D:195:1000 4E0E:196:1000 4E2D:197:1000 4E39:198:1000 4E3A:199:1000 4E70:200:1000 4EE5:201:1000 503C:202:1000 5168:203:1000 5185:204:1000 51C6:205:1000 5217:206:1000 5355:207:1000 5361:208:1000 5370:209:1000 53C2:210:1000 53F7:211:1000 540C:212:1000 54AA:213:1000 54C1:214:1000 56FD:215:1000 56FE:216:1000 574A:217:1000 5757:218:1000 5907:219:1000 5927:220:1000 5957:221:1000 5B50:222:1000 5B9E:223:1000 5BB6:224:1000 5BB9:225:1000 5BC6:226:1000 5BF8:227:1000 5BF9:228:1000 5C0F:229:1000 5C31:230:1000 5C3A:231:1000 5C4F:232:1000 5DE5:233:1000 5E55:234:1000 5E94:235:1000 5E95:236:1000 5F97:237:1000 603B:238:1000 6210:239:1000 624B:240:1000 62FC:241:1000 653E:242:1000 65F6:243:1000 662F:244:1000 6670:245:1000 677F:246:1000 67E5:247:1000 6807:248:1000 683C:249:1000 6848:250:1000 6BEB:251:1000 6CE8:252:1000 6E05:253:1000 6F2B:254:1000 724C:255:1000 7269:256:1000 7684:257:1000 76FC:258:1000 770B:259:1000 7A9D:260:1000 7B26:261:1000 7B2C:262:1000 7B49:263:1000 7C73:264:1000 7CFB:265:1000 7EA6:266:1000 7EB8:267:1000 7F51:268:1000 7F8E:269:1000 8003:270:1000 8272:271:1000 884C:272:1000 8868:273:1000 88C5:274:1000 8BA1:275:1000 8BF7:276:1000 8C46:277:1000 8D27:278:1000 8D2D:279:1000 8F83:280:1000 9002:281:1000 914D:282:1000 91CC:283:1000 9875:284:1000 9897:285:1000 989C:286:1000 9EA6:287:1000 FF08:299:1000 FF09:300:1000 FF0C:301:1000 FF1A:304:1000 FF1B:305:1000',
  },
  symbols: {
    family: 'Noto Sans Symbols 2',
    upem: 1000,
    ascent: 1069,
    descent: -630,
    capHeight: 748,
    bbox: [-493, -422, 1791, 1069] as const,
    /** `码点:GID:字宽`（十六进制码点）的空格分隔表，运行时解析一次。
     *  用码点而不是字符，是因为表里就有空格字符，直接写会被分隔符切碎 */
    glyphs: '2299:1:894 25A0:10:834 25A1:11:834 25B2:14:907 25B3:16:907 25BC:15:907 25BD:17:907 25C6:8:1109 25C7:9:1109 25CB:3:894 25CF:2:894 25D0:4:894 25D1:5:894 25D2:6:894 25D3:7:894 25FB:12:710 25FC:13:710 2605:18:960 2606:19:1034 2716:21:846 271A:20:836 2726:22:870 2727:23:870 2B24:24:1114 2B25:25:847 2B26:26:847',
  },
  math: {
    family: 'Noto Sans Math',
    upem: 1000,
    ascent: 1069,
    descent: -423,
    capHeight: 748,
    bbox: [-354, -420, 1695, 1069] as const,
    /** `码点:GID:字宽`（十六进制码点）的空格分隔表，运行时解析一次。
     *  用码点而不是字符，是因为表里就有空格字符，直接写会被分隔符切碎 */
    glyphs: '2295:3:741 2297:2:741 2298:1:928 229A:5:928',
  },
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
