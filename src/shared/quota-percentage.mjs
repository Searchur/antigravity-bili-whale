/**
 * 前后端共享的模型剩余配额百分比格式化与阈值比较纯函数（零 node:* 依赖）。
 */
const percentage = new Intl.NumberFormat('en-US', {
  style: 'percent', maximumFractionDigits: 2, roundingMode: 'floor', useGrouping: false,
})

// 展示时向下舍入，确保低于整数阈值的配额不会因四舍五入显示为达标。
export function remainingQuotaPercent(fraction) {
  return Number.parseFloat(percentage.format(Math.max(0, Math.min(1, fraction))))
}

export const belowQuotaThreshold = (fraction, threshold) => fraction < threshold / 100
