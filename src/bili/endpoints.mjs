/**
 * B 站操作目录，集中记录固定主机、方法、鉴权、签名、响应类型与缓存策略。
 */
const WEB = 'https://api.bilibili.com'
const IM = 'https://api.vc.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com'
const SITE = 'https://www.bilibili.com'

function endpoint(path, label, options = {}) {
  return Object.freeze({
    origin: WEB, path, label, method: 'GET', auth: 'optional', sign: 'none', optionalSign: false,
    bodyType: 'none', responseType: 'json', cache: 'none', lane: 'business', ...options,
  })
}
const signed = (path, label, options) => endpoint(path, label, { sign: 'query', ...options })
const write = (path, label, options) => endpoint(path, label, { method: 'POST', auth: 'session', bodyType: 'form', ...options })
const auth = (path, label, options) => endpoint(path, label, { origin: PASSPORT, lane: 'auth', auth: 'flow', ...options })

export const BILI_ENDPOINTS = Object.freeze({
  nav: endpoint('/x/web-interface/nav', '检查 B 站登录状态', { cache: 'navigation' }),
  ownerCard: endpoint('/x/web-interface/card', '核验 B 站账号'),
  profile: signed('/x/space/wbi/acc/info', '读取账号资料', { cache: 'metadata' }),
  relationDetail: endpoint('/x/space/acc/relation', '检查双方关注关系'),
  relation: endpoint('/x/relation', '检查关注关系'),
  relationChange: write('/x/relation/modify', '关注操作'),
  view: signed('/x/web-interface/wbi/view', '读取视频资料', { cache: 'metadata' }),
  viewLegacy: endpoint('/x/web-interface/view', '读取视频资料'),
  playUrl: signed('/x/player/wbi/playurl', '读取视频播放地址'),
  search: signed('/x/web-interface/wbi/search/type', '搜索 B 站内容'),
  popular: endpoint('/x/web-interface/popular', '读取热门视频'),
  ranking: endpoint('/x/web-interface/ranking/v2', '读取视频排行榜'),
  dynamicFeed: endpoint('/x/polymer/web-dynamic/v1/feed/all', '读取关注动态', { auth: 'session' }),
  related: endpoint('/x/web-interface/archive/related', '读取相关视频'),
  videoTags: endpoint('/x/tag/archive/tags', '读取视频标签'),
  subtitleTracks: signed('/x/player/wbi/v2', '读取字幕轨道'),
  subtitleFallback: endpoint('/x/v2/subtitle/web/view', '读取备用字幕轨道'),
  danmaku: endpoint('/{cid}.xml', '读取弹幕', { origin: 'https://comment.bilibili.com', responseType: 'xml' }),
  comments: endpoint('/x/v2/reply', '读取评论'),
  commentThread: endpoint('/x/v2/reply/reply', '读取楼中楼'),
  commentRoot: endpoint('/x/v2/reply/main', '读取评论'),
  addComment: write('/x/v2/reply/add', '发表评论或回复', { sign: 'optional-form' }),
  deleteComment: write('/x/v2/reply/del', '删除评论'),
  notifyReplies: endpoint('/x/msgfeed/reply', '检查评论回复提醒', { auth: 'session' }),
  notifyMentions: endpoint('/x/msgfeed/at', '检查评论区 @ 提醒', { auth: 'session' }),
  notifyLikes: endpoint('/x/msgfeed/like', '检查点赞提醒', { auth: 'session' }),
  dmHistory: signed('/svr_sync/v1/svr_sync/fetch_session_msgs', '读取私信内容', { origin: IM, auth: 'session' }),
  dmSessions: signed('/session_svr/v1/session_svr/get_sessions', '检查私信会话', { origin: IM, auth: 'session' }),
  sendDm: write('/web_im/v1/web_im/send_msg', '发送私信', { origin: IM }),
  dynamicCreate: write('/x/dynamic/feed/create/dyn', '发布动态', { sign: 'query', optionalSign: true, bodyType: 'json' }),
  dynamicDetail: signed('/x/polymer/web-dynamic/v1/detail', '读取动态详情', { optionalSign: true }),
  dynamicHistory: endpoint('/dynamic_svr/v1/dynamic_svr/space_history', '读取动态列表', { origin: IM }),
  deleteDynamic: write('/dynamic_svr/v1/dynamic_svr/rm_dynamic', '删除动态', { origin: IM, bodyType: 'multipart' }),
  uploadPicture: write('/x/dynamic/feed/draw/upload_bfs', '上传图片', { bodyType: 'multipart' }),
  favorites: endpoint('/x/v3/fav/folder/created/list-all', '读取收藏夹'),
  favoriteChange: write('/x/v3/fav/resource/deal', '收藏视频'),
  likeState: endpoint('/x/web-interface/archive/has/like', '查询视频点赞状态'),
  likeChange: write('/x/web-interface/archive/like', '视频点赞'),
  opus: endpoint('/opus/{id}', '读取动态页面', { origin: SITE, responseType: 'html' }),
  qrStart: auth('/x/passport-login/web/qrcode/generate', '生成登录二维码'),
  qrPoll: auth('/x/passport-login/web/qrcode/poll', '检查扫码状态'),
  logout: auth('/login/exit/v2', '退出 B 站登录', { method: 'POST', bodyType: 'form', responseType: 'empty' }),
  authNav: auth('/x/web-interface/nav', '核验登录变更', { origin: WEB }),
})

export function biliEndpoint(id) {
  if (!Object.hasOwn(BILI_ENDPOINTS, id)) throw Error('未知 B 站操作')
  return BILI_ENDPOINTS[id]
}

const byPath = new Map(Object.entries(BILI_ENDPOINTS)
  .filter(([, route]) => route.lane === 'business' && !route.path.includes('{'))
  .map(([id, route]) => [route.method + ' ' + route.path, id]))
const legacyLabels = new Map(Object.values(BILI_ENDPOINTS).map(route => [route.path, route.label]))

export function biliOperationId(method, pathname) {
  return byPath.get((method ?? 'GET') + ' ' + pathname) ?? null
}

export function biliOperationLabel(id, method, pathname) {
  const key = Object.hasOwn(BILI_ENDPOINTS, id ?? '') ? id : biliOperationId(method, pathname)
  return key ? BILI_ENDPOINTS[key].label : legacyLabels.get(pathname) ?? null
}
