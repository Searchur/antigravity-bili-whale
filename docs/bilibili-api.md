# B 站接口规范

## 调用边界

- 业务代码通过 `src/bili` 调用登记的操作。CLI、后台守护及控制台负责业务权限、目标校验、回执与文案。固定接口由登记表确定主机和方法，协议代码集中处理凭据、查询、签名、请求体和结果。
- JSON 响应用保真解析。超过 JavaScript 安全整数范围的值按十进制字符串保留，业务传递 UID、评论 ID、私信序号及分页游标时保留完整值。HTTP 状态和平台码分别判断。写入仅在两者均成功时确认，结果不明确时保留待核查记录，由现有流程回读。
- 请求保护以 `state/traffic.json` 为准。读取兼容 `cache/api-ban.json` 和旧版根目录的 `api-ban.json`，采用仍有效的最晚截止时间。`10031` 进入冷却，`12051` 需要人工核查。写入去重记录和每日预算继续沿用。`BILI_NO_CACHE=1` 只影响读取缓存和缓存日志。
- 查询缓存区分凭据和参数。普通冷却期间，视频与账号公开资料可用过期缓存。人工暂停会返回暂停提示。选题和关系缓存也遵守读取缓存开关，写入前的账号核验使用实时结果。控制台与日志共用登记的操作名和暂停说明。日志和预览省略登录 Cookie、CSRF、扫码密钥和签名值。
- 扫码和退出走认证专用入口。保留用户主动触发、超时、轮询间隔、取消和退出复核。普通账号查询仍经业务保护。媒体地址由受控媒体入口检查，二进制响应按类型读取。

## 接口清单

