/**
 * 粉丝私信扫描，按会话列表和消息历史分别续页，沿用粉丝关系与回复限额。
 */
import { dmMessageKey, dmPosition, dmReadIssue, privateSessionsPage } from '../bili/private-messages.mjs'
import { checkRelation } from '../bili/relation.mjs'
import { advanceDmCursor, anchorDmCursor, hasDmCursor, isNewDmMessage, readHistory } from './dm-history.mjs'
import { checkFanQuota } from './fan-quota.mjs'

const CONVERSATIONS_PER_POLL = 12
const HISTORY_PAGES_PER_POLL = 10

function sessionSummary(row, owner, account) {
  const talker = String(row?.talker_id ?? '')
  if (!/^[1-9]\d{0,19}$/.test(talker) || talker === owner || talker === account) return null
  if (row.session_type != null && Number(row.session_type) !== 1) return null
  const last = row.last_msg
  const ts = Number(last?.timestamp)
  if (!Number.isFinite(ts) || ts < 0) return null
  const seq = dmPosition(last?.msg_seqno)
  return { talker, ts, key: dmMessageKey(last?.msg_key), seq: seq === '0' ? null : seq, name: row.account_info?.name }
}

export async function pollFanSessions({ headers, nav, state, owner, account, fanLimits }) {
  const fanCursors = { ...state.fanCursors }
  const messages = [], readErrors = []
  let fanScan = state.fanScan
  let fanBaselineAt = state.fanBaselineAt
  const firstRead = !Number.isFinite(Number(fanBaselineAt)) || Number(fanBaselineAt) <= 0
  const result = () => ({ fanCursors, fanScan, fanBaselineAt, messages, readErrors })

  if (firstRead || !fanScan?.remaining?.length) {
    const checkHead = !firstRead && fanScan?.checkHead === true
    const endTs = firstRead || checkHead ? null : dmPosition(fanScan?.nextEndTs)
    let page
    try {
      page = await privateSessionsPage(endTs, headers, nav.data?.wbi_img)
    } catch (error) {
      const issue = dmReadIssue('sessions', error)
      readErrors.push(issue)
      // 旧页失败时先检查首页，让活动会话继续收信。明确失效的列表位置从首页重新建立。
      if (endTs) fanScan = issue.code === 'CURSOR_STALLED' ? undefined : { ...fanScan, checkHead: true }
      else if (checkHead) fanScan = { ...fanScan, checkHead: false }
      return result()
    }
    const sessions = page.rows.map(row => sessionSummary(row, owner, account)).filter(Boolean)
    if (firstRead) {
      fanBaselineAt = Math.floor(Date.now() / 1000)
      for (const session of sessions) {
        const cursor = fanCursors[session.talker] ?? {}
        if (!hasDmCursor(cursor)) fanCursors[session.talker] = anchorDmCursor(cursor, session)
      }
      fanScan = undefined
      return result()
    }
    fanScan = {
      remaining: [...new Map(sessions.map(session => [session.talker, session])).values()],
      nextEndTs: checkHead ? fanScan.nextEndTs : page.next,
    }
  }

  const remaining = [...fanScan.remaining]
  let pagesLeft = HISTORY_PAGES_PER_POLL
  for (let checked = 0; remaining.length && checked < CONVERSATIONS_PER_POLL && pagesLeft > 0 && messages.length < 5; checked++) {
    const session = remaining[0]
    const { talker } = session
    const saved = fanCursors[talker]
    // 未见过的会话只有秒级起点，跳过起点所在秒以免重放历史。
    const cursor = saved ?? { lastSeen: fanBaselineAt, baselineSecond: fanBaselineAt }
    if (!cursor.scan && !isNewDmMessage(session, cursor)) {
      remaining.shift()
      continue
    }
    const relation = await checkRelation(talker, headers)
    if (!relation.ok) {
      remaining.shift()
      continue
    }
    const { scan, ...position } = cursor
    const allowed = relation.isFollower && checkFanQuota({
      channel: 'dm', uid: talker,
      perUserDaily: fanLimits?.dmPerUserDaily ?? 2, totalDaily: fanLimits?.dmTotalDaily ?? 10,
    }).allowed
    if (!allowed) {
      // 已确认无回复资格的来信依现有策略跳过，避免次日回放。
      fanCursors[talker] = advanceDmCursor(position, session)
      remaining.shift()
      continue
    }

    const history = await readHistory(talker, headers, cursor, { nav, scan, pageLimit: pagesLeft })
      .catch(error => ({ error, scan, pages: 0 }))
    pagesLeft -= history.pages
    if (history.scan) fanCursors[talker] = { ...position, scan: history.scan }
    if (history.error) {
      const issue = dmReadIssue('fan-history', history.error)
      readErrors.push(issue)
      if (issue.code === 'BILI_TRAFFIC_PAUSED') break
    } else if (history.scan) {
      break
    } else if (history.messages.length) {
      if (saved) fanCursors[talker] = position
      for (const row of history.messages) {
        messages.push({ ...row, mid: talker, name: session.name || `粉丝（${talker}）`, isFan: true })
      }
    } else {
      // 会话摘要末条可能是自己发的。查完历史后推进已检查的位置。
      fanCursors[talker] = advanceDmCursor(position, history.head)
    }
    remaining.shift()
  }
  fanScan = remaining.length || fanScan.nextEndTs ? { remaining, nextEndTs: fanScan.nextEndTs } : undefined
  return result()
}
