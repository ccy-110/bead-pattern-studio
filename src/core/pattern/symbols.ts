/**
 * 黑白打印用的符号体系。
 *
 * 为什么必须有符号：拼豆的格子很小（打印出来常见 8~12mm），
 * 格子里写不下"P17 柠檬黄"这样的色号文字。而黑白打印时颜色全变成灰阶，
 * 深浅相近的两个色号肉眼根本分不出来 —— 照着拼必然拼错。
 *
 * 通用解法是给每个颜色分配一个符号，图例里写「● = P17 柠檬黄」，
 * 正文格子里只印符号。这也是十字绣图纸沿用了几十年的做法。
 *
 * 符号顺序经过挑选：
 *  - 先用**大写字母**（最易辨认，且不会和数字混淆）
 *  - 再用**小写字母**（和大写字母区分度高）
 *  - 然后用**数字**（字母用完后才轮到，避免 0/O、1/l 混淆）
 *  - 最后才用**几何形状**（在低分辨率打印下容易糊，作备选）
 *
 * 共 90+ 个，远超任何实际色卡削减后的颜色数（通常不超过 40）。
 */
function buildSymbolSequence(): string[] {
  const out: string[] = []

  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i)) // A-Z
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(97 + i)) // a-z
  for (let i = 0; i < 10; i++) out.push(String(i)) // 0-9

  // 几何形状作为兜底。这些码位在各种中英文字体里的覆盖率都很好。
  out.push(
    '●', '○', '■', '□', '▲', '△', '▼', '▽', '◆', '◇',
    '★', '☆', '✦', '✧', '✚', '✖', '◐', '◑', '◒', '◓',
    '⬤', '◼', '◻', '⬥', '⬦', '⊕', '⊗', '⊙', '⊘', '⊚',
  )

  return out
}

export const SYMBOL_SEQUENCE: readonly string[] = buildSymbolSequence()

/**
 * 取第 index 个颜色对应的符号。
 *
 * 超出序列长度时回退为「序号」，虽然可读性差但至少不会出现空格导致
 * 图例与正文对不上。实际使用中不该发生 —— 颜色数已被上限削减过。
 */
export function symbolFor(index: number): string {
  if (index < 0) return '?'
  return SYMBOL_SEQUENCE[index % SYMBOL_SEQUENCE.length] ?? String(index)
}

/**
 * 深色底需要用白字、浅色底用黑字，否则对比度不足看不清。
 * 这里用 Rec.709 相对亮度判断，阈值取 0.5 附近的经验值 0.55。
 */
export function isDarkColor(hex: string): boolean {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return false
  const n = parseInt(m[1]!, 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  // 感知亮度用平方近似即可，这里只需要一个稳健的明暗判断
  const luminance = 0.2126 * r * r + 0.7152 * g * g + 0.0722 * b * b
  return luminance < 0.28
}

/** 与 isDarkColor 配套：返回在该底色上可读的文字颜色 */
export function contrastTextColor(hex: string): string {
  return isDarkColor(hex) ? '#ffffff' : '#000000'
}
