import { ciede2000Raw, deltaE76Raw, rgbToLabInto } from '../color'
import type { PaletteColor } from './types'

/**
 * 粗筛保留的候选数。
 *
 * 取 48 是**实测**出来的，不是拍的。曾经的注释写着「CIE76 的前 6 名几乎总是包含
 * CIEDE2000 的最近邻」——那句话是错的：拿全量 CIEDE2000 穷举做基准测下来，
 * K=6 时约 **3% 的查询会选到更差的颜色**，最差差 6.9 个 CIEDE2000 单位
 * （肉眼可辨的阈值约 1~2 个单位），而且 92 色的小色卡上同样会错，
 * 所以这从来不是「色卡变大才出现」的问题。
 *
 * 加宽粗筛几乎不花钱：扫描阶段遍历全部候选，本来就要为每个候选算一次 CIE76，
 * 增加 K 只多几次已经算过距离的候选的 CIEDE2000。实测 K=6 → 48 单价从
 * ~76µs 涨到 ~77µs，而 K 开到 48 时失配降到 0。相比之下**完全取消粗筛**
 * （全量 CIEDE2000 扫描）要 153µs，是它的两倍，所以粗筛仍然值得留。
 *
 * 这个常数由 `tests/matcher.test.ts` 的穷举比对守着：色卡若再变大到粗筛不够用，
 * 那个测试会失败，届时把这里调大即可。
 */
const PREFILTER_K = 48

/** 缓存条目上限，超过后停止写入缓存（只影响速度不影响正确性） */
const MAX_CACHE_ENTRIES = 1 << 17

/**
 * 色卡匹配器：把任意 sRGB 颜色映射到色卡中**真实存在**的某个颜色。
 *
 * 这是整个量化流程的核心部件。设计要点：
 *
 * 1. **候选集就是色卡本身**，不做自由聚类。绝不允许产生"色卡里不存在的颜色"——
 *    这是和 kmeans 方案的根本区别，也是图纸能照着买豆子的前提。
 *
 * 2. **CIE76 粗筛 + CIEDE2000 精选**。直接对全部色卡算 CIEDE2000 太慢
 *    （每个查询约 N 次三角运算），而 CIE76 只是几次乘加。两者高度相关，
 *    用 CIE76 选前 6 名再精算，结果与全量 CIEDE2000 几乎总是一致。
 *
 * 3. **结果缓存**。图纸里大片纯色区域会反复查询同一个颜色，
 *    缓存把重复查询降到近乎零成本。缓存键是精确的 24 位 RGB，
 *    因此结果**完全确定**——同一张图任何时候生成都完全一样，可复现。
 */
export class PaletteMatcher {
  readonly colors: readonly PaletteColor[]
  readonly size: number

  /** 拆分存储的 Lab 分量，避免热路径上访问对象属性 */
  private readonly labL: Float64Array
  private readonly labA: Float64Array
  private readonly labB: Float64Array

  /** 精确 RGB → 色卡下标。用 Map 而非定长数组是为了不损失精度。 */
  private readonly cache = new Map<number, number>()

  /** 粗筛用的临时缓冲，复用避免每次分配 */
  private readonly candIdx = new Int32Array(PREFILTER_K)
  private readonly candDist = new Float64Array(PREFILTER_K)

  /** Lab 转换的暂存区。单线程下复用安全，避免热路径上频繁分配小数组。 */
  private readonly scratch = new Float64Array(3)

  constructor(colors: readonly PaletteColor[]) {
    if (colors.length === 0) {
      throw new Error('色卡为空，无法进行颜色匹配')
    }
    this.colors = colors
    this.size = colors.length

    this.labL = new Float64Array(this.size)
    this.labA = new Float64Array(this.size)
    this.labB = new Float64Array(this.size)

    const scratch = new Float64Array(3)
    for (let i = 0; i < this.size; i++) {
      const rgb = colors[i]!.rgb
      rgbToLabInto(rgb[0], rgb[1], rgb[2], scratch, 0)
      this.labL[i] = scratch[0]!
      this.labA[i] = scratch[1]!
      this.labB[i] = scratch[2]!
    }
  }

  /**
   * 在 Lab 空间找最近色，返回色卡下标。
   *
   * 先用 CIE76 粗筛出 PREFILTER_K 个候选，再用 CIEDE2000 精选。
   */
  findNearestLab(L: number, a: number, b: number): number {
    // ---- 阶段一：CIE76 粗筛，维护一个大小为 K 的有序候选表 ----
    let filled = 0
    // 当前候选表里的最差距离，用于快速跳过
    let worst = Infinity

    for (let i = 0; i < this.size; i++) {
      const d = deltaE76Raw(L, a, b, this.labL[i]!, this.labA[i]!, this.labB[i]!)

      if (filled < PREFILTER_K) {
        // 插入排序：找到位置右移
        let j = filled - 1
        while (j >= 0 && this.candDist[j]! > d) {
          this.candDist[j + 1] = this.candDist[j]!
          this.candIdx[j + 1] = this.candIdx[j]!
          j--
        }
        this.candDist[j + 1] = d
        this.candIdx[j + 1] = i
        filled++
        if (filled === PREFILTER_K) worst = this.candDist[PREFILTER_K - 1]!
      } else if (d < worst) {
        let j = PREFILTER_K - 2
        while (j >= 0 && this.candDist[j]! > d) {
          this.candDist[j + 1] = this.candDist[j]!
          this.candIdx[j + 1] = this.candIdx[j]!
          j--
        }
        this.candDist[j + 1] = d
        this.candIdx[j + 1] = i
        worst = this.candDist[PREFILTER_K - 1]!
      }
    }

    // ---- 阶段二：候选表里用 CIEDE2000 精算 ----
    let bestIdx = this.candIdx[0]!
    let bestDist = Infinity

    for (let k = 0; k < filled; k++) {
      const i = this.candIdx[k]!
      const d = ciede2000Raw(L, a, b, this.labL[i]!, this.labA[i]!, this.labB[i]!)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }

    return bestIdx
  }

  /**
   * 按 sRGB 找最近色。带缓存。
   *
   * @returns 色卡下标
   */
  findNearest(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit

    rgbToLabInto(r, g, b, this.scratch, 0)
    const idx = this.findNearestLab(this.scratch[0]!, this.scratch[1]!, this.scratch[2]!)

    if (this.cache.size < MAX_CACHE_ENTRIES) {
      this.cache.set(key, idx)
    }
    return idx
  }

  /** 返回最近色本身，便于调试与展示 */
  findNearestColor(r: number, g: number, b: number): PaletteColor {
    return this.colors[this.findNearest(r, g, b)]!
  }

  /** 清空缓存。色卡变更后必须调用。 */
  clearCache(): void {
    this.cache.clear()
  }

  /** 仅供测试/诊断：当前缓存条目数 */
  get cacheSize(): number {
    return this.cache.size
  }
}
