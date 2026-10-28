import { serializePattern } from '../pattern/serialize'
import type { Pattern, PatternGenerationParams } from '../pattern/types'
import { canvasToThumbnail, renderToCanvas } from './raster'

/**
 * 生成「工程文件」：`serializePattern` 的 JSON + 一张缩略图。
 *
 * 本地下载和云端保存必须产出**同一份东西** —— 否则会出现
 * "存到云端的图纸，下载下来打不开"或缩略图缺失这类只有用户才会发现的问题。
 * 所以两处都走这里，不要各自拼一遍。
 *
 * 缩略图只是锦上添花（文件管理器和云端列表里认得出是哪张图），
 * 生成失败时静默跳过，绝不能让保存本身失败。
 */
export function makeProjectFile(
  pattern: Pattern,
  generation?: PatternGenerationParams,
  thumbnailTargetWidth = 480,
): { text: string; thumbnail: string | undefined } {
  let thumbnail: string | undefined
  try {
    const canvas = renderToCanvas(pattern, {
      mode: 'color',
      showRuler: false,
      majorEvery: 0,
      showCode: false,
      targetWidth: thumbnailTargetWidth,
    })
    thumbnail = canvasToThumbnail(canvas) ?? undefined
  } catch {
    // 画布尺寸超限等极端情况：没有缩略图也能保存
  }

  const text = serializePattern(pattern, {
    ...(thumbnail !== undefined ? { thumbnail } : {}),
    ...(generation !== undefined ? { generation } : {}),
  })

  return { text, thumbnail }
}
