/**
 * Tab 4 视图（视频观看）：渲染自主观看、主人评论区 @ 观看与总结及粉丝评论区 @ 观看与总结三类独立规则。
 */
import { el, getPath, row, selectCtrl, metaPill, banner } from './sections.mjs'

const MAX_FRAMES_OPTIONS = [16, 24, 36, 48, 60]

function parseGridSize(frameGrid) {
  const [c, r] = String(frameGrid || '3x3').split('x').map(Number)
  const cols = Number.isInteger(c) && c > 0 ? c : 3
  const rows = Number.isInteger(r) && r > 0 ? r : 3
  return { cols, rows, perSheet: cols * rows }
}

function formatFrameCalcLine(label, durationMin, frameEverySec, maxFrames, frameGrid) {
  const durSec = Math.max(1, Math.round(durationMin * 60))
  const rawFrames = Math.max(1, Math.ceil(durSec / frameEverySec))
  const capped = rawFrames > maxFrames
  const actualFrames = Math.min(maxFrames, rawFrames)
  const { cols, rows, perSheet } = parseGridSize(frameGrid)
  const sheets = Math.ceil(actualFrames / perSheet)
  const frameExpr = durSec % frameEverySec === 0
    ? `${durationMin} 分钟 ÷ ${frameEverySec} 秒 = ${rawFrames} 帧`
    : `⌈${durationMin} 分钟 ÷ ${frameEverySec} 秒⌉ = ${rawFrames} 帧`
  const sheetExpr = actualFrames % perSheet === 0
    ? `${actualFrames} ÷ (${cols}×${rows}) = ${sheets} 张`
    : `⌈${actualFrames} ÷ (${cols}×${rows})⌉ = ${sheets} 张`
  if (capped) {
    const step = (durSec / actualFrames).toFixed(1).replace(/\.0$/, '')
    return `${label}（${durationMin} 分钟）：按间隔理论需 ${frameExpr}，受上限封顶为 ${actualFrames} 帧（每 ${step} 秒等间隔抽 1 帧）；按 ${cols}×${rows} 固定拼图共生成 ${sheetExpr}（最后一张不足格数自动补黑）。`
  }
  return `${label}（${durationMin} 分钟）：抽帧总数 ${frameExpr}；按 ${cols}×${rows} 固定拼图共生成 ${sheetExpr}（起始帧从第 ${frameEverySec} 秒起，最后一张不足格数自动补黑）。`
}

/**
 * 公共的「固定间隔抽帧与固定拼图」子区块：
 * 仅保留「每条视频都抽帧看画面（文字 + 抽帧）」一种方式，三类场景独立配置，互不影响。
 */
function renderWatchMethodBlock(pathPrefix, viewCfg, actions, { durationSamples = [] } = {}) {
  const frameEverySec = Number(viewCfg.frameEverySec ?? 15)
  const maxFrames = Number(viewCfg.maxFrames ?? 36)
  const frameGrid = viewCfg.frameGrid || '3x3'

  const maxFrameOpts = MAX_FRAMES_OPTIONS.map(n => [String(n), n === 36 ? `最多 ${n} 帧（默认）` : `最多 ${n} 帧`])
  if (!MAX_FRAMES_OPTIONS.includes(maxFrames)) {
    maxFrameOpts.unshift([String(maxFrames), `最多 ${maxFrames} 帧（当前）`])
  }

  return el('div', {},
    row(
      '抽帧时间间隔',
      '每条观看视频均读取文字并按固定间隔抽帧：首帧从间隔时刻起算（0 秒不抽），时长不能整除时尾帧向上取整。',
      selectCtrl(frameEverySec, [
        ['5', '每 5 秒抽 1 帧（超精细）'],
        ['10', '每 10 秒抽 1 帧（较细）'],
        ['15', '每 15 秒抽 1 帧（默认）'],
        ['20', '每 20 秒抽 1 帧'],
        ['30', '每 30 秒抽 1 帧（省配额）'],
        ['60', '每 60 秒抽 1 帧（长视频概览）'],
      ], v => actions.setCfg([...pathPrefix, 'frameEverySec'], Number(v), true))),
    row(
      '单条视频抽帧上限',
      '限制单条视频最多抽取的总帧数；超过上限时自动按整条视频等间隔采样。',
      selectCtrl(maxFrames, maxFrameOpts, v => actions.setCfg([...pathPrefix, 'maxFrames'], Number(v), true))),
    row(
      '固定拼图格数',
      '抽到的帧按固定格数分片拼成多张图；最后一张不满格时保持画幅、空位自动补黑留白。',
      selectCtrl(frameGrid, [
        ['2x2', '2×2（每张 4 帧）'],
        ['3x3', '3×3（每张 9 帧，默认）'],
        ['4x4', '4×4（每张 16 帧）'],
      ], v => actions.setCfg([...pathPrefix, 'frameGrid'], v, true))),
    durationSamples.length > 0
      ? el('div', { className: 'frame-calc-box' },
          ...durationSamples.map(sample => el('div', { className: 'frame-calc-line' },
            formatFrameCalcLine(sample.label, sample.min, frameEverySec, maxFrames, frameGrid))))
      : null)
}

