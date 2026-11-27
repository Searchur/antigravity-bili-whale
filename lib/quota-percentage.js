const percentage = new Intl.NumberFormat('en-US', {
  style: 'percent', maximumFractionDigits: 2, roundingMode: 'floor', useGrouping: false,
})

// Round downward for display so that a value below an integer threshold stays below it.
export function remainingQuotaPercent(fraction) {
  return Number.parseFloat(percentage.format(Math.max(0, Math.min(1, fraction))))
}

export const belowQuotaThreshold = (fraction, threshold) => fraction < threshold / 100
