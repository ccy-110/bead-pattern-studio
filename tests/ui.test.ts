// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import App from '../src/App.vue'
import AccountPanel from '../src/components/AccountPanel.vue'
import EditPanel from '../src/components/EditPanel.vue'
import ExportPanel from '../src/components/ExportPanel.vue'
import PalettePanel from '../src/components/PalettePanel.vue'
import SizePanel from '../src/components/SizePanel.vue'
import SourcePanel from '../src/components/SourcePanel.vue'
import StatsPanel from '../src/components/StatsPanel.vue'
import { createImage } from '../src/core/imaging/types'
import { toPatternColor } from '../src/core/pattern/types'
import type { Pattern } from '../src/core/pattern/types'
import { PALETTES } from '../src/core/palette'
import type { PaletteColor } from '../src/core/palette/types'
import { cloud } from '../src/stores/cloud'
import {
  brushColorId,
  pattern,
  resetHistory,
  sourceImage,
  state,
  tool,
} from '../src/stores/project'
import { view } from '../src/stores/view'

/**
 * 界面挂载测试。
 *
 * 界面的"好不好看"没法自动化，但"能不能跑起来"可以 ——
 * 而且这正是最容易出问题的地方：模板里引用了不存在的字段、
 * 组件 props 对不上、setup 里访问了空值。这些问题构建期不一定报，
 * 打开页面就是一片白屏。这里把每个面板都挂一遍，白屏就变成一条失败的测试。
 */

// happy-dom 没有实现 ResizeObserver，画布组件要用
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

function paletteColor(code: string, hex: string): PaletteColor {
  return { id: `test.${code}`, code, name: code, hex, rgb: [0, 0, 0], kind: 'solid' }
}

const RED = toPatternColor(paletteColor('T01', '#ff0000'))
const BLUE = toPatternColor(paletteColor('T02', '#0000ff'))

function makePattern(): Pattern {
  return {
    rows: 3,
    cols: 4,
    beadSizeMm: 5,
    colors: [RED, BLUE],
    // 红蓝相间，留一个空格
    grid: Int16Array.from([0, 1, 0, 1, 1, 0, 1, 0, 0, 1, -1, 0]),
    title: '测试图纸',
  }
}

beforeEach(() => {
  pattern.value = makePattern()
  resetHistory()
  state.error = null
  state.busy = 'idle'
  state.fileName = ''
  sourceImage.value = null
  state.workingWidth = 0
  state.workingHeight = 0
  state.bgEnabled = false
  state.excludedIds = []
  state.activeKinds = ['solid']
  state.title = '测试图纸'
  tool.value = 'brush'
  brushColorId.value = null

  // 真实流程里 state 的行列数总是跟着图纸一起写。
  // 两边不一致在这里会直接暴露成尺寸面板显示怪数字，所以要一起设。
  state.rows = pattern.value.rows
  state.cols = pattern.value.cols

  // view 是模块级单例，测试之间会互相污染 ——
  // 比如某条测试关掉了分页，后面的测试就会看到"已关闭"
  view.paginate = true
  view.showRuler = true
  view.showGrid = true
  view.showCode = true
  view.printScale = 1.5
})

afterEach(() => {
  pattern.value = null
  sourceImage.value = null
})

/** 造一张 100×100 的空白工作图，让"有原图"的分支能跑起来 */
function withSourceImage(): void {
  sourceImage.value = createImage(100, 100)
  state.fileName = 'a.png'
  state.workingWidth = 100
  state.workingHeight = 100
}

