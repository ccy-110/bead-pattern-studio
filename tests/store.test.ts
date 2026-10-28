import { beforeEach, describe, expect, it } from 'vitest'

import { toPatternColor } from '../src/core/pattern/types'
import type { Pattern } from '../src/core/pattern/types'
import type { PaletteColor } from '../src/core/palette/types'
import {
  beginStroke,
  brushColorId,
  buildParams,
  canRedo,
  canUndo,
  endStroke,
  fillCells,
  gridVersion,
  paintCell,
  pattern,
  redo,
  resetHistory,
  setCells,
  setLockAspect,
  setPalette,
  sourceImage,
  state,
  tool,
  undo,
  undoLabel,
} from '../src/stores/project'
import type { RasterImage } from '../src/core/imaging/types'
import { DEFAULT_PALETTE_ID, getPalette } from '../src/core/palette'

/**
 * 编辑历史的测试。
 *
 * 这套逻辑（拖动涂色、撤销、参数改动的合并）没法靠肉眼确认 ——
 * 界面上按一次 Ctrl+Z 看起来"变了"，但用户真正在意的是它退回到哪一步、
 * 以及网格和参数有没有一起退回去。这里用真实的调用序列把它钉住。
 */

function paletteColor(code: string, hex: string): PaletteColor {
  return {
    id: `test.${code}`,
    code,
    name: code,
    hex,
    rgb: [0, 0, 0],
    kind: 'solid',
  }
}

const RED = toPatternColor(paletteColor('T01', '#ff0000'))
const BLUE = toPatternColor(paletteColor('T02', '#0000ff'))

function makePattern(rows: number, cols: number): Pattern {
  return {
    rows,
    cols,
    beadSizeMm: 5,
    colors: [RED, BLUE],
    grid: Int16Array.from({ length: rows * cols }, () => -1),
    title: '测试',
  }
}

beforeEach(() => {
  pattern.value = makePattern(4, 4)
  gridVersion.value = 0
  resetHistory()
  tool.value = 'brush'
  brushColorId.value = RED.id
  state.rows = 4
  state.cols = 4
  state.lockAspect = false
  state.sizeDriver = 'cols'
  // 宽高比取自裁剪区；置 1 让尺寸换算在测试里可预期
  state.workingWidth = 100
  state.workingHeight = 100
  state.crop = null
})

/** 模拟一次拖动涂抹：按下 → 涂若干格 → 抬起 */
function stroke(cells: [number, number][]): void {
  beginStroke()
  for (const [r, c] of cells) paintCell(r, c)
  endStroke()
}

describe('涂抹与撤销', () => {
  it('整笔只记一步 —— 涂了 8 格也只需要撤销一次', () => {
    stroke([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ])

    expect(pattern.value!.grid[0]).toBe(0)

    undo()

    // 整笔一起退回去
    expect(pattern.value!.grid.every((v) => v === -1)).toBe(true)
    expect(canUndo.value).toBe(false)
  })

  it('两笔是两个撤销步骤', () => {
    stroke([[0, 0]])
    stroke([[1, 1]])

    undo()
    expect(pattern.value!.grid[0]).toBe(0) // 第一笔还在
    expect(pattern.value!.grid[5]).toBe(-1) // 第二笔退掉了

    undo()
    expect(pattern.value!.grid[0]).toBe(-1)

    expect(canUndo.value).toBe(false)
  })

  it('撤销后可以重做，且重做的是同一笔', () => {
    stroke([
      [0, 0],
      [0, 1],
    ])
    undo()
    expect(canRedo.value).toBe(true)

    redo()
    expect(pattern.value!.grid[0]).toBe(0)
    expect(pattern.value!.grid[1]).toBe(0)
    expect(canRedo.value).toBe(false)
  })

  it('撤销之后再涂一笔会清空重做栈 —— 编辑器的通行语义', () => {
    stroke([[0, 0]])
    stroke([[1, 1]])
    undo()
    expect(canRedo.value).toBe(true)

    stroke([[2, 2]])
    expect(canRedo.value).toBe(false)
  })

  it('没有历史时撤销/重做是安全的空操作', () => {
    expect(canUndo.value).toBe(false)
    expect(() => {
      undo()
      redo()
      undo()
    }).not.toThrow()
    expect(pattern.value!.grid.every((v) => v === -1)).toBe(true)
  })

  it('擦除也能撤销回上色状态', () => {
    stroke([[0, 0]])
    tool.value = 'erase'
    stroke([[0, 0]])
    expect(pattern.value!.grid[0]).toBe(-1)

    undo()
    expect(pattern.value!.grid[0]).toBe(0)
  })

  it('填充是一步，不是每格一步', () => {
    tool.value = 'fill'
    beginStroke()
    fillCells(0, 0)
    endStroke()

    expect(pattern.value!.grid.every((v) => v === 0)).toBe(true)

    undo()
    expect(pattern.value!.grid.every((v) => v === -1)).toBe(true)
    expect(canUndo.value).toBe(false)
  })

  it('涂色后新颜色会进入图纸的颜色表，撤销能把颜色表一起还原', () => {
    // 换成图纸颜色表里没有的颜色：应先被追加进去
    brushColorId.value = 'test.T99'
    // 候选集里没有 T99，所以这次涂抹应该什么都没发生
    stroke([[0, 0]])
    expect(pattern.value!.grid[0]).toBe(-1)
    expect(pattern.value!.colors.length).toBe(2)
  })
})

