/**
 * CLI 命令 `feed`：按口味偏好与观看时长规则检索并筛选本轮候选 B 站视频。
 */
import {pipelineConfig,chooseVideos,eligibleVideo,videoDuration,interestEvidence,isInterest,interestGroup,fairOrder,ageDays,browsingRank} from '../pipeline/config.mjs'
import { biliJson, requestBili, searchFeedVideos } from '../../bili/api.mjs'
import { biliHeaders, loadCred } from '../../bili/cookie.mjs'
import { favoriteItems } from '../../bili/favorites.mjs'
import { DATA_PATHS } from '../../core/paths.mjs'
import { preferenceMatches, preferenceSearch } from '../../config/feed-preferences.mjs'
import { lifeStore } from '../../life/runtime.mjs'
const life = lifeStore()
import {affectBrowsing,affectInterestOrder} from '../../affect/engine.mjs'
// 选题器：照"她自己的偏好"挑今天该看什么。**只读**，不产生任何对外动作。
//
// 用法: node feed.mjs [--n 6] [--per 2] [--pool 30]
// 口味偏好来自控制台配置。既有观看和评论记录用于排除重复选题。
import fs from 'node:fs'
import { config } from '../../config/index.mjs'


const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true
}
const pipeline=pipelineConfig()
const N = Number(opt.n ?? 6)
if(!Number.isInteger(N)||N<1||N>20)throw Error('--n 必须为 1–20')
const PER = Number(opt.per ?? 2)
if(!Number.isInteger(PER)||PER<1||PER>20)throw Error('--per 必须为 1–20')
// 2026-10-22 调（主人问「feed 是不是筛得太严」）：不是严 ✗ 是池子太小 ✗
//   实测同一时刻：pool=30 → 只出 3 条且全是碎屑 ✗
//                 pool=60 → 出满 5 条，两条 DSH/AI 相关 + 两条猫咪 + 一条大肥鱼 ✓
//   代价：每个关键词多抓几条（搜索请求数不变 ✓ 只是每页多取几条 ✓）
const POOL = Number(opt.pool ?? 200)
if(!Number.isInteger(POOL)||POOL<1||POOL>1000)throw Error('--pool 必须为 1–1000')

let prefs = [...(config().preferences?.like ?? [])]
let dislike = [...(config().preferences?.dislike ?? [])]
let seen = new Set(life.read().events.filter(e=>e.kind==='video-read').map(e=>e.target))

try {
  const ledger=JSON.parse(fs.readFileSync(DATA_PATHS.quota,'utf8'))
  for(const row of ledger.log??[])if(row.type==='comment'&&/^BV:BV[0-9A-Za-z]{10}$/.test(row.target??''))seen.add(row.target.slice(3))
} catch(e) {if(e.code!=='ENOENT')throw Error('评论账本无法读取，停止选题以免重复分享')}

const cred = loadCred()
const headers = biliHeaders(cred, { referer: 'https://search.bilibili.com/' })

const explicitKeywords=argv.flatMap((v,i)=>v==='--kw'&&argv[i+1]&&!argv[i+1].startsWith('--')?[argv[i+1]]:[])
const searchKeywords = [...new Set((explicitKeywords.length?explicitKeywords:prefs.map(preferenceSearch)).filter(Boolean))].slice(0,6)

const earlyExcluded=new Set(seen)
try{for(const x of favoriteItems(JSON.parse(fs.readFileSync(DATA_PATHS.favorites,'utf8')),config().self?.mid))if(x.bv)earlyExcluded.add(x.bv)}catch(e){if(e.code!=='ENOENT')throw Error('收藏账本无法读取')}
const pool = []
// ── #3 更多来源（2026-10-18 加，Kimi 评审指出：只搜关键词 = 只刷"搜索"，不是刷 B 站）
//   --source search（默认）| popular（热门）| rank（排行榜）| all（三个都要）
const SOURCE_HOT = String((process.argv.find((a) => a.startsWith('--source=')) ?? '').split('=')[1] ?? '')
  || (process.argv.includes('--source') ? String(process.argv[process.argv.indexOf('--source') + 1] ?? 'all') : 'all')