describe('应用外壳', () => {
  it('没有图和图纸时挂载成功，并给出引导', () => {
    pattern.value = null
    const wrapper = mount(App)

    expect(wrapper.find('.app').exists()).toBe(true)
    expect(wrapper.text()).toContain('把图片拖进来')

    wrapper.unmount()
  })

  it('有图纸时三个栏位都在，画布取代空状态', async () => {
    const wrapper = mount(App)
    await nextTick()

    expect(wrapper.find('.panel-left').exists()).toBe(true)
    expect(wrapper.find('.stage').exists()).toBe(true)
    expect(wrapper.find('.panel-right').exists()).toBe(true)
    expect(wrapper.find('.pattern-canvas').exists()).toBe(true)
    expect(wrapper.find('.stage-empty').exists()).toBe(false)

    wrapper.unmount()
  })

  it('顶栏显示格数与底板数', async () => {
    const wrapper = mount(App)
    await nextTick()

    // 4×3 格，29 格底板 → 1 块
    expect(wrapper.find('.stage-bar').text()).toContain('4×3 格')
    expect(wrapper.find('.stage-bar').text()).toContain('1 块底板')

    wrapper.unmount()
  })

  it('出错时显示可关闭的提示条', async () => {
    state.error = '图片解码失败'
    const wrapper = mount(App)
    await nextTick()

    const banner = wrapper.find('.banner-danger')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('图片解码失败')

    await banner.find('.banner-close').trigger('click')
    expect(state.error).toBeNull()
    expect(wrapper.find('.banner-danger').exists()).toBe(false)

    wrapper.unmount()
  })

  it('没有图纸时右侧工具面板给出空状态而不是报错', () => {
    pattern.value = null
    const wrapper = mount(EditPanel, { props: { hover: null } })

    expect(wrapper.text()).toContain('生成图纸后')
    wrapper.unmount()
  })
})

