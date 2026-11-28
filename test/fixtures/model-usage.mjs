/**
 * 模型用量测试夹具，提供已从宿主用量摘要确认的模型组和周额度。
 */
export function modelUsageFixture(fractions, checkedAt = '2026-11-28T12:00:00.000Z') {
  return {
    state: 'ready',
    checkedAt,
    groups: Object.entries(fractions).map(([id, remainingFraction]) => ({
      id,
      name: id === 'gemini' ? 'Gemini' : 'Claude 与 GPT',
      windows: [{ period: 'weekly', remainingFraction, resetTime: null, disabled: false }],
    })),
  }
}
