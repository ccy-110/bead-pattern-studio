import type { Lab } from './types'

const DEG = Math.PI / 180
const POW25_7 = 6103515625 // 25^7

/**
 * CIE76 色差 —— 就是 Lab 空间的欧氏距离。
 *
 * 感知精度不如 CIEDE2000，但快 20 倍以上。用途是**粗筛**：
 * 先用它挑出最接近的若干个候选色，再用 CIEDE2000 精选。
 * 两者高度相关，粗筛几乎不会把真正的最近色排除掉。
 */
export function deltaE76(a: Lab, b: Lab): number {
  const dL = a.L - b.L
  const da = a.a - b.a
  const db = a.b - b.b
  return Math.sqrt(dL * dL + da * da + db * db)
}

/** 分量形式的 CIE76，供热路径直接调用，避免构造对象 */
export function deltaE76Raw(
  L1: number, a1: number, b1: number,
  L2: number, a2: number, b2: number,
): number {
  const dL = L1 - L2
  const da = a1 - a2
  const db = b1 - b2
  return Math.sqrt(dL * dL + da * da + db * db)
}

/** 色相角 h' = atan2(b, a')，归一化到 [0, 360) */
function hueAngle(b: number, ap: number): number {
  if (b === 0 && ap === 0) return 0
  const h = Math.atan2(b, ap) / DEG
  return h < 0 ? h + 360 : h
}

/**
 * CIEDE2000 色差（kL = kC = kH = 1）。
 *
 * 这是本项目的**颜色匹配判据**。相比 CIE76 它修正了三个已知缺陷：
 *  - 蓝色区域（短波长）的色差被高估 → 加 G 因子拉伸 a' 轴
 *  - 色相与彩度的交互作用 → 加 T 权重项
 *  - 蓝色区域的色相旋转 → 加 RT 旋转项
 *
 * 直观效果就是：深蓝不会再被错误地匹配成黑或灰。
 *
 * 实现遵循 Sharma, Wu & Dalal (2005) 的参考实现，
 * 测试用例取自该论文的 34 组标准数据（见 tests/color.test.ts）。
 */
export function ciede2000Raw(
  L1: number, a1: number, b1: number,
  L2: number, a2: number, b2: number,
): number {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1)
  const C2 = Math.sqrt(a2 * a2 + b2 * b2)
  const Cbar = (C1 + C2) / 2

  // G：针对蓝色区域（低彩度高色相角）的非线性补偿
  const Cbar7 = Math.pow(Cbar, 7)
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)))

  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2

  const C1p = Math.sqrt(a1p * a1p + b1 * b1)
  const C2p = Math.sqrt(a2p * a2p + b2 * b2)

  const h1p = hueAngle(b1, a1p)
  const h2p = hueAngle(b2, a2p)

  const dLp = L2 - L1
  const dCp = C2p - C1p

  // 色相差：必须走短弧，跨 0/360 时取另一侧
  let dhp: number
  if (C1p * C2p === 0) {
    dhp = 0
  } else {
    const diff = h2p - h1p
    if (Math.abs(diff) <= 180) dhp = diff
    else if (diff > 180) dhp = diff - 360
    else dhp = diff + 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG)

  const Lbarp = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2

  // 平均色相角，同样要做跨 0/360 的处理
  let hbarp: number
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p
  } else {
    const sum = h1p + h2p
    if (Math.abs(h1p - h2p) <= 180) hbarp = sum / 2
    else if (sum < 360) hbarp = (sum + 360) / 2
    else hbarp = (sum - 360) / 2
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG)

  // 蓝色区域的色相旋转项（"蓝色翻转"问题的修正）
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2))
  const Cbarp7 = Math.pow(Cbarp, 7)
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7))

  const dL50 = (Lbarp - 50) ** 2
  const SL = 1 + (0.015 * dL50) / Math.sqrt(20 + dL50)
  const SC = 1 + 0.045 * Cbarp
  const SH = 1 + 0.015 * Cbarp * T
  const RT = -Math.sin(2 * dTheta * DEG) * RC

  const tL = dLp / SL
  const tC = dCp / SC
  const tH = dHp / SH

  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH)
}

/** 对象形式的 CIEDE2000，便于非热路径调用 */
export function ciede2000(a: Lab, b: Lab): number {
  return ciede2000Raw(a.L, a.a, a.b, b.L, b.a, b.b)
}

/**
 * 明度差构成的下界。用于剪枝：CIEDE2000 的 L 项权重 SL ≥ 1，
 * 所以 |ΔL| 一定不大于真实 ΔE —— 若 |ΔL| 已超过当前最优解，可直接跳过该候选色。
 */
export function lightnessLowerBound(L1: number, L2: number): number {
  return Math.abs(L1 - L2)
}
