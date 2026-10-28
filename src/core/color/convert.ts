import type { Lab, RGB } from './types'

/** CIE XYZ（D65） */
export interface XYZ {
  readonly X: number
  readonly Y: number
  readonly Z: number
}

/**
 * sRGB 反 gamma 查表。
 *
 * sRGB 是**非线性**存储的，直接拿 0~255 的原始分量去做线性运算（求平均、转 XYZ）
 * 都是错的。必须先还原成线性光。
 *
 * 只有 256 种输入，直接查表比每次调 Math.pow 快一个数量级 —— 这个函数在
 * 处理大图时会被调用上千万次。
 */
const SRGB_TO_LINEAR = (() => {
  const lut = new Float64Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return lut
})()

/**
 * 线性光（0~1）→ sRGB 编码值（0~1，未量化）。
 * gamma 编码的反函数，阈值 0.0031308 与正向的 0.04045 对应。
 */
function linearToSrgbEncoded(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** sRGB 分量（0~255）→ 线性光（0~1） */
export function srgbToLinear(v: number): number {
  const i = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
  return SRGB_TO_LINEAR[i]!
}

/** 线性光（0~1）→ sRGB 分量（0~255，已 clamp 到合法区间） */
export function linearToSrgbComponent(v: number): number {
  const c = linearToSrgbEncoded(Math.max(0, Math.min(1, v)))
  return Math.max(0, Math.min(255, c * 255))
}

// ---- D65 白点（sRGB 标准指定） ----
const Xn = 0.95047
const Yn = 1.0
const Zn = 1.08883

// ---- sRGB → XYZ 变换矩阵（D65） ----
// 系数来自 IEC 61966-2-1 标准，不要随手改动。
const M00 = 0.4124564, M01 = 0.3575761, M02 = 0.1804375
const M10 = 0.2126729, M11 = 0.7151522, M12 = 0.0721750
const M20 = 0.0193339, M21 = 0.1191920, M22 = 0.9503041

const EPSILON = 216 / 24389 // (6/29)^3 ≈ 0.008856
const KAPPA = 24389 / 27    // ≈ 903.3

/** f(t)，CIE 定义的立方根压缩函数（含线性段，处理暗部） */
function f(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116
}

/** sRGB → CIE XYZ（D65） */
export function rgbToXyz(rgb: RGB): XYZ {
  const r = SRGB_TO_LINEAR[rgb[0] | 0]!
  const g = SRGB_TO_LINEAR[rgb[1] | 0]!
  const b = SRGB_TO_LINEAR[rgb[2] | 0]!
  return {
    X: M00 * r + M01 * g + M02 * b,
    Y: M10 * r + M11 * g + M12 * b,
    Z: M20 * r + M21 * g + M22 * b,
  }
}

/** sRGB → CIELAB（D65） */
export function rgbToLab(rgb: RGB): Lab {
  const r = SRGB_TO_LINEAR[rgb[0] | 0]!
  const g = SRGB_TO_LINEAR[rgb[1] | 0]!
  const b = SRGB_TO_LINEAR[rgb[2] | 0]!

  const X = M00 * r + M01 * g + M02 * b
  const Y = M10 * r + M11 * g + M12 * b
  const Z = M20 * r + M21 * g + M22 * b

  const fx = f(X / Xn)
  const fy = f(Y / Yn)
  const fz = f(Z / Zn)

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  }
}

/**
 * 热路径版本：把结果写进调用方提供的数组，避免每次分配对象。
 * 在量化阶段会被调用几十万次，对象分配会成为主要开销。
 *
 * @param out 目标数组，out[offset..offset+2] 依次写入 L、a、b
 */
export function rgbToLabInto(
  r: number,
  g: number,
  b: number,
  out: Float64Array,
  offset: number,
): void {
  const lr = SRGB_TO_LINEAR[r < 0 ? 0 : r > 255 ? 255 : r | 0]!
  const lg = SRGB_TO_LINEAR[g < 0 ? 0 : g > 255 ? 255 : g | 0]!
  const lb = SRGB_TO_LINEAR[b < 0 ? 0 : b > 255 ? 255 : b | 0]!

  const X = M00 * lr + M01 * lg + M02 * lb
  const Y = M10 * lr + M11 * lg + M12 * lb
  const Z = M20 * lr + M21 * lg + M22 * lb

  const fx = f(X / Xn)
  const fy = f(Y / Yn)
  const fz = f(Z / Zn)

  out[offset] = 116 * fy - 16
  out[offset + 1] = 500 * (fx - fy)
  out[offset + 2] = 200 * (fy - fz)
}

/**
 * Lab → sRGB。用于把匹配结果反算回可显示的颜色，
 * 以及用户自定义色卡时做双向校验。
 */
export function labToRgb(lab: Lab): RGB {
  const fy = (lab.L + 16) / 116
  const fx = fy + lab.a / 500
  const fz = fy - lab.b / 200

  const xr = fx ** 3 > EPSILON ? fx ** 3 : (116 * fx - 16) / KAPPA
  const yr = lab.L > KAPPA * EPSILON ? ((lab.L + 16) / 116) ** 3 : lab.L / KAPPA
  const zr = fz ** 3 > EPSILON ? fz ** 3 : (116 * fz - 16) / KAPPA

  const X = xr * Xn
  const Y = yr * Yn
  const Z = zr * Zn

  // XYZ → 线性 sRGB（D65 逆矩阵）
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z
  const g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z
  const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z

  return [
    Math.round(linearToSrgbComponent(r)),
    Math.round(linearToSrgbComponent(g)),
    Math.round(linearToSrgbComponent(b)),
  ]
}

/**
 * 在**线性光**空间做插值/平均。
 *
 * 直接对 sRGB 分量求平均是错的：会把亮度算偏。
 * 例如纯黑 #000000 与纯白 #FFFFFF 的算术平均是 #808080，
 * 而物理上正确的中间值是线性光 0.5，编码回 sRGB 约等于 #BCBCBC。
 * 做降采样、模糊、抗锯齿时都必须走这里。
 */
export function mixLinear(a: RGB, b: RGB, t: number): RGB {
  const mix = (i: 0 | 1 | 2) =>
    linearToSrgbComponent(
      SRGB_TO_LINEAR[a[i] | 0]! * (1 - t) + SRGB_TO_LINEAR[b[i] | 0]! * t,
    )
  return [Math.round(mix(0)), Math.round(mix(1)), Math.round(mix(2))]
}