describe('参数改动的撤销', () => {
  it('改尺寸后撤销，行列数和网格一起退回 —— 不能只退一半', () => {
    stroke([
      [0, 0],
      [1, 1],
    ])
    const before = Array.from(pattern.value!.grid)

    setCells('cols', 8)
    expect(state.cols).toBe(8)

    undo()

    expect(state.cols).toBe(4)
    expect(state.rows).toBe(4)
    expect(pattern.value!.cols).toBe(4)
    expect(Array.from(pattern.value!.grid)).toEqual(before)
  })

  it('锁比例时改宽会带着高一起变，撤销一并退回', () => {
    state.lockAspect = true
    setLockAspect(true)

    setCells('cols', 12)
    expect(state.cols).toBe(12)
    expect(state.rows).toBe(12) // 100×100 的裁剪区，宽高比 1

    undo()
    expect(state.cols).toBe(4)
    expect(state.rows).toBe(4)
  })

  it('拖动滑块式的连续同类改动合并成一步', () => {
    setCells('cols', 5)
    setCells('cols', 6)
    setCells('cols', 7)

    expect(state.cols).toBe(7)
    expect(canUndo.value).toBe(true)

    undo()

    // 一次就退回到拖动之前的 4，而不是退到 5 或 6
    expect(state.cols).toBe(4)
    expect(canUndo.value).toBe(false)
  })

  it('撤销标签说明将要退回哪一步', () => {
    expect(undoLabel.value).toBe('')

    setCells('rows', 9)
    expect(undoLabel.value).toBe('改变尺寸')
  })

  it('撤销再重做，回到撤销前的参数', () => {
    setCells('cols', 9)
    undo()
    expect(state.cols).toBe(4)

    redo()
    expect(state.cols).toBe(9)
  })
})

