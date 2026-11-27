/**
 * 大整数保真 JSON 解析器：防止 B 站超长评论/消息 ID 在 Number 转换中丢失精度。
 */
export function parseJsonExact(text) {
  const source=String(text)
  return JSON.parse(source.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (/^-?(?:0|[1-9]\d*)$/.test(token) && !Number.isSafeInteger(Number(token))) return JSON.stringify(token)
    return token
  }))
}
export async function exactJson(response) { return parseJsonExact(await response.text()) }
