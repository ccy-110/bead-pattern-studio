import type { RGB } from '../color/types'
import { cloneImage } from './types'
import type { RasterImage } from './types'

/**
 * 背景模型：**背景是什么颜色**，以及**边缘有多大比例能被这几个颜色解释掉**。
 *
 * ## 为什么参考色是"一组"而不是"一个"
 *
 * 只用边缘众数那一个颜色时，天空+地面、墙面+桌面这类**两色背景必然有一半扣不掉**，
 * 而且调容差救不回来 —— 两色的通道差（实测 165）远大于任何可用的容差，
 * 调大到能盖住它的时候，主体已经被啃掉一大块了。所以这里从边缘直方图里
 * 贪心取最多 3 个色簇，各自作为参考色。
 */
export interface BackgroundModel {
  /** 主参考色（占比最大的色簇）。界面显示和吸管初值都用它。 */
  reference: RGB
  /** 全部参考色，含主参考色。单色背景时长度为 1。 */
  references: RGB[]
  /**
   * 边缘像素中落在已接受色簇里的比例，0~1。
   * 纯色背景接近 1；背景越花越低，界面据此提示用户手动指定背景色。
   */
  confidence: number
  /**
   * 背景本身的粗糙度：**沿边缘方向**相邻像素差的高分位。
   *
   * 这是"多大的一步还算平滑"的基准。取沿边缘方向而不是垂直方向，
   * 是因为沿边方向的相邻像素必定都是背景 —— 主体压在画面边缘时，
   * 垂直方向的邻居已经落在主体上了，算出来的是主体内部的边缘，不是背景噪声。
   *
   * 不用容差参数，因此这个值可以跟着模型一起缓存，拖动容差滑块时保持恒定。
   */
  roughness: number
}

/** 最多取几个参考色。天地山三色已属罕见，再多就开始把主体当成背景了。 */
const MAX_REFERENCES = 3

/**
 * 除主色簇外，一个色簇至少要占边缘像素的这个比例才算背景。
 *
 * 门槛用来挡"主体压在画面边缘"：人物出画时肩膀会占掉一截边缘，
 * 若把它的颜色也当成背景色，主体就会从贴边处被整块啃掉。
 * 取 1/4 是因为两色背景（天地、墙地）各占约一半，留出余量。
 */
const MIN_CLUSTER_SHARE = 0.25

/** 两个色簇的均值差超过这个值才算不同的背景色，否则只是被直方图切开的同一色。 */
const CLUSTER_SEPARATION = 24

/**
 * 测粗糙度时取的分位。用 85 分位而不是最大值，是为了不被个别脏点/压缩块拉高；
 * 也不用中位数，因为中位数会把"背景有轻微纹理"这种真实存在的粗糙判成 0。
 */
const ROUGHNESS_PERCENTILE = 0.85

/** 粗糙度的上限。再高说明边缘上根本没有可用的背景，多给只会更容易啃到主体。 */
const ROUGHNESS_CAP = 14