describe('面板', () => {
  it('源图面板：没有图时只显示选择入口', () => {
    const wrapper = mount(SourcePanel, { props: { picking: false } })

    expect(wrapper.text()).toContain('选择图片')
    // 影调、背景、裁剪都要等有图之后才有意义
    expect(wrapper.text()).not.toContain('亮度')
    expect(wrapper.text()).not.toContain('抠掉背景')

    wrapper.unmount()
  })

  it('源图面板：有原图后才出现影调与抠图', () => {
    withSourceImage()
    const wrapper = mount(SourcePanel, { props: { picking: false } })

    expect(wrapper.text()).toContain('亮度')
    expect(wrapper.text()).toContain('对比度')
    expect(wrapper.text()).toContain('抠掉背景')

    wrapper.unmount()
  })

  it('源图面板：吸管按钮把状态抛给上层', async () => {
    withSourceImage()
    state.bgEnabled = true

    const wrapper = mount(SourcePanel, { props: { picking: false } })
    const pick = wrapper.findAll('button').find((b) => b.text().includes('吸管指定'))
    expect(pick, '找不到吸管按钮').toBeTruthy()

    await pick!.trigger('click')
    expect(wrapper.emitted('pick')).toHaveLength(1)

    wrapper.unmount()
  })

  it('源图面板：抠图关闭时不显示容差，避免用户调一个不生效的滑块', async () => {
    withSourceImage()
    state.bgEnabled = false

    const wrapper = mount(SourcePanel, { props: { picking: false } })
    expect(wrapper.text()).not.toContain('容差')

    state.bgEnabled = true
    await nextTick()
    expect(wrapper.text()).toContain('容差')

    wrapper.unmount()
  })

  it('尺寸面板：显示格数、厘米数与底板数', () => {
    const wrapper = mount(SizePanel)

    const text = wrapper.text()
    expect(text).toContain('豆子规格')
    expect(text).toContain('格数')
    expect(text).toContain('底板')
    // 4 格 × 5mm = 20 毫米
    expect(text).toContain('20 毫米')
    expect(text).toContain('1 块')

    wrapper.unmount()
  })

  it('尺寸面板：改格数会写回状态', async () => {
    const wrapper = mount(SizePanel)
    const widthInput = wrapper.findAll('input[type="number"]')[0]!

    await widthInput.setValue('12')
    expect(state.cols).toBe(12)

    wrapper.unmount()
  })

  it('账号面板：未登录时是登录/注册表单，且不会自动发请求', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    cloud.user = null
    cloud.status = 'ready'
    cloud.patterns = []
    cloud.error = null
    cloud.notice = null

    const wrapper = mount(AccountPanel)

    expect(wrapper.text()).toContain('账号')
    expect(wrapper.text()).toContain('邮箱')
    expect(wrapper.text()).toContain('密码')
    expect(wrapper.text()).toContain('登录')
    expect(wrapper.text()).toContain('没有账号？注册')
    // 挂载就发请求的话，所有 mount(App) 的测试都会去连一个不存在的后端
    expect(fetchSpy).not.toHaveBeenCalled()

    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('账号面板：填表点登录会走通接口并进入已登录状态', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/login')) {
        return new Response(JSON.stringify({ user: { id: 'u1', email: 'me@example.com' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ patterns: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    cloud.user = null
    cloud.status = 'ready'
    cloud.patterns = []
    cloud.error = null
    cloud.notice = null

    const wrapper = mount(AccountPanel)
    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('me@example.com')
    await inputs[1]!.setValue('correct-horse-1')

    const loginButton = wrapper.findAll('button').find((b) => b.text() === '登录')!
    await loginButton.trigger('click')
    await flushPromises()

    // 用 toMatchObject 而不是读属性：前面刚把 cloud.user 设成 null，
    // TS 的控制流会把它的类型收窄成 never
    expect(cloud.user).toMatchObject({ email: 'me@example.com' })
    expect(fetchMock).toHaveBeenCalled()

    wrapper.unmount()
    cloud.user = null
    vi.unstubAllGlobals()
  })

  it('账号面板：后端连不上时提示云端不可用，但本地功能不受影响', () => {
    cloud.user = null
    cloud.status = 'offline'
    cloud.patterns = []
    cloud.error = null
    cloud.notice = null

    const wrapper = mount(AccountPanel)
    expect(wrapper.text()).toContain('云端功能不可用')

    wrapper.unmount()
    cloud.status = 'ready'
  })

  it('账号面板：登录后列出云端图纸并给出操作', () => {
    cloud.user = { id: 'u1', email: 'me@example.com' }
    cloud.status = 'ready'
    cloud.patterns = [
      {
        id: 'p1',
        title: '我的猫',
        rows: 30,
        cols: 20,
        thumbnail: null,
        shared: true,
        updatedAt: Date.now(),
      },
    ]
    cloud.error = null
    cloud.notice = null

    const wrapper = mount(AccountPanel)

    expect(wrapper.text()).toContain('me@example.com')
    expect(wrapper.text()).toContain('我的猫')
    expect(wrapper.text()).toContain('20×30')
    expect(wrapper.text()).toContain('已分享')
    expect(wrapper.text()).toContain('打开')
    expect(wrapper.text()).toContain('关闭分享')
    expect(wrapper.text()).toContain('删除')

    wrapper.unmount()
    cloud.user = null
    cloud.patterns = []
  })

  it('配色面板：列出色卡、类别，并报出可用色数', () => {
    const wrapper = mount(PalettePanel)

    expect(wrapper.text()).toContain('色卡')
    expect(wrapper.text()).toContain('颜色类别')
    expect(wrapper.text()).toContain('纯色')
    // 默认色卡是 MARD 221，默认只开纯色，而它 221 色全是纯色
    expect(wrapper.text()).toContain('221 色可用')

    wrapper.unmount()
  })

  it('配色面板：色卡下拉列出全部内置色卡，默认选中 MARD 221', () => {
    const wrapper = mount(PalettePanel)

    const select = wrapper.find('select.palette-select')
    const options = select.findAll('option')

    expect(options.length).toBe(PALETTES.length)
    expect(PALETTES.length).toBeGreaterThanOrEqual(9)
    expect((select.element as HTMLSelectElement).value).toBe('mard221')
    // 选项上带色数，用户能直接看出「这套我买不买得起」
    expect(options[0]!.text()).toContain('221 色')

    wrapper.unmount()
  })

  it('配色面板：取消勾选纯色会明确拦住用户，而不是静默产出空图纸', async () => {
    const wrapper = mount(PalettePanel)

    const solid = wrapper.findAll('.kind-chip').find((c) => c.text().includes('纯色'))!
    await solid.trigger('click')

    expect(state.activeKinds).not.toContain('solid')
    expect(wrapper.text()).toContain('一个颜色类别都没启用')

    wrapper.unmount()
  })

  it('配色面板：点击色块可以标记为「我没有这个色」', async () => {
    const wrapper = mount(PalettePanel)
    const first = wrapper.find('.color-swatch')

    await first.trigger('click')
    expect(state.excludedIds).toHaveLength(1)

    await first.trigger('click')
    expect(state.excludedIds).toHaveLength(0)

    wrapper.unmount()
  })

  it('用量面板：列出每种颜色的颗数与包数', () => {
    const wrapper = mount(StatsPanel)

    const text = wrapper.text()
    expect(text).toContain('T01')
    expect(text).toContain('T02')
    expect(text).toContain('颗')
    expect(text).toContain('成品尺寸')
    expect(text).toContain('占格率')

    wrapper.unmount()
  })

  it('用量面板：点一行把它设为画笔颜色，再点一次取消', async () => {
    const wrapper = mount(StatsPanel)
    // 第一行是用得最多的颜色
    const row = wrapper.find('tbody tr')

    expect(brushColorId.value).toBeNull()
    await row.trigger('click')
    expect(brushColorId.value).toBeTruthy()
    expect(row.classes()).toContain('picked')

    await row.trigger('click')
    expect(brushColorId.value).toBeNull()

    wrapper.unmount()
  })

  it('输出面板：有图纸时才放开导出按钮', () => {
    const withPattern = mount(ExportPanel)
    const enabled = withPattern
      .findAll('button')
      .filter((b) => ['PNG', 'SVG', '打印', '保存图纸'].includes(b.text()))
    expect(enabled).toHaveLength(4)
    expect(enabled.every((b) => !b.attributes('disabled'))).toBe(true)
    withPattern.unmount()

    pattern.value = null
    const without = mount(ExportPanel)
    const disabled = without
      .findAll('button')
      .filter((b) => ['PNG', 'SVG', '打印', '保存图纸'].includes(b.text()))
    expect(disabled.every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    without.unmount()
  })

  it('输出面板：小图纸提示一页放得下，分页默认开着', () => {
    const wrapper = mount(ExportPanel)

    expect(wrapper.text()).toContain('一页放得下')
    const toggle = wrapper.findAll('button').find((b) => b.text() === '已开启')
    expect(toggle, '没找到分页开关').toBeTruthy()
    expect(toggle!.classes()).toContain('active')
    // 放得下的时候不该吓唬用户
    expect(wrapper.find('.field-hint.warn').exists()).toBe(false)

    wrapper.unmount()
  })

  it('输出面板：大图纸算出页数，关掉分页会明确警告尺寸会不对', async () => {
    // 100×100 在 5 毫米豆、1.5 倍下，一张 A4 只能放下 23×34 格
    pattern.value = {
      ...makePattern(),
      rows: 100,
      cols: 100,
      grid: new Int16Array(100 * 100).fill(0),
    }
    state.rows = 100
    state.cols = 100

    const wrapper = mount(ExportPanel)
    await nextTick()

    // 每页 23 列 34 行，重叠 1 → 列分 5 段（0/22/44/66/88）、行分 3 段（0/33/66）
    expect(wrapper.text()).toContain('共 15 页')
    expect(wrapper.find('.field-hint.warn').exists()).toBe(false)

    // 关掉分页后必须明确说出后果，而不是默默压成一页
    const toggle = wrapper.findAll('button').find((b) => b.text() === '已开启')!
    await toggle.trigger('click')

    expect(wrapper.find('.field-hint.warn').exists()).toBe(true)
    expect(wrapper.text()).toContain('对不上')

    wrapper.unmount()
  })

  it('编辑面板：显示位置与颜色信息，空格也说得明白', () => {
    const wrapper = mount(EditPanel, { props: { hover: { row: 2, col: 2 } } })

    // 第 3 行第 3 列是 -1
    expect(wrapper.text()).toContain('第 3 行')
    expect(wrapper.text()).toContain('第 3 列')
    expect(wrapper.text()).toContain('空格')

    wrapper.unmount()
  })

  it('编辑面板：列出图纸里实际用到的颜色当画笔', () => {
    const wrapper = mount(EditPanel, { props: { hover: null } })
    const swatches = wrapper.findAll('.color-swatch')

    // 只有 T01、T02 两种颜色，不该把整个色卡都铺出来
    expect(swatches.length).toBe(2)
    expect(swatches[0]!.attributes('title')).toContain('T01')

    wrapper.unmount()
  })
})
