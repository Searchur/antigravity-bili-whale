/**
 * 宿主机本地日历日期格式化工具（`YYYY-MM-DD`），与绝对时间戳严格分离。
 */
// 日历键使用宿主机本地时区；绝对事件时间戳统一使用 ISO 字符串，
// 保持这两种时间表示严格分离。
export function localDay(value = Date.now()) {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) throw Error('无效本地日期')
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