/** 分量差的最大值。本项目判定颜色远近一律用它，与容差滑块的语义保持一致。 */
function maxChannelDiff(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

/**
 * 从图像边缘推断背景模型。
 *
 * 做法是对边缘像素做 5 位精度的直方图，反复取**剩余像素**中的众数色簇，
 * 再对该桶内的像素取均值以恢复精度。用众数而不是均值，是因为主体常常压在边缘上
 * （人物肩膀、贴边构图），均值会被主体颜色带偏，众数则始终指向"占比最大的那个颜色"。
 *
 * 主色簇无条件接受（它就是边缘上最主要的颜色，没有更好的候选）；
 * 后续色簇必须够大（见 MIN_CLUSTER_SHARE）才被接受。
 *
 * 注意这里**不需要容差参数**：模型只描述"边缘上有哪几种背景色"，
 * 至于一个像素离参考色多远还算背景，是 removeBackground 的事。
 * 这样模型可以跨容差调整缓存复用，拖动滑块时结果才是单调变化的。
 */
export function analyzeBackground(img: RasterImage): BackgroundModel {
  const { width: w, height: h, data } = img
  const BUCKETS = 32 * 32 * 32

  // 先把边缘像素的下标收集起来，避免后面反复遍历四条边。
  // 分配量取一个宽松上界：正常尺寸下精确值是 2w+2h-4，多分配几个无害，
  // 但 1 像素宽/高的退化图必须留有冗余，否则会写到数组外面。
  const border = new Int32Array(2 * w + 2 * h + 4)
  let bn = 0
  const collect = (x: number, y: number) => {
    const o = (y * w + x) << 2
    if (data[o + 3]! < 8) return // 本来就透明的像素不参与统计
    border[bn++] = o
  }
  for (let x = 0; x < w; x++) {
    collect(x, 0)
    collect(x, h - 1)
  }
  for (let y = 1; y < h - 1; y++) {
    collect(0, y)
    if (w > 1) collect(w - 1, y) // w === 1 时该像素已被上面的循环收过，避免重复计数
  }

  if (bn === 0) {
    const white: RGB = [255, 255, 255]
    return { reference: white, references: [white], confidence: 0, roughness: 0 }
  }

  // 沿边缘方向测粗糙度：差值只有 0~255，用 256 格直方图取分位，不必排序
  const diffs = new Int32Array(256)
  const diffAt = (a: number, b: number) => {
    diffs[
      Math.max(
        Math.abs(data[a]! - data[b]!),
        Math.abs(data[a + 1]! - data[b + 1]!),
        Math.abs(data[a + 2]! - data[b + 2]!),
      )
    ]!++
  }
  for (let x = 0; x < w - 1; x++) {
    diffAt(x << 2, (x + 1) << 2) // 上边
    diffAt((h - 1) * w * 4 + (x << 2), (h - 1) * w * 4 + ((x + 1) << 2)) // 下边
  }
  for (let y = 0; y < h - 1; y++) {
    diffAt(y * w * 4, (y + 1) * w * 4) // 左边
    diffAt(y * w * 4 + (w - 1) * 4, (y + 1) * w * 4 + (w - 1) * 4) // 右边
  }
  let roughness = 0
  {
    // 沿边缘的相邻对总数；每条边各 w-1 / h-1 对，共两条横向、两条纵向
    const pairs = 2 * (w - 1) + 2 * (h - 1)
    let acc = 0
    const target = pairs * ROUGHNESS_PERCENTILE
    for (let v = 0; v < 256; v++) {
      acc += diffs[v]!
      if (acc >= target) {
        roughness = Math.min(ROUGHNESS_CAP, v)
        break
      }
    }
  }

  const bucketOf = (o: number): number =>
    ((data[o]! >> 3) << 10) | ((data[o + 1]! >> 3) << 5) | (data[o + 2]! >> 3)

  const assigned = new Uint8Array(bn)
  const counts = new Int32Array(BUCKETS)
  const references: RGB[] = []
  let covered = 0

  for (let round = 0; round < MAX_REFERENCES; round++) {
    // 找剩余像素里最大的桶。每轮都重算：上一轮已经归属的像素不能再参与。
    counts.fill(0)
    let bestBucket = -1
    let bestCount = 0
    for (let i = 0; i < bn; i++) {
      if (assigned[i]) continue
      const b = bucketOf(border[i]!)
      const c = (counts[b] = counts[b]! + 1)
      if (c > bestCount) {
        bestCount = c
        bestBucket = b
      }
    }
    if (bestBucket < 0) break
    // 主色簇无条件接受，其余必须够大
    if (round > 0 && bestCount < bn * MIN_CLUSTER_SHARE) break

    // 对该桶内的像素取均值，恢复被 5 位量化丢掉的精度
    let sr = 0
    let sg = 0
    let sb = 0
    let n = 0
    for (let i = 0; i < bn; i++) {
      if (assigned[i]) continue
      const o = border[i]!
      if (bucketOf(o) !== bestBucket) continue
      sr += data[o]!
      sg += data[o + 1]!
      sb += data[o + 2]!
      n++
    }
    if (n === 0) break

    const mean: RGB = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)]

    // 无论最终是否新增参考色，这个桶的像素都算"已被解释" —— 否则下一轮还会选中它
    for (let i = 0; i < bn; i++) {
      if (!assigned[i] && bucketOf(border[i]!) === bestBucket) assigned[i] = 1
    }
    covered += n

    // 与已有参考色太近的，只是同一色的另一条量化桶，不必重复计入
    if (references.some((r) => maxChannelDiff(r, mean) <= CLUSTER_SEPARATION)) continue
    references.push(mean)
  }

  if (references.length === 0) references.push([255, 255, 255])

  return {
    reference: references[0]!,
    references,
    confidence: covered / bn,
    roughness,
  }
}