async function fetchPopular() {
  const j = await requestBili('popular', { headers, query: { pn: 1, ps: 20 } })
  if (!j.ok) throw Error(j.message)
  for (const it of (j?.data?.list ?? [])) {
    pool.push({ bv: it.bvid, t: String(it.title ?? '').replace(/<[^>]+>/g, ''), d: Number(it.duration ?? 0),
      dm: Number(it.stat?.danmaku ?? 0), play: Number(it.stat?.view ?? 0), up: it.owner?.name ?? '', mid:String(it.owner?.mid??''), source:'popular',description:String(it.desc??''),tags:it.tag??'',kw: '热门',pubdate:Number(it.pubdate),parts:Number(it.videos??1) })
  }
}
async function fetchRank() {
  const j = await requestBili('ranking', { headers, query: { rid: 0, type: 'all' } })
  if (!j.ok) throw Error(j.message)
  for (const it of (j?.data?.list ?? []).slice(0, 20)) {
    pool.push({ bv: it.bvid, t: String(it.title ?? '').replace(/<[^>]+>/g, ''), d: Number(it.duration ?? 0),
      dm: Number(it.stat?.danmaku ?? 0), play: Number(it.stat?.view ?? 0), up: it.owner?.name ?? '', mid:String(it.owner?.mid??''), source:'rank',description:String(it.desc??''),tags:it.tag??'',kw: '排行',pubdate:Number(it.pubdate),parts:Number(it.videos??1) })
  }
}
// 关注的人发了什么（2026-10-18 加）：真人才会"刷关注"——只搜关键词等于只刷"搜索"，不像人
async function fetchFollowing() {
  const j = await biliJson('dynamicFeed', { headers, query: { type: 'video', page: 1 } })
  if (j?.code !== 0) throw new Error(`code=${j?.code} ${j?.message ?? ''}`)
  for (const it of (j?.data?.items ?? [])) {
    const a = it?.modules?.module_author
    const ar = it?.modules?.module_dynamic?.major?.archive
    if (!ar?.bvid) continue
    const dt = String(ar.duration_text ?? '')          // 形如 "05:23"
    const p = dt.split(':').map(Number)
    const secs = p.length === 2 ? p[0] * 60 + p[1] : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0
    pool.push({ bv: ar.bvid, t: String(ar.title ?? '').replace(/<[^>]+>/g, ''), d: secs,
      dm: 0, play: Number(ar.stat?.play ?? 0), up: a?.name ?? '', mid:String(a?.mid??''), source:'following',description:String(ar.desc??''),tags:'',kw: '关注',pubdate:Number(a?.pub_ts),parts:1 })
  }
}
async function loadExtraSources(){
try { if (SOURCE_HOT === 'popular' || SOURCE_HOT === 'all') await fetchPopular() } catch { console.error('（热门源取不到，跳过）') }
try { if (SOURCE_HOT === 'rank' || SOURCE_HOT === 'all') await fetchRank() } catch { console.error('（排行源取不到，跳过）') }
try { if (SOURCE_HOT === 'following' || SOURCE_HOT === 'all') await fetchFollowing() } catch (e) { console.error(`（关注源取不到，跳过：${String(e.message).slice(0, 60)}）`) }

}