以下是插件当前使用的网页接口。项目发送的字段和响应契约来自迁移前的请求与隔离夹具。开放平台文档用于核对公开能力范围，网页消息中心脚本用于核对私信读取及翻页。 [B 站开放平台文档](https://open.bilibili.com/doc/) [B 站网页消息中心脚本](https://s1.hdslb.com/bfs/static/2233-monorepo/message-pc/static/js/index.f449649a.js)

| 操作 | 方法 | 地址 | 鉴权、签名 | 请求体、响应、缓存 | 项目发送的字段 | 使用方与验证 |
| --- | --- | --- | --- | --- | --- | --- |
| `nav` | `GET` | `https://api.bilibili.com/x/web-interface/nav` | 凭据可选，无 | 无，JSON，导航缓存 | 无 | 环境检测、诊断和写入前的身份校验〔甲、丁〕 |
| `ownerCard` | `GET` | `https://api.bilibili.com/x/web-interface/card` | 凭据可选，无 | 无，JSON，无缓存 | `mid` | 控制台主人核验〔甲、丁〕 |
| `profile` | `GET` | `https://api.bilibili.com/x/space/wbi/acc/info` | 凭据可选，查询签名 | 无，JSON，资料缓存 | `mid` | 账号诊断〔甲、乙〕 |
| `relationDetail` | `GET` | `https://api.bilibili.com/x/space/acc/relation` | 凭据可选，无 | 无，JSON，无缓存 | `mid` | 粉丝与主人关系校验〔甲、丙〕 |
| `relation` | `GET` | `https://api.bilibili.com/x/relation` | 凭据可选，无 | 无，JSON，无缓存 | `fid` | 关系回读与备用字段〔甲、丙〕 |
| `relationChange` | `POST` | `https://api.bilibili.com/x/relation/modify` | 需要登录，无 | 表单，JSON，无缓存 | 表单 `fid`、`act`、`re_src`、`csrf` | 关注命令〔甲、丁〕 |
| `view` | `GET` | `https://api.bilibili.com/x/web-interface/wbi/view` | 凭据可选，查询签名 | 无，JSON，资料缓存 | `bvid` | 视频流程与播放〔甲、乙〕 |
| `viewLegacy` | `GET` | `https://api.bilibili.com/x/web-interface/view` | 凭据可选，无 | 无，JSON，无缓存 | `bvid` | 封面、评论、字幕和重温诊断〔甲、乙〕 |
| `playUrl` | `GET` | `https://api.bilibili.com/x/player/wbi/playurl` | 凭据可选，查询签名 | 无，JSON，无缓存 | `bvid`、`cid`、`qn`、`fnval`、`platform`、`high_quality` | 视频观看与抽帧〔甲、乙〕 |
| `search` | `GET` | `https://api.bilibili.com/x/web-interface/wbi/search/type` | 凭据可选，查询签名 | 无，JSON，选题缓存 10 分钟 | `search_type`、`keyword`、`page`，选题时附 `order` 和 `pubtime_*_s` | 搜索、推荐和私信卡片反查〔甲、乙〕 |
| `popular` | `GET` | `https://api.bilibili.com/x/web-interface/popular` | 凭据可选，无 | 无，JSON，无缓存 | `pn`、`ps` | 推荐〔甲、乙〕 |
| `ranking` | `GET` | `https://api.bilibili.com/x/web-interface/ranking/v2` | 凭据可选，无 | 无，JSON，无缓存 | `rid`、`type` | 推荐〔甲、乙〕 |
| `dynamicFeed` | `GET` | `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all` | 需要登录，无 | 无，JSON，无缓存 | `type`、`page` | 订阅推荐〔甲、乙〕 |
| `related` | `GET` | `https://api.bilibili.com/x/web-interface/archive/related` | 凭据可选，无 | 无，JSON，无缓存 | `bvid` | 连续观看〔甲、乙〕 |
| `videoTags` | `GET` | `https://api.bilibili.com/x/tag/archive/tags` | 凭据可选，无 | 无，JSON，无缓存 | `bvid` | 观看偏好筛选〔甲、乙〕 |
| `subtitleTracks` | `GET` | `https://api.bilibili.com/x/player/wbi/v2` | 凭据可选，查询签名 | 无，JSON，无缓存 | `bvid`、`cid` | 字幕和视频摘要〔甲、乙〕 |
| `subtitleFallback` | `GET` | `https://api.bilibili.com/x/v2/subtitle/web/view` | 凭据可选，无 | 无，JSON，无缓存 | `oid`、`pid`、`context_ext`、`type`、`cur_production_type`、`preferred_language`、`playlist_switch` | 字幕回退〔甲、乙〕 |
| `danmaku` | `GET` | `https://comment.bilibili.com/{cid}.xml` | 凭据可选，无 | 无，XML，无缓存 | 路径 `{cid}` | 视频摘要〔甲、乙〕 |
| `comments` | `GET` | `https://api.bilibili.com/x/v2/reply` | 凭据可选，无 | 无，JSON，无缓存 | `type`、`oid`、`sort`、`pn`、`ps` | 评论列表与可见性核验〔甲、乙、丁〕 |
| `commentThread` | `GET` | `https://api.bilibili.com/x/v2/reply/reply` | 凭据可选，无 | 无，JSON，无缓存 | `type`、`oid`、`root`、`pn`、`ps` | 楼中楼、粉丝交付与可见性核验〔甲、乙、丙〕 |
| `commentRoot` | `GET` | `https://api.bilibili.com/x/v2/reply/main` | 凭据可选，无 | 无，JSON，无缓存 | `type`、`oid`、`pn`、`ps` | 评论目标校验与诊断〔甲、乙、丁〕 |
| `addComment` | `POST` | `https://api.bilibili.com/x/v2/reply/add` | 需要登录，可用密钥时将表单签名放入查询 | 表单，JSON，无缓存 | 表单 `type`、`oid`、`message`、`plat`、`csrf`，回复时附 `root`、`parent` | 发表评论与回复〔甲、丁〕 |
| `deleteComment` | `POST` | `https://api.bilibili.com/x/v2/reply/del` | 需要登录，无 | 表单，JSON，无缓存 | 表单 `type`、`oid`、`rpid`、`csrf` | 删除评论〔甲、丁〕 |
| `notifyReplies` | `GET` | `https://api.bilibili.com/x/msgfeed/reply` | 需要登录，无 | 无，JSON，无缓存 | `platform`、`build`、`mobi_app`，续页带 `id`、`reply_time` 或 `cursor` | 回复收件箱与后台监听〔甲、丙〕 |
| `notifyMentions` | `GET` | `https://api.bilibili.com/x/msgfeed/at` | 需要登录，无 | 无，JSON，无缓存 | `platform`、`build`、`mobi_app`，续页带 `id`、`at_time` 或 `cursor` | 提及收件箱与后台监听〔甲、丙〕 |
| `notifyLikes` | `GET` | `https://api.bilibili.com/x/msgfeed/like` | 需要登录，无 | 无，JSON，无缓存 | `build`、`mobi_app` | 点赞提醒查询〔甲、丙〕 |
| `dmHistory` | `GET` | `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs` | 需要登录，查询签名 | 无，JSON，无缓存 | `talker_id`、`session_type`、`sender_device_id`、`size`、`build`、`mobi_app`，续页带 `end_seqno` | 私信历史及续页〔戊、丙〕 |
| `dmSessions` | `GET` | `https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions` | 需要登录，查询签名 | 无，JSON，无缓存 | `session_type`、`group_fold`、`unfollow_fold`、`sort_rule`、`size`、`build`、`mobi_app`，续页带 `end_ts` | 粉丝会话列表及续页〔戊、丙〕 |
| `sendDm` | `POST` | `https://api.vc.bilibili.com/web_im/v1/web_im/send_msg` | 需要登录，无 | 表单，JSON，无缓存 | 表单 `msg[...]` 和 `csrf`，正文为 JSON 字符串 | 私信发送与回执〔甲、丁〕 |
| `dynamicCreate` | `POST` | `https://api.bilibili.com/x/dynamic/feed/create/dyn` | 需要登录，查询签名（兼容旧请求） | JSON，JSON，无缓存 | 查询 `csrf`，JSON `dyn_req` 含 `scene`、`meta`、`content` 或 `pics` | 文字及图片动态发送〔甲、丁〕 |
| `dynamicDetail` | `GET` | `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail` | 凭据可选，查询签名（兼容旧请求） | 无，JSON，无缓存 | `id`、`features` | 动态核验与诊断〔甲、乙、丁〕 |
| `dynamicHistory` | `GET` | `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history` | 凭据可选，无 | 无，JSON，无缓存 | `host_uid`、`offset_dynamic_id`、`need_top` | 动态列表〔甲、丁〕 |
| `deleteDynamic` | `POST` | `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic` | 需要登录，无 | 多段表单，JSON，无缓存 | 表单 `dynamic_id`、`csrf`、`csrf_token` | 动态删除〔甲、丁〕 |
| `uploadPicture` | `POST` | `https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs` | 需要登录，无 | 多段表单，JSON，无缓存 | 表单文件 `file_up`，附 `category`、`biz`、`csrf` | 私信、评论及动态图片〔甲、丁〕 |
| `favorites` | `GET` | `https://api.bilibili.com/x/v3/fav/folder/created/list-all` | 凭据可选，无 | 无，JSON，无缓存 | `up_mid` | 收藏夹选择〔甲、丁〕 |
| `favoriteChange` | `POST` | `https://api.bilibili.com/x/v3/fav/resource/deal` | 需要登录，无 | 表单，JSON，无缓存 | 表单 `rid`、`type`、`add_media_ids`、`del_media_ids`、`csrf` | 收藏操作与账本〔甲、丁〕 |
| `likeState` | `GET` | `https://api.bilibili.com/x/web-interface/archive/has/like` | 凭据可选，无 | 无，JSON，无缓存 | `bvid` | 视频点赞核验〔甲、丁〕 |
| `likeChange` | `POST` | `https://api.bilibili.com/x/web-interface/archive/like` | 需要登录，无 | 表单，JSON，无缓存 | 表单 `bvid`、`like`、`csrf` | 视频点赞〔甲、丁〕 |
| `opus` | `GET` | `https://www.bilibili.com/opus/{id}` | 凭据可选，无 | 无，HTML，无缓存 | 路径 `{id}` | 动态提及诊断〔甲、乙〕 |
| `qrStart` | `GET` | `https://passport.bilibili.com/x/passport-login/web/qrcode/generate` | 认证专用，无 | 无，JSON，无缓存 | 无 | 控制台扫码登录〔甲、己〕 |
| `qrPoll` | `GET` | `https://passport.bilibili.com/x/passport-login/web/qrcode/poll` | 认证专用，无 | 无，JSON，无缓存 | `qrcode_key` | 扫码状态与凭据接收〔甲、己〕 |
| `logout` | `POST` | `https://passport.bilibili.com/login/exit/v2` | 认证专用，无 | 表单，状态与响应头，无缓存 | 表单 `biliCSRF`、`gourl` | 控制台主动退出〔甲、己〕 |
| `authNav` | `GET` | `https://api.bilibili.com/x/web-interface/nav` | 认证专用，无 | 无，JSON，无缓存 | 无 | 扫码凭据验收与退出复核〔甲、己〕 |

表中【甲】为既有请求契约及公共请求测试（`test/runtime/bili-api.test.mjs`），【乙】为命令行读取测试（`test/runtime/bili-cli-reads.test.mjs`）和命令行为回归（`test/runtime/cli-regressions.test.mjs`），【丙】为私信与通知测试（`test/runtime/listeners.test.mjs`），【丁】为写入保护测试（`test/runtime/write-guards.test.mjs`）和业务回归（`test/runtime/policy-regressions.test.mjs`），【戊】为网页消息中心的会话与历史读取证据，【己】为账户管理测试（`test/runtime/management.test.mjs`）和端到端控制台夹具（`test/plugin/limits-and-features.test.mjs`）。各组测试覆盖代表性操作和共用契约，不能证明平台现网可用性。

## 媒体与兼容

- 封面、字幕和视频 URL 来自对应元信息。媒体入口仅接受所支持的 HTTPS 来源，每次跳转均重新检查，媒体请求不携带登录凭据。视频下载校验 Range、类型和长度，续传总长度变化时重新下载。分段抽帧通过短期本地环回转发继续使用同一媒体入口。见媒体测试（`test/runtime/bili-media.test.mjs`）。
- 私信仍使用会话列表的 `end_ts` 和消息历史的 `end_seqno` 向旧记录翻页。保存的序号、基线、队列及回执继续可读。隔离夹具覆盖64位序号、跨轮分页、撤回、重启补确认和通道失败隔离。
- CLI 参数、输出字段、MCP 工具及 Sidecar 发现路径沿用现有契约。后端为暂停信息附加操作名称，历史记录可按既有路径恢复名称。兼容文件保留在原数据目录，见[用户数据](user-data.md)。
- 个人网页登录、互动写入、评论通知、媒体 URL 及大部分网页读取未找到对应的开放平台契约。保持有测试的现有参数和响应处理，接口来源或格式变化时先补样例并核对资料。

## 检查命令

新增操作时同步登记、本文档和隔离夹具。运行 `npm run sync:manifest` 与 `npm run verify`，结构守卫同时核对分层、直连、签名、凭据拼接和接口清单。平台接口验收使用模拟响应与公开资料。