/** 把吸管取到的单个颜色包成模型。用户明确指了背景色，就只认它，不再自动扩展。 */
export function backgroundModelFrom(reference: RGB): BackgroundModel {
  // 粗糙度按 0 处理：用户亲手点的背景色，不该因为"边缘看起来不干净"就放宽边缘判据
  return { reference, references: [reference], confidence: 1, roughness: 0 }
}

export interface BackgroundOptions {
  /**
   * 背景模型。用户在图上点选吸管时用 backgroundModelFrom 包成单色模型。
   *
   * 模型由调用方传入而不是在里面自己分析，是为了让**预览和全分辨率量化共用同一份结果**。
   * 曾经让这个函数在缺省参数时各自分析一次，两次结果可能不一致，
   * 用户就会看到"预览里背景抠掉了、成品里还在"这种没法解释的现象。
   */
  model: BackgroundModel
  /**
   * 容差 0~255，按**最大通道差**衡量，是界面上唯一的抠图滑块。
   * 白底图一般 20~40 就够；JPEG 压缩产物边缘有杂色，可以调到 50 左右。
   */
  tolerance: number
}

/**
 * 去背景（抠图）。
 *
 * ## 关键设计一：从边缘出发的泛洪填充
 *
 * 而不是"颜色接近就删掉"的全局阈值。如果只是简单地把所有接近白色的像素设为透明，
 * 那么人物眼睛里的高光、牙齿、白衣服上的白点会被一起抠掉，出现一个个透明窟窿。
 * 泛洪填充只删除**与图像边缘连通的**背景区域，主体内部的白色因为被主体颜色包围、
 * 与边缘不连通，会被完整保留。
 *
 * ## 关键设计二：边缘检测（这是"渐变背景扣不干净"的解药）
 *
 * 只看颜色相似度是不够的，而且**调容差救不回来**：
 * 背景从白渐变到浅灰时，容差要开到能盖住整段渐变的程度，主体早就被啃掉一大块了；
 * 容差开小则渐变远端整片留下。实测一张 47% 背景残留的图，在任何容差下都至少残留 19%。
 *
 * 症结在于"颜色偏离参考色"这一个信号同时对应两件相反的事：
 * 背景自己在缓慢渐变（应该继续蔓延），或者跨过了主体的边界（应该立刻停）。
 * 加入**相邻像素的差**就能把它们分开：
 *
 * - 渐变背景每步只差一两个色阶 —— 步长小，继续蔓延；
 * - 主体边界是一道几十上百的台阶 —— 步长超阈值，判定为"边"，停止蔓延。
 *
 * 这就是边缘检测，只是**不必单独跑一遍索贝尔之类的算子**：
 * 边缘强度本来就是相邻像素的差，在扩张时顺手算即可，而且只对真正访问到的像素算，
 * 比预先给整张图算一遍梯度图更省。
 *
 * 判据有两条，满足其一即归入背景：
 *
 * 1. 离最近参考色不超过 `near`：基本就是背景色，**即使隔着一条边也扣掉** ——
 *    背景上的折痕、脏点、细线靠它处理；
 * 2. 相邻步长不超过 `maxStep` **且**离最近参考色不超过 `maxDrift`：从旁边的背景像素
 *    平滑走过来的，允许背景色沿路缓慢变化（渐变、暗角都靠它）。
 *
 * 第 2 条里的**步长上限就是边缘检测**：跨过主体的边界时，相邻两像素的差会远大于它。
 * 这个上限由背景粗糙度与容差共同决定，所以界面上仍然只需要一个滑块。
 *
 * @returns 新图，不修改入参
 */
