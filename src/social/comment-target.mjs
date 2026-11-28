/**
 * 评论目标与回复坐标前置校验器：在发评前核验视频与父楼层存在性。
 */
import { requestBili } from '../bili/api.mjs'
export async function checkCommentTarget(type,oid,headers) {
  if(!/^\d+$/.test(String(oid)))throw Error('评论 oid 必须是完整的十进制 ID 字符串')
  const result = await requestBili('commentRoot', { query: { type, oid, ps: 1, pn: 1 }, headers })
  if (!result.ok) throw Error('目标不存在或不可评论：type=' + type + ' oid=' + oid + ' code=' + (result.code ?? result.status))
}