// 收藏品味回流（来自本地 favorites.json）
const STOP_WORDS = new Set(['我为', '添加', '开屏', '广告', '这个', '那个', '什么', '自己', '可以', '就是', '一个'])
const ownerName = String(config().owner?.name ?? '')
const learnTokens = (text) => {
  const out = new Set()
  const base = ownerName ? String(text).replaceAll(ownerName, ' ') : String(text)
  const t = base.replace(/@\S+/g, ' ')
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{1,}/g)) if (m[0].length >= 2) out.add(m[0].toLowerCase())
  for (const m of t.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = m[0]
    for (const n of [3, 4]) for (let i = 0; i + n <= run.length; i += 1) {
      const g = run.slice(i, i + n)
      if (!STOP_WORDS.has(g)) out.add(g)
    }
  }
  return [...out]
}
let favItems = []
try {
  const fj = JSON.parse(fs.readFileSync(DATA_PATHS.favorites, 'utf8'))
  favItems = favoriteItems(fj, config().self?.mid).filter((x) => x && x.bv)
} catch {}
const learnedTokens = [...new Set(favItems.flatMap((x) => learnTokens(String(x.title ?? '') + ' ' + String(x.reason ?? ''))))]
const learnedHitsOf = (title) => learnedTokens.filter((tok) => title.toLowerCase().includes(tok)).length
const boostOf = (title) => Math.min(7.5, learnedHitsOf(title) * 2.5)

