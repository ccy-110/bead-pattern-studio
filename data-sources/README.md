# 内置色卡的数据来源

本目录是 `src/core/palette/data/*.ts` 里色卡数据的**原始快照**，由
`scripts/gen-palettes.mjs` 读取并生成 TS 文件。保留快照是为了让数据可复现、
可审计、日后能增量更新；本目录**不参与构建**，不会被 import 进应用。

## 快照日期

2026-09-19

## 来源仓库

### 1. [HansBug/pindou-color-data](https://github.com/HansBug/pindou-color-data)

国内拼豆色卡数据仓库，MIT 许可（见 `LICENSE-pindou-color-data`）。
每个数据集都带 `sources` 字段标注来源质量，取值包括 `official_pdf`（厂方
RGB PDF）、`official_chart_image`（厂方色卡图）、`official_chart_image_sampled`
（从色卡图采样）、`third_party_public_repository`（第三方公开仓库）、
`public_tool_display_hex`（工具站屏幕值）。

| 文件 | 内容 | 来源质量 |
|---|---|---|
| `pindou-color-data/mard-221-alfonse-doudou.json` | MARD 221（Alfonse + 豆豆工坊核对版） | 第三方公开仓库 |
| `pindou-color-data/mard-221-github.json` | MARD 221（公开源码库版） | 第三方公开仓库 |
| `pindou-color-data/mard-291-github.json` | MARD 291（含 70 个扩展色） | 第三方公开仓库 |
| `pindou-color-data/coco-291.json` | COCO 291 | 第三方公开仓库 |
| `pindou-color-data/manman-278.json` | 漫漫家 278 | 第三方公开仓库 |
| `pindou-color-data/panpan-289.json` | 盼盼家 289 | 第三方公开仓库 |
| `pindou-color-data/mixiaowo-290.json` | 咪小窝 290 | 第三方公开仓库 |

### 2. [maxcleme/beadcolors](https://github.com/maxcleme/beadcolors)

国际拼豆色号汇总仓库，MIT 许可（见 `LICENSE-beadcolors`）。CSV 格式为
`参考色号,名称,红,绿,蓝,贡献者`，色值来自玩家社区实物拍照取色。

| 文件 | 内容 |
|---|---|
| `beadcolors/hama.csv` | Hama 92 色（H01–H119，有跳号） |
| `beadcolors/perler.csv` | Perler 103 色（`80-19001` 形式的物料号） |
| `beadcolors/artkal_s.csv` | Artkal S 系列 199 色（5mm 规格） |
| `beadcolors/mard.csv` | MARD 291（**第三个独立来源**，用于交叉验证） |

## 字体

`fonts/` 是 `scripts/gen-pdf-font.mjs` 下载的**源字体缓存**（Noto Sans SC /
Noto Sans Symbols 2 / Noto Sans Math，均为 OFL 许可）。它们只用于**构建期**子集化，
不进应用产物；子集化后的产物在 `src/assets/fonts/`（三个 TTF 共约 68 KB + OFL 许可全文）。
这个缓存目录可以安全删除，重新生成时会再下载一次。

## 数据口径与已知限制

- **所有色值都是屏幕参考值，不是厂商公布的 sRGB**，也不等于实物颜色。
  塑料豆受批次、模具、染色与光线影响，同一色号不同批次可能有肉眼可见差异。
  买豆对色请以手中实物色卡为准，软件内可对单个颜色重新校准。
- **MARD 没有颜色名**。所有数据源（含声称来自官方 PDF 的）`name` 字段就是色号
  本身，1688 商家也按「A1 一包」销售。因此 MARD 色卡的 `name` 直接填色号，
  界面靠 `displayName()` 避免重复显示。
- **来源之间存在分歧**。`scripts/gen-palettes.mjs` 会把 MARD 的 221 个共用色号
  在四个来源之间逐色比对，差异写进生成文件的表头注释。
- **COCO / 漫漫 / 盼盼 / 咪小窝 没有材质分类数据**，来源是单一第三方仓库，
  因此这些色卡的颜色一律标为纯色。其中盼盼和咪小窝的色值序列与 MARD 完全相同
  （同一份数据换了编号），请知悉其数据独立性有限。
- **特殊系列的材质判定**：MARD 按系列字母（P 珠光 / Q 温变 / R 果冻 / T 透明 /
  Y 夜光 / ZG 光变，有三处独立来源佐证）；其余品牌按来源里的**真实英文名关键词**
  判定（Glow / Pearl / Transparent / Translucent / Clear / Neon / Fluorescent /
  Metallic / Gold / Silver / Bronze / Glitter / Sparkle），不靠推测。