export function removeBackground(img: RasterImage, opts: BackgroundOptions): RasterImage {
  const out = cloneImage(img)
  const { width: w, height: h, data } = out
  const tol = Math.max(0, Math.min(255, opts.tolerance))
  const { references } = opts.model
  if (references.length === 0) return out

  /**
   * 基本就是背景色的门限。取容差的 1/3：容差本来是"可以接受到多远"，
   * 而这里要问的是"近到能不能无视边缘"，标准自然该更严。
   * 容差为 0 时退化成"只有一模一样才算"，与滑块的直觉一致。
   */
  const near = Math.floor(tol / 3)

  /**
   * 多大的一步还算"平滑" —— **整个边缘检测的核心参数**，也是保护主体的那一道闸。
   *
   * 它必须**由坡度主导**，而不是由"偏离参考色多远"主导。这两件事在数值上会撞车：
   * 浅灰主体（210 左右）与纯白背景相差 45，而渐变背景从纯白走到浅灰实测也就差 50~65 ——
   * 总偏离量完全分不开它们。能分开的是**走完这段距离用了多长**：
   *
   * - 背景渐变：一个色阶要走上百像素，每步差 0.1~0.7；
   * - 柔边主体：45 的落差挤在几个像素里，每步差 10 以上。
   *
   * 差一个数量级，阈值卡在中间即可。这里用**背景自身的粗糙度**当地板：
   * 干净图上地板约 2（柔边主体一律挡住），有噪声的图上抬高（否则噪声会把蔓延掐断，
   * 渐变远端又会留下来）。抬高的幅度取"与粗糙度相当"而不是更高：
   * 噪声是随机的，四个邻居里总有一条路能走，没必要把阈值抬到噪声峰值之上。
   *
   * 容差只贡献一小部分权重（`tol * 0.25`）：容差开大时用户要的是更激进，
   * 但**不该激进到把主体啃掉**，所以坡度上限的移动幅度远小于容差本身的幅度。
   */
  const base = Math.min(ROUGHNESS_CAP, 2 + opts.model.roughness)
  const maxStep = Math.min(30, base + tol * 0.25)

  /**
   * 允许沿路径偏离参考色多远。
   *
   * 这一条管的是**另一类**残留：深色投影、暗角。它们每步都很平缓（坡度只有三五个色阶），
   * 卡住它们的是"最深处离背景色有多远"—— 实测一张半透明投影最深处离纯白 127，
   * 上限给 96 时投影核心就会整块留下（残留 16%）。
   *
   * 所以它比容差宽得多（5 倍），代价是"颜色接近背景 + 边缘柔和"的主体更容易被走过去；
   * 但那种情况真正的闸门是上面的坡度上限，不是这一条，所以放宽它并不额外牺牲主体。
   */
  const maxDrift = Math.min(160, tol * 5)

  const n = references.length
  const refR = new Int32Array(n)
  const refG = new Int32Array(n)
  const refB = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const c = references[i]!
    refR[i] = c[0]
    refG[i] = c[1]
    refB[i] = c[2]
  }

  /** 到**最近**参考色的最大通道差。已经落进 near 就不必再算其余参考色了。 */
  const distToRefs = (o: number): number => {
    const r = data[o]!
    const g = data[o + 1]!
    const b = data[o + 2]!
    let best = 255
    for (let i = 0; i < n; i++) {
      const d = Math.max(
        Math.abs(r - refR[i]!),
        Math.abs(g - refG[i]!),
        Math.abs(b - refB[i]!),
      )
      if (d < best) {
        best = d
        if (best <= near) break
      }
    }
    return best
  }

  // 显式栈。递归会在大图上爆栈，必须用迭代。
  // 容量取 w*h 就够 —— 入队时立刻把 alpha 置 0 作标记，同一个像素不会被重复压栈。
  const stack = new Int32Array(w * h)
  let sp = 0

  /**
   * 入队，并**在这里就把 alpha 清零当作"已入队"标记**，因此每个像素最多进栈一次。
   *
   * 早先的写法是出队时才清零，于是同一像素会被 4 个邻居各压一次，
   * 栈深度最坏能到 4·w·h，而数组只开了 w·h。越界的写入会被类型化数组静默丢掉，
   * 接着 `pop` 出来的是空槽，`p << 2` 变成 0，行为完全不可预测。
   *
   * RGB 要留到出队时再清：判断邻居的步长需要它。
   */
  const enqueue = (q: number): void => {
    data[(q << 2) + 3] = 0
    stack[sp++] = q
  }

  const tryNeighbor = (x: number, y: number, cr: number, cg: number, cb: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const q = y * w + x
    const o = q << 2
    if (data[o + 3]! === 0) return // 已入队，或本来就是透明像素

    const d = distToRefs(o)
    if (d > near) {
      // 不是"基本就是背景色"，那就必须是从旁边平滑走过来的
      const r = data[o]!
      const g = data[o + 1]!
      const b = data[o + 2]!
      const step = Math.max(Math.abs(r - cr), Math.abs(g - cg), Math.abs(b - cb))
      if (step > maxStep || d > maxDrift) return
    }
    enqueue(q)
  }

  // 种子：四条边上与参考色足够接近的像素。
  // 用容差而不是 near：种子是蔓延的入口，标准该最宽；否则低容差下可能一个种子都没有。
  const seed = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const q = y * w + x
    const o = q << 2
    if (data[o + 3]! === 0) return
    if (distToRefs(o) <= tol) enqueue(q)
  }
  for (let x = 0; x < w; x++) {
    seed(x, 0)
    seed(x, h - 1)
  }
  for (let y = 1; y < h - 1; y++) {
    seed(0, y)
    seed(w - 1, y)
  }

  while (sp > 0) {
    const p = stack[--sp]!
    const o = p << 2

    // 出队时才清 RGB：判断邻居步长要用它，清早了步长恒为 0、边缘检测就失效了。
    // 清零而不只是置 alpha，是因为后续做区域平均时残留颜色会污染降采样结果。
    const cr = data[o]!
    const cg = data[o + 1]!
    const cb = data[o + 2]!
    data[o] = 0
    data[o + 1] = 0
    data[o + 2] = 0

    const x = p % w
    const y = (p / w) | 0
    tryNeighbor(x - 1, y, cr, cg, cb)
    tryNeighbor(x + 1, y, cr, cg, cb)
    tryNeighbor(x, y - 1, cr, cg, cb)
    tryNeighbor(x, y + 1, cr, cg, cb)
  }

  return out
}

/**
 * 反转抠图：把已经是透明的区域当作"要保留"，其余全透明。
 * 用于用户抠反了的情况，以及"只保留背景"这种少见但真实的需求。
 */
export function invertAlpha(img: RasterImage): RasterImage {
  const out = cloneImage(img)
  const data = out.data
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3]! === 0) {
      data[o] = 255
      data[o + 1] = 255
      data[o + 2] = 255
      data[o + 3] = 255
    } else {
      data[o] = 0
      data[o + 1] = 0
      data[o + 2] = 0
      data[o + 3] = 0
    }
  }
  return out
}