function renderDurationStrip(autoMaxMin, confirmMaxMin, roleLabel) {
  return el('div', { className: 'rule-strip' },
    el('div', { className: 'rule-tier ok' },
      el('div', { className: 'rule-tier-k' }, `≤ ${autoMaxMin} 分钟：直接观看并总结`),
      el('div', { className: 'rule-tier-v' }, `无需等待确认，直接观看并回复${roleLabel}。`)),
    confirmMaxMin > autoMaxMin
      ? el('div', { className: 'rule-tier warn' },
          el('div', { className: 'rule-tier-k' }, `${autoMaxMin}–${confirmMaxMin} 分钟：先回复询问确认`),
          el('div', { className: 'rule-tier-v' }, `先告知视频时长，待${roleLabel}回复确认后再观看并总结。`))
      : null,
    el('div', { className: 'rule-tier err' },
      el('div', { className: 'rule-tier-k' }, `> ${confirmMaxMin} 分钟：拒绝观看`),
      el('div', { className: 'rule-tier-v' }, '直接礼貌回复说明超过时长上限，不消耗视频观看配额。')))
}

/**
 * Tab 4：视频观看（三类独立规则，每条观看视频均读取文字并按固定间隔抽帧拼图）
 */
export function renderWatchTab(state, actions) {
  const cfg = state.cfg
  const auto = getPath(cfg, ['watch', 'auto']) ?? {}
  const ownerM = getPath(cfg, ['watch', 'ownerMention']) ?? {}
  const fanM = getPath(cfg, ['watch', 'fanMention']) ?? {}
  const fanLimits = getPath(cfg, ['fanLimits']) ?? {}

  const commentOwner = getPath(cfg, ['listen', 'commentOwner']) === true
  const mentionSummaryOwner = getPath(cfg, ['listen', 'mentionSummaryOwner']) === true

  // 一、自主观看
  const maxDurMin = Math.min(30, Math.max(1, Number(auto.maxDurationMin ?? 10)))
  const minDurSec = Number(auto.minDurationSec ?? 60)
  const autoCard = el('div', { className: 'card' },
    el('h2', {}, '一、自主观看'),
    el('p', { className: 'card-sub' }, '控制按作息计划自主观看视频的时长硬限制与抽帧拼图参数；每条观看视频均读取文字信息并按固定间隔抽帧。'),
    row(
      '自主观看最长时长',
      '超过该时长的视频将在筛选与深度观看阶段直接跳过，不纳入本轮观看。',
      selectCtrl(maxDurMin, [
        ['5', '5 分钟以内'],
        ['10', '10 分钟以内（默认）'],
        ['15', '15 分钟以内'],
        ['20', '20 分钟以内'],
        ['30', '30 分钟以内'],
      ], v => {
        const nextMax = Number(v)
        actions.setCfg(['watch', 'auto', 'maxDurationMin'], nextMax, false)
        if (minDurSec >= nextMax * 60) actions.setCfg(['watch', 'auto', 'minDurationSec'], 0, false)
        actions.rerender()
      })),
    row(
      '自主观看最短时长',
      '过滤过短的视频，避免占用深度观看名额。',
      selectCtrl(minDurSec, [
        ['0', '不限制（0 秒）'],
        ['15', '至少 15 秒'],
        ['30', '至少 30 秒'],
        ['60', '至少 1 分钟（默认）'],
        ['120', '至少 2 分钟'],
        ['300', '至少 5 分钟'],
      ].filter(([val]) => Number(val) < maxDurMin * 60), v => actions.setCfg(['watch', 'auto', 'minDurationSec'], Number(v), true))),
    renderWatchMethodBlock(['watch', 'auto'], auto, actions, {
      durationSamples: [{ label: '自主观看最长', min: maxDurMin }],
    }))

  // 二、主人评论区 @ 观看与总结
  const ownerAutoMax = Number(ownerM.autoMaxMin ?? 10)
  const ownerConfirmMax = Math.max(ownerAutoMax, Number(ownerM.confirmMaxMin ?? 20))
  const ownerReplyStyle = ownerM.replyStyle || 'comment'
  const ownerMentionReady = commentOwner && mentionSummaryOwner

  const ownerConfirmOptions = [
    [String(ownerAutoMax), `不设确认档（超过 ${ownerAutoMax} 分钟拒绝观看）`],
    ...[8, 10, 15, 20, 30, 45, 60].filter(m => m > ownerAutoMax).map(m => [String(m), m === 20 ? `${m} 分钟（默认）` : `${m} 分钟`]),
  ]

  const ownerCard = el('div', { className: 'card' },
    el('h2', {}, '二、主人评论区 @ 观看与总结'),
    el('p', { className: 'card-sub' }, '主人在 B 站视频评论区 @ 大鲸鱼且判定需先观看视频再回复时生效（仅识别【账号与主人】中配置的主人 UID，每条观看视频均读取文字并抽帧）。'),
    !ownerMentionReady
      ? banner('warn', '尚未开启主人评论区监听或【允许主人 @ 时自主判断是否观看视频】开关，可前往【互动与安全 → 四、评论区被动回复】开启。', {
          action: el('button', { type: 'button', className: 'btn sm', onClick: () => actions.switchTab('interact') }, '前往开启'),
        })
      : null,
    renderDurationStrip(ownerAutoMax, ownerConfirmMax, '主人'),
    row(
      '直接观看并总结上限',
      '不超过该时长的视频在判定需观看后会直接观看并回复。',
      selectCtrl(ownerAutoMax, [
        ['3', '3 分钟以内'],
        ['5', '5 分钟以内'],
        ['8', '8 分钟以内'],
        ['10', '10 分钟以内（默认）'],
        ['15', '15 分钟以内'],
        ['20', '20 分钟以内'],
        ['30', '30 分钟以内'],
      ], v => {
        const nextAuto = Number(v)
        actions.setCfg(['watch', 'ownerMention', 'autoMaxMin'], nextAuto, false)
        if (ownerConfirmMax < nextAuto) actions.setCfg(['watch', 'ownerMention', 'confirmMaxMin'], nextAuto, false)
        actions.rerender()
      })),
    row(
      '询问确认时长上限',
      '介于两档之间的视频会先回复询问主人是否观看；超过该上限一律不观看。',
      selectCtrl(ownerConfirmMax, ownerConfirmOptions, v => actions.setCfg(['watch', 'ownerMention', 'confirmMaxMin'], Number(v), true))),
    row(
      '总结回复方式',
      '选择在原视频评论区回复主人，或通过 B 站私信发送给主人。',
      selectCtrl(ownerReplyStyle, [
        ['comment', '在原视频评论区回复主人（默认）'],
        ['dm', '通过 B 站私信发送给主人（需互关，不发公开评论）'],
        ['both', '评论区回复并同步发送 B 站私信'],
      ], v => actions.setCfg(['watch', 'ownerMention', 'replyStyle'], v, true))),
    renderWatchMethodBlock(['watch', 'ownerMention'], ownerM, actions, {
      durationSamples: ownerConfirmMax > ownerAutoMax
        ? [{ label: '直接观看上限', min: ownerAutoMax }, { label: '确认后最长', min: ownerConfirmMax }]
        : [{ label: '主人 @ 最长', min: ownerAutoMax }],
    }))

  // 三、粉丝评论区 @ 观看与总结（仅限已关注粉丝，无确认档）
  const fanAutoMax = Number(fanM.autoMaxMin ?? 10)
  const fanMentionReady = getPath(cfg, ['listen', 'commentFan']) === true && getPath(cfg, ['listen', 'mentionSummaryFan']) === true
  const mentionTotalDaily = Math.min(10, Math.max(1, Number(fanLimits.mentionTotalDaily ?? 5)))

  const fanCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, '三、粉丝评论区 @ 观看与总结'),
      metaPill('仅限已关注粉丝', 'info')),
    el('p', { className: 'card-sub' }, '通过 B 站关注关系接口实时校验对方是否已关注大鲸鱼，未关注用户的 @ 请求一律忽略；粉丝不设询问确认档，超限直接礼貌拒绝。'),
    !fanMentionReady
      ? banner('warn', '尚未开启粉丝评论区 @ 总结监听，可前往【互动与安全 → 四、评论区被动回复】按需开启。', {
          action: el('button', { type: 'button', className: 'btn sm', onClick: () => actions.switchTab('interact') }, '前往开启'),
        })
      : null,
    renderDurationStrip(fanAutoMax, fanAutoMax, '该粉丝'),
    row(
      '直接观看并总结上限',
      '不超过该时长的视频在收到已关注粉丝 @ 请求后会直接观看并在评论区回复总结；超过上限一律不观看。',
      selectCtrl(fanAutoMax, [
        ['2', '2 分钟以内'],
        ['3', '3 分钟以内'],
        ['5', '5 分钟以内'],
        ['8', '8 分钟以内'],
        ['10', '10 分钟以内（默认）'],
        ['15', '15 分钟以内'],
      ], v => {
        const nextAuto = Number(v)
        actions.setCfg(['watch', 'fanMention', 'autoMaxMin'], nextAuto, false)
        actions.setCfg(['watch', 'fanMention', 'confirmMaxMin'], nextAuto, false)
        actions.rerender()
      })),
    row(
      '单粉丝每日 @ 总结上限',
      '限制单个粉丝每日可触发 @ 总结的次数，防止过度消耗模型配额。',
      selectCtrl(Number(fanLimits.mentionPerUserDaily ?? 1), [
        ['1', '每人每天最多 1 次（默认）'],
        ['2', '每人每天最多 2 次'],
        ['3', '每人每天最多 3 次'],
        ['5', '每人每天最多 5 次'],
      ], v => actions.setCfg(['fanLimits', 'mentionPerUserDaily'], Number(v), true))),
    row(
      '全天粉丝 @ 总结总上限',
      '每天响应所有粉丝 @ 总结请求的总次数上限。',
      selectCtrl(mentionTotalDaily, [
        ['3', '每天最多 3 次'],
        ['5', '每天最多 5 次（默认）'],
        ['10', '每天最多 10 次'],
      ], v => actions.setCfg(['fanLimits', 'mentionTotalDaily'], Number(v), true))),
    renderWatchMethodBlock(['watch', 'fanMention'], fanM, actions, {
      durationSamples: [{ label: '粉丝 @ 最长', min: fanAutoMax }],
    }))

  return el('div', {}, autoCard, ownerCard, fanCard)
}
