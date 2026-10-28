/**
 * 文件下载。
 *
 * 用 `URL.createObjectURL` 而不是 data URL：图纸的 PNG 动辄几 MB，
 * data URL 要先转成 base64（体积再涨 33%）再塞进一个字符串，
 * 在低配机器上这一步本身就会卡顿一下。
 */

/** 触发一次浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器来不及取到内容，推到下一轮事件循环
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename)
}
