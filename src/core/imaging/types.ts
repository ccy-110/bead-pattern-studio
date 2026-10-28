/**
 * 位图数据。RGBA 四通道交错存储，与 `ImageData` 完全一致，
 * 因此可以在 `ImageData` 与它之间零拷贝互换。
 *
 * 注意 alpha 通道的语义在本项目里很重要：
 * **alpha < 阈值 = 不放豆子的空格**，而不是"半透明豆子"。
 * 拼豆没有透明度概念，透明区就是留空。
 */
export interface RasterImage {
  readonly width: number
  readonly height: number
  /** 长度 = width * height * 4，取值 0~255 */
  readonly data: Uint8ClampedArray
}

/** 从 ImageData 包装成 RasterImage（共享同一块底层缓冲，不复制） */
export function fromImageData(imageData: ImageData): RasterImage {
  return {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data,
  }
}

/** 分配到 ImageData（复制一份，避免共享缓冲被意外改写） */
export function toImageData(img: RasterImage): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
}

/** 新建一张全透明的图 */
export function createImage(width: number, height: number): {
  width: number
  height: number
  data: Uint8ClampedArray
} {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

/** 深拷贝 */
export function cloneImage(img: RasterImage): RasterImage {
  return {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data),
  }
}
