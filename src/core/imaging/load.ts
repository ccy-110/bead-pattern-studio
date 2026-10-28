import { cloneImage, fromImageData } from './types'
import type { RasterImage } from './types'

/**
 * 工作图的最大边长。
 *
 * 原图可能高达 4000×3000（1200 万像素），而最终的网格最多也就几百乘几百。
 * 先降采样到 1600px 再处理，有四个好处：
 *  - 处理量降到 1/5 以下，量化能在一瞬间完成
 *  - 抹掉 JPEG 压缩噪点，主色采样不会在噪声上抖动
 *  - 内存占用可控（1600×1600×4 ≈ 10MB）
 *  - 效果上完全没有损失 —— 1600px 的源图分到 200 格，每格仍有 8×8 个采样点
 *
 * 注意这里是"降采样"而不是"缩到网格大小"：真正的取色发生在 sampleRegion，
 * 那里才是决定成品质量的地方。
 */
export const WORKING_MAX_DIM = 1600

export interface LoadedImage {
  /** 降采样后的工作图，后续所有处理（调色/抠图/量化）都基于它 */
  readonly working: RasterImage
  readonly originalWidth: number
  readonly originalHeight: number
  readonly fileName: string
}

/** 在 Worker 与主线程都能用的 canvas 创建 */
function createCanvas(
  w: number,
  h: number,
): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h)
  }
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function get2d(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d', {
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!ctx) throw new Error('无法创建 2D 画布上下文')
  return ctx
}

/**
 * 把任意图片源画到画布上并取出像素。
 * 走浏览器原生的重采样实现，质量和速度都优于手写插值。
 */
function rasterize(
  source: CanvasImageSource,
  w: number,
  h: number,
): RasterImage {
  const canvas = createCanvas(w, h)
  const ctx = get2d(canvas)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(source, 0, 0, w, h)
  return fromImageData(ctx.getImageData(0, 0, w, h))
}

/**
 * 读取用户选择的图片文件。
 *
 * 会自动按 EXIF 方向摆正（手机竖拍的照片否则会躺倒），
 * 并在超过 WORKING_MAX_DIM 时做高质量降采样。
 */
export async function loadImageFile(
  file: File,
  maxDim: number = WORKING_MAX_DIM,
): Promise<LoadedImage> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('无法解析该图片文件，请确认是有效的 JPG / PNG / WebP 图片')
  }

  const originalWidth = bitmap.width
  const originalHeight = bitmap.height

  const scale = Math.min(1, maxDim / Math.max(originalWidth, originalHeight))
  const w = Math.max(1, Math.round(originalWidth * scale))
  const h = Math.max(1, Math.round(originalHeight * scale))

  let working: RasterImage
  if (w === originalWidth && h === originalHeight) {
    working = rasterize(bitmap, w, h)
  } else {
    // 交给浏览器做高质量重采样，比先 drawImage 再缩放效果好
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    })
    working = rasterize(resized, w, h)
    resized.close()
  }
  bitmap.close()

  return {
    working,
    originalWidth,
    originalHeight,
    fileName: file.name,
  }
}

/** 从 ImageBitmap / 图片 URL 载入（拖拽粘贴、示例图等场景） */
export async function loadFromSource(
  source: Blob | ImageBitmap,
  fileName = 'image',
  maxDim: number = WORKING_MAX_DIM,
): Promise<LoadedImage> {
  const bitmap =
    source instanceof ImageBitmap
      ? source
      : await createImageBitmap(source, { imageOrientation: 'from-image' })

  const originalWidth = bitmap.width
  const originalHeight = bitmap.height

  const scale = Math.min(1, maxDim / Math.max(originalWidth, originalHeight))
  const w = Math.max(1, Math.round(originalWidth * scale))
  const h = Math.max(1, Math.round(originalHeight * scale))

  const working =
    w === originalWidth && h === originalHeight
      ? rasterize(bitmap, w, h)
      : rasterize(
          await createImageBitmap(bitmap, {
            resizeWidth: w,
            resizeHeight: h,
            resizeQuality: 'high',
          }),
          w,
          h,
        )

  bitmap.close()
  return { working, originalWidth, originalHeight, fileName }
}