// 偏好命中与公平排序（不对高播放量视频加权偏向）
//   旧：弹幕密度 + log10(播放)×3  → 大 UP 的爆款永远霸榜 ✗
//   新：log10(1+弹幕密度)×3 + 偏好命中×4 + 反馈学习×2.5（封顶 7.5）→ 播放量彻底移出 ✓
//   为什么密度要取 log：不取时"92 秒 15027 弹幕"那条得 163 分，偏好加满也压不过 ✗（实测）
const hitsOf = title => prefs.filter(preference => preferenceMatches(title, preference))
const densityOf = (x) => Math.log10(1 + x.dm / Math.max(30, x.d))
// 2026-10-20：排除她自己的视频（实测刷到过自己的《大肥鱼成精了》✗ 别让自己看自己）
const selfName = String(config().self?.name ?? "")
// 2026-10-22 加（主人问「feed 是不是筛得太严」）：不是严 ✗ 是【没有质量下限】✗
//   实测：候选池 66 条 → 只出 3 条，其中 2 条是 0/1 播放的碎屑 ✓
//   注意：这不是给播放量加权 ✗（那条是主人 10-20 明确否掉的）
//   只是丢掉「几乎无人看过」的：播放<300 且 弹幕<3，且不是多偏好命中 ✓
const looksLikeJunk = (x) => x.play < 300 && x.dm < 3
const preferenceSnapshot=life.read()
const browsing=affectBrowsing(preferenceSnapshot.affect,Date.now(),{...life.policy.affect,enabled:life.policy.enabled&&!life.policy.paused&&!preferenceSnapshot.settings.paused&&life.policy.affect.enabled})
const allowedCandidate=x=>!dislike.some(p=>preferenceMatches(x.t,p))&&!earlyExcluded.has(x.bv)&&!life.preferences({title:x.t,author:x.mid,bvid:x.bv},'watch',preferenceSnapshot).excluded&&!(selfName&&String(x.up??'').includes(selfName))&&String(config().self?.mid??'')!==String(x.mid)&&(!looksLikeJunk(x)||hitsOf(x.t).length>=2)
const activeInterests=[...new Set((explicitKeywords.length?explicitKeywords:prefs).map(preferenceSearch).filter(Boolean))]
const sharing=config().share?.enabled===true&&['comment','dm'].includes(String(config().share?.via??'comment'))?affectInterestOrder(preferenceSnapshot.affect,activeInterests,Date.now(),{...life.policy.affect,enabled:life.policy.enabled&&!life.policy.paused&&!preferenceSnapshot.settings.paused&&life.policy.affect.enabled}):{keywords:activeInterests,shareReady:false,shareInterests:[]}
browsing.shareReady=sharing.shareReady;browsing.shareInterests=sharing.shareInterests
const annotate=x=>{const evidence=interestEvidence(x,activeInterests);return {...x,interestMatches:evidence.map(e=>e.preference),interestEvidence:evidence}}
const preliminary={...pipeline,minDuration:Math.max(0,pipeline.minDuration-5),maxDuration:pipeline.maxDuration+5}
const scoreOf = x=>densityOf(x)*3+hitsOf(x.t).length*4+boostOf(x.t)+life.preferences({title:x.t,author:x.mid,bvid:x.bv},'watch',preferenceSnapshot).boost
const verified=[],metadataSeen=new Set(),metadataGroups=new Map(),exploratory=[],trace=[],warnings=[]
const selected=()=>chooseVideos(verified,{n:N,per:PER,config:pipeline,keywords:sharing.keywords,browsing})
const interestCount=()=>selected().filter(isInterest).length
function prioritize(rows){
 const ranked=rows.map(x=>({...x,_score:scoreOf(x),_tie:Math.random()})).sort((a,b)=>!browsing.duration?(ageDays(a)-ageDays(b)||b._score-a._score||a._tie-b._tie):pipeline.windows.findIndex(d=>ageDays(a)<=d)-pipeline.windows.findIndex(d=>ageDays(b)<=d)||Math.floor(b._score/4)-Math.floor(a._score/4)||browsingRank(b,browsing)-browsingRank(a,browsing)||ageDays(a)-ageDays(b)||a._tie-b._tie)
 return fairOrder(ranked,sharing.keywords)
}
async function verifyCandidate(x){
 const existing=verified.find(v=>v.bv===x.bv)
 if(existing){existing.sources=[...new Set([...(existing.sources??[]),x.source??'search'])];return}
 if(metadataSeen.has(x.bv)||metadataSeen.size>=pipeline.maxMetadata||!eligibleVideo(x,preliminary)||!allowedCandidate(x))return
 if(isInterest(x)){
  const group=interestGroup(x),used=metadataGroups.get(group)??0
  if(selected().filter(v=>isInterest(v)&&interestGroup(v)===group).length>=PER||used>=Math.max(1,Math.ceil(pipeline.maxMetadata/Math.max(1,searchKeywords.length))))return
  metadataGroups.set(group,used+1)
 }
 metadataSeen.add(x.bv)
 const response=await biliJson('view', { headers, query: { bvid: x.bv } })
 if(response.code!==0){warnings.push(x.bv+' 元信息核验失败：'+String(response.message??response.code));return}
 const v=response.data
 const row=annotate({...x,t:String(v.title??x.t),description:String(v.desc??x.description??''),mid:String(v.owner?.mid??x.mid),up:v.owner?.name??x.up,parts:Number(v.videos??v.pages?.length??1),d:Number(v.duration??v.pages?.[0]?.duration??x.d),pubdate:Number(v.pubdate??x.pubdate),region:String(v.tname??''),tid:v.tid??null,sources:[x.source??'search']})
 if(!allowedCandidate(row)||!eligibleVideo(row,pipeline))return
 row._hits=hitsOf(row.t);row._score=scoreOf(row);verified.push(row)
}
// 先遍历当前窗口内所有兴趣主题，再消耗共享的视频详情元数据预算。
for(const days of pipeline.windows){
 if(interestCount()>=N||metadataSeen.size>=pipeline.maxMetadata)break
 const candidates=[]
 for(const kw of searchKeywords){
  if(selected().filter(x=>isInterest(x)&&interestGroup(x)===kw).length>=PER)continue
  let j
  try {
    j = await searchFeedVideos({ keyword: kw, order: 'pubdate', days, account: config().self?.mid }, { headers })
    if (j?.code !== 0) throw Error(j?.message ?? ('code=' + j?.code))
  }
  catch(error){trace.push({keyword:kw,days,error:String(error.message)});warnings.push('搜索【'+kw+'】失败，未按空结果处理');continue}
  const raw=j?.data?.result??[],rows=[]
  for(const it of raw.slice(0,Math.min(POOL,50))){
   const x=annotate({bv:it.bvid,t:String(it.title??'').replace(/<[^>]+>/g,''),description:String(it.description??it.desc??''),tags:it.tag??it.tags??'',d:videoDuration(it.duration),dm:Number(it.danmaku??0),play:Number(it.play??0),up:it.author,mid:String(it.mid??''),kw,source:'search',pubdate:Number(it.pubdate),parts:Number(it.videos??1)})
   if(!eligibleVideo(x,preliminary)||ageDays(x)>days||!allowedCandidate(x))continue
   pool.push(x)
   if(isInterest(x))rows.push(x);else exploratory.push(x)
  }
  const matched=rows.slice(0,pipeline.perKeywordPool)
  candidates.push(...matched)
  trace.push({keyword:kw,days,returned:raw.length,interestCandidates:matched.length})
 }
 for(const x of prioritize(candidates)){await verifyCandidate(x);if(interestCount()>=N||metadataSeen.size>=pipeline.maxMetadata)break}
}
// 仅凭搜索来源不足以判定口味匹配，先抽检有限数量的模糊候选详情，
// 核对完整简介后再回退至通用推荐流。
if(interestCount()<N){
 const uniqueExploratory=[...new Map(exploratory.map(x=>[x.bv,x])).values()]
 const perKeyword=new Map(),ambiguous=prioritize(uniqueExploratory).filter(x=>{const count=perKeyword.get(x.kw)??0;if(count>=2)return false;perKeyword.set(x.kw,count+1);return true})
 for(const x of ambiguous){await verifyCandidate(x);if(interestCount()>=N||metadataSeen.size>=pipeline.maxMetadata)break}
}
// 热门与排行榜共用同一探索配额池，而非两份独立名额。
if(selected().length<N&&pipeline.explorationMax>0&&metadataSeen.size<pipeline.maxMetadata){
 const before=pool.length;await loadExtraSources()
 for(const x of prioritize(pool.slice(before).map(annotate).filter(allowedCandidate))){await verifyCandidate(x);if(selected().length>=N||metadataSeen.size>=pipeline.maxMetadata)break}
}
const diversified=selected(),interestSelected=diversified.filter(isInterest).length
const diagnostics={browsing,interestSelected,explorationSelected:diversified.length-interestSelected,explorationMax:pipeline.explorationMax,metadataUsed:metadataSeen.size,metadataLimit:pipeline.maxMetadata,metadataByInterest:Object.fromEntries(metadataGroups),keywords:searchKeywords.map(keyword=>({keyword,selected:diversified.filter(x=>isInterest(x)&&interestGroup(x)===keyword).length,searches:trace.filter(x=>x.keyword===keyword)})),warnings}
if(opt.json){console.log(JSON.stringify({schema:'whale.discovery/1',items:diversified,n:N,shortfall:Math.max(0,N-diversified.length),keywords:searchKeywords,windows:pipeline.windows,diagnostics}));process.exit(0)}
console.error('[来源] 兴趣优先；探索合计最多 '+pipeline.explorationMax+' 条')
console.log(`偏好（来自配置）: ${prefs.join('、')}`)
console.log(`品味回流: 收藏 ${favItems.length} 条 → 提取 ${learnedTokens.length} 个主题词`)
console.log(`已看过/已评论过（已排除）: ${seen.size} 个 BV`)
console.log(`候选池: ${pool.length} 条 → 去重去已看后 ${verified.length} 条\n`)
console.log('兴趣候选 '+interestSelected+' 条；探索 '+(diversified.length-interestSelected)+' 条；缺口 '+Math.max(0,N-diversified.length)+' 条')
console.log(`今天可以看这几条（每词最多 ${PER} 条，共 ${N} 条）：`)
const perKw = {}
let shown = 0
for (const x of diversified) {
  if (shown >= N) break
  perKw[x.kw] = perKw[x.kw] ?? 0
  perKw[x.kw] += 1; shown += 1
  console.log(`  ${String(shown).padStart(2)}. ${x.bv}  ${String(x.d).padStart(4)}s  弹幕${String(x.dm).padStart(7)}  播放${String(x.play).padStart(9)}  ${x.t.slice(0, 40)}  @${x.up} ${x._hits.length ? "[" + x._hits.join("+") + "]" : ""}`)
}
console.log('\n如需深看，运行：bili_read debrief <BV> --profile auto')