describe('传给 Worker 的参数', () => {
  function makeImage(width: number, height: number): RasterImage {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) }
  }

  /**
   * 这些状态全都"动过"，是复现那个 bug 的前提。
   *
   * `state.crop` 和 `state.bgReference` 初始是 null，而 `buildParams` 对 null
   * 走的是构造新对象的分支 —— 所以**刚打开页面时转换是好的**，
   * 必须等用户动过裁剪框/指定过背景色之后，参数里才会开始出现响应式代理。
   * 测试里必须显式把这些字段填上，否则测的是那条本来就没问题的路径。
   */
  function dirtyState(): void {
    sourceImage.value = makeImage(100, 100)
    state.crop = { x: 10, y: 10, width: 50, height: 50 }
    state.bgReference = [255, 255, 255]
    state.bgEnabled = true
    state.adjustments.brightness = 12
    state.adjustments.saturation = -8
  }

  beforeEach(() => {
    sourceImage.value = null
    state.bgReference = null
    state.bgEnabled = false
    state.excludedIds = []
    state.activeKinds = ['solid']
    state.adjustments.brightness = 0
    state.adjustments.saturation = 0
  })

  it('可以被结构化克隆 —— 送进 Worker 的参数里不能有响应式代理', () => {
    dirtyState()

    const params = buildParams()
    expect(params).not.toBeNull()

    // 这是关键断言。Worker 的 postMessage 底层就是结构化克隆，
    // 而 Vue 的 reactive 代理克隆不了 —— 真跑一次比读代码可靠得多。
    expect(() => structuredClone(params)).not.toThrow()
  })

  it('嵌套对象是拷贝出来的普通对象，不是 state 里那个引用', () => {
    dirtyState()

    const params = buildParams()!

    // 直接传引用（哪怕内容一样）就会把 Proxy 递出去 —— 内容断言查不出这个，
    // 必须比引用
    expect(params.crop).not.toBe(state.crop)
    expect(params.adjustments).not.toBe(state.adjustments)
    expect(params.backgroundReference).not.toBe(state.bgReference)
  })

  it('拷贝出来的值仍然是正确的', () => {
    dirtyState()

    const params = buildParams()!

    expect(params.crop).toEqual({ x: 10, y: 10, width: 50, height: 50 })
    expect(params.adjustments).toEqual({ brightness: 12, contrast: 0, saturation: -8 })
    expect(params.backgroundReference).toEqual([255, 255, 255])
    expect(params.backgroundTolerance).toBe(state.bgTolerance)
    expect(params.colors.length).toBeGreaterThan(0)
  })

  it('没裁剪时用整张图，且同样可以克隆', () => {
    sourceImage.value = makeImage(100, 100)
    state.crop = null

    const params = buildParams()!

    expect(params.crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(() => structuredClone(params)).not.toThrow()
    // 没指定背景色时应该是 null，而不是 [0,0,0] —— 后者会被当成"背景是黑色"
    expect(params.backgroundReference).toBeNull()
  })

  it('关闭抠图时容差传 null，而不是留着上次的值', () => {
    dirtyState()
    state.bgEnabled = false

    expect(buildParams()!.backgroundTolerance).toBeNull()
  })

  it('没有图或没有候选色时返回 null —— 调用方据此放弃这次请求', () => {
    expect(buildParams()).toBeNull()

    sourceImage.value = makeImage(10, 10)
    expect(buildParams()).not.toBeNull()

    // 一个颜色都不启用，量化器无解可求
    state.excludedIds = candidateColorIds()
    expect(buildParams()).toBeNull()
  })
})

/** 当前色卡的全部颜色 id，用来构造"全被排除"的极端情况 */
function candidateColorIds(): string[] {
  return getPalette(DEFAULT_PALETTE_ID).colors.map((c) => c.id)
}

describe('切换色卡', () => {
  beforeEach(() => {
    state.paletteId = DEFAULT_PALETTE_ID
    state.activeKinds = ['solid']
    state.excludedIds = []
    resetHistory()
  })

  it('切换后清空手动排除项 —— 各色卡的色号体系不通用', () => {
    state.excludedIds = candidateColorIds()
    setPalette('perler')
    expect(state.paletteId).toBe('perler')
    expect(state.excludedIds).toEqual([])
  })

  it('丢掉新色卡上不存在的颜色类别', () => {
    // MARD 291 有温变/光变，别的色卡没有。不清掉的话界面上那个 chip 消失了，
    // 过滤条件却还在，用户看到的可用色数会比他自己数出来的少
    state.paletteId = 'mard291'
    state.activeKinds = ['solid', 'pearl', 'thermo', 'uv']

    setPalette('hama')

    expect(state.activeKinds).toEqual(['solid', 'pearl'])
  })

  it('新色卡一个类别都对不上时兜底为纯色，而不是留一个空候选集', () => {
    state.paletteId = 'mard291'
    state.activeKinds = ['thermo']

    setPalette('perler')

    // Perler 表里没有温变色；兜底成纯色，否则用户会拿到一张全空的图纸
    expect(state.activeKinds).toEqual(['solid'])
  })

  it('切回同一张色卡是空操作，不产生撤销步骤', () => {
    expect(canUndo.value).toBe(false)
    setPalette(DEFAULT_PALETTE_ID)
    expect(canUndo.value).toBe(false)
  })
})

describe('历史深度', () => {
  it('超出上限时丢弃最早的一步，而不是无限增长', () => {
    // 上限 60：做 70 笔之后只留最近 60 步
    for (let i = 0; i < 70; i++) {
      stroke([[i % 4, (i / 4) | 0]])
    }

    let steps = 0
    while (canUndo.value) {
      undo()
      steps++
      if (steps > 200) break
    }
    expect(steps).toBe(60)
  })

  it('没有图纸时不会产生历史 —— 那时没什么可还原的', () => {
    pattern.value = null
    resetHistory()

    beginStroke()
    paintCell(0, 0)
    endStroke()
    setCells('cols', 9)

    expect(canUndo.value).toBe(false)
  })
})