/**
 * 裁剪。矩形按工作图的像素坐标给出，越界部分自动裁掉。
 */
export function cropImage(
  img: RasterImage,
  x: number,
  y: number,
  width: number,
  height: number,
): RasterImage {
  const x0 = Math.max(0, Math.min(img.width, Math.round(x)))
  const y0 = Math.max(0, Math.min(img.height, Math.round(y)))
  const w = Math.max(1, Math.min(img.width - x0, Math.round(width)))
  const h = Math.max(1, Math.min(img.height - y0, Math.round(height)))

  const out = new Uint8ClampedArray(w * h * 4)
  const src = img.data
  const srcStride = img.width * 4
  const dstStride = w * 4

  for (let row = 0; row < h; row++) {
    const from = (y0 + row) * srcStride + x0 * 4
    out.set(src.subarray(from, from + dstStride), row * dstStride)
  }

  return { width: w, height: h, data: out }
}

/**
 * 把工作图渲染成可直接放进 `ctx.putImageData` 的 ImageData，
 * 用于预览显示。
 */
export function toPreviewImageData(img: RasterImage): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
}

/**
 * 预览用的降采样。
 *
 * 不用 canvas 的 drawImage：Worker 里 OffscreenCanvas 的支持面还不齐，
 * 而且每次滑滑块都新建一块画布代价偏高。这里手写面积加权（box filter），
 * 对任意缩放比都正确。
 *
 * **必须按预乘 alpha 平均。** 抠图后背景像素是 (0,0,0,0)，
 * 直接对 RGB 求平均会把主体的边缘往黑色带，预览图会出现一圈脏边；
 * 先乘 alpha 再平均、最后除回去，才能得到正确的边缘。
 */
export function downscaleImage(img: RasterImage, maxDim: number): RasterImage {
  const { width: sw, height: sh, data: src } = img
  const scale = Math.min(1, maxDim / Math.max(sw, sh))
  if (scale >= 1) return cloneImage(img)

  const dw = Math.max(1, Math.round(sw * scale))
  const dh = Math.max(1, Math.round(sh * scale))

  const out = new Uint8ClampedArray(dw * dh * 4)
  const xRatio = sw / dw
  const yRatio = sh / dh

  for (let dy = 0; dy < dh; dy++) {
    const sy0 = dy * yRatio
    const sy1 = (dy + 1) * yRatio
    const iy0 = Math.floor(sy0)
    const iy1 = Math.min(sh, Math.ceil(sy1))

    for (let dx = 0; dx < dw; dx++) {
      const sx0 = dx * xRatio
      const sx1 = (dx + 1) * xRatio
      const ix0 = Math.floor(sx0)
      const ix1 = Math.min(sw, Math.ceil(sx1))

      let pr = 0
      let pg = 0
      let pb = 0
      let alphaSum = 0
      let weightSum = 0

      for (let y = iy0; y < iy1; y++) {
        // 该源行落在目标像素内的纵向重叠长度
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0)
        if (wy <= 0) continue
        const rowOff = y * sw

        for (let x = ix0; x < ix1; x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0)
          if (wx <= 0) continue

          const w = wx * wy
          const o = (rowOff + x) << 2
          const a = src[o + 3]!

          pr += src[o]! * a * w
          pg += src[o + 1]! * a * w
          pb += src[o + 2]! * a * w
          alphaSum += a * w
          weightSum += w
        }
      }

      const o = (dy * dw + dx) << 2
      if (alphaSum > 1e-6) {
        out[o] = pr / alphaSum
        out[o + 1] = pg / alphaSum
        out[o + 2] = pb / alphaSum
      }
      out[o + 3] = weightSum > 0 ? alphaSum / weightSum : 0
    }
  }

  return { width: dw, height: dh, data: out }
}
