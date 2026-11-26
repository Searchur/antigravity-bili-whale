import { el, getPath, row, selectCtrl } from './render-sections.js'

/**
 * 公共的「每条视频观看方式 + 抽帧策略」子区块：
 * 三类视频观看场景（自主 / 主人 @ / 粉丝 @）各自独立配置，互不影响。
 */
function renderWatchMethodBlock(pathPrefix, viewCfg, actions, { textOnlyDefault = false } = {}) {
  const mode = viewCfg.mode || (textOnlyDefault ? 'text_only' : 'auto')
  const frameStrategy = viewCfg.frameStrategy || 'interval'
  const frameEverySec = Number(viewCfg.frameEverySec ?? 15)
  const maxFrames = Number(viewCfg.maxFrames ?? 16)
  const frameGrid = viewCfg.frameGrid || '3x3'

  return el('div', {},
    row(
      '每条视频的观看方式',
      '控制读字幕/弹幕/热评的同时，是否调用 ffmpeg 抽帧查看视频画面。',
      selectCtrl(mode, [
        ['auto', textOnlyDefault ? '文字为主 + 无字幕或关键画面时抽帧' : '文字为主 + 无字幕或关键画面时抽帧（推荐）'],
        ['always_frames', '每条视频都抽帧看画面（文字 + 抽帧）'],
        ['text_only', textOnlyDefault ? '仅读文字不抽帧（最省配额，默认推荐）' : '仅读文字不抽帧（最省配额）'],
      ], v => actions.setCfg([...pathPrefix, 'mode'], v, true))),
    mode !== 'text_only'
      ? el('div', { className: 'sub-block' },
          row(
            '画面抽帧策略',
            '「按秒抽帧」根据视频时长每 N 秒截一帧；「固定拼图」整片均分截固定格数。',
            selectCtrl(frameStrategy, [
              ['interval', '按固定间隔：每 N 秒抽 1 帧（默认）'],
              ['grid', '按固定拼图：整片均分固定格数'],
            ], v => actions.setCfg([...pathPrefix, 'frameStrategy'], v, true))),
          frameStrategy === 'interval'
            ? row(
                '每隔多少秒抽一帧',
                '间隔越短画面越细，但帧数越多、消耗的视觉配额越大。',
                selectCtrl(frameEverySec, [
                  ['5', '每 5 秒抽 1 帧（超精细）'],
                  ['10', '每 10 秒抽 1 帧（较细）'],
                  ['15', '每 15 秒抽 1 帧（默认）'],
                  ['20', '每 20 秒抽 1 帧'],
                  ['30', '每 30 秒抽 1 帧（省配额）'],
                  ['60', '每 60 秒抽 1 帧（长片概览）'],
                ], v => actions.setCfg([...pathPrefix, 'frameEverySec'], Number(v), true)))
            : null,
          frameStrategy === 'interval'
            ? row(
                '单条视频最多抽帧上限',
                '防止较长视频抽图过多导致画面太糊或超配额；超过上限自动均分采样。',
                selectCtrl(maxFrames, [
                  ['9', '最多 9 帧（3×3）'],
                  ['12', '最多 12 帧（4×3）'],
                  ['16', '最多 16 帧（4×4，默认）'],
                  ['25', '最多 25 帧（5×5）'],
                  ['36', '最多 36 帧（6×6）'],
                ], v => actions.setCfg([...pathPrefix, 'maxFrames'], Number(v), true)))
            : null,
          frameStrategy === 'grid'
            ? row(
                '固定拼图格数',
                '无论视频多长，均分抽帧并拼成一张图交给模型看。',
                selectCtrl(frameGrid, [
                  ['2x2', '2×2（共 4 帧）'],
                  ['3x3', '3×3（共 9 帧，默认）'],
                  ['4x4', '4×4（共 16 帧）'],
                ], v => actions.setCfg([...pathPrefix, 'frameGrid'], v, true)))
            : null)
      : null)
}

function renderDurationStrip(autoMaxMin, confirmMaxMin, roleLabel) {
  return el('div', { className: 'rule-strip' },
    el('div', { className: 'rule-tier ok' },
      el('div', { className: 'rule-tier-k' }, `≤ ${autoMaxMin} 分钟：直接看并总结`),
      el('div', { className: 'rule-tier-v' }, `无需等待确认，直接看完并回复${roleLabel}。`)),
    confirmMaxMin > autoMaxMin
      ? el('div', { className: 'rule-tier warn' },
          el('div', { className: 'rule-tier-k' }, `${autoMaxMin}–${confirmMaxMin} 分钟：先回复询问确认`),
          el('div', { className: 'rule-tier-v' }, `先告知视频时长，等${roleLabel}回复确认后再看并总结。`))
      : null,
    el('div', { className: 'rule-tier err' },
      el('div', { className: 'rule-tier-k' }, `> ${confirmMaxMin} 分钟：一律不看`),
      el('div', { className: 'rule-tier-v' }, '直接礼貌回复说明超过时长上限，不消耗看片配额。')))
}

/**
 * Tab 4：视频观看设置（三类完全独立配置，每类均含独立观看方式与抽帧策略）
 */
export function renderWatchTab(state, actions) {
  const cfg = state.cfg
  const auto = getPath(cfg, ['watch', 'auto']) ?? {}
  const ownerM = getPath(cfg, ['watch', 'ownerMention']) ?? {}
  const fanM = getPath(cfg, ['watch', 'fanMention']) ?? {}
  const fanLimits = getPath(cfg, ['fanLimits']) ?? {}

  // 一、自主看视频
  const maxDurMin = Number(auto.maxDurationMin ?? 15)
  const minDurSec = Number(auto.minDurationSec ?? 30)
  const autoCard = el('div', { className: 'card' },
    el('h2', {}, '一、大鲸鱼自主看视频设置'),
    el('p', { className: 'card-sub' }, '控制按作息自主刷 B 站时，她挑视频的时长限制以及每条视频的观看与抽帧方式。'),
    row(
      '自主观看最长时长',
      '超过该时长的视频在初筛时自动跳过，不纳入本轮观看。',
      selectCtrl(maxDurMin, [
        ['5', '5 分钟以内'],
        ['10', '10 分钟以内'],
        ['15', '15 分钟以内（默认）'],
        ['20', '20 分钟以内'],
        ['30', '30 分钟以内'],
        ['45', '45 分钟以内'],
        ['60', '60 分钟以内'],
        ['120', '120 分钟以内'],
      ], v => {
        const nextMax = Number(v)
        actions.setCfg(['watch', 'auto', 'maxDurationMin'], nextMax, false)
        if (minDurSec >= nextMax * 60) actions.setCfg(['watch', 'auto', 'minDurationSec'], 0, false)
        actions.rerender()
      })),
    row(
      '自主观看最短时长',
      '过滤掉太短的碎片/水视频，避免浪费深看名额。',
      selectCtrl(minDurSec, [
        ['0', '不限制（0 秒）'],
        ['15', '至少 15 秒'],
        ['30', '至少 30 秒（默认）'],
        ['60', '至少 1 分钟'],
        ['120', '至少 2 分钟'],
        ['300', '至少 5 分钟'],
      ].filter(([val]) => Number(val) < maxDurMin * 60), v => actions.setCfg(['watch', 'auto', 'minDurationSec'], Number(v), true))),
    renderWatchMethodBlock(['watch', 'auto'], auto, actions))

  // 二、主人评论区 @ 看视频与总结
  const ownerAutoMax = Number(ownerM.autoMaxMin ?? 5)
  const ownerConfirmMax = Math.max(ownerAutoMax, Number(ownerM.confirmMaxMin ?? 10))
  const ownerReplyStyle = ownerM.replyStyle || 'comment'
  const ownerMentionReady = getPath(cfg, ['listen', 'commentOwner']) === true && getPath(cfg, ['listen', 'mentionSummaryOwner']) === true

  const ownerConfirmOptions = [
    [String(ownerAutoMax), `不设确认档（超过 ${ownerAutoMax} 分钟直接不看）`],
    ...[8, 10, 15, 20, 30, 45, 60].filter(m => m > ownerAutoMax).map(m => [String(m), m === 10 ? `${m} 分钟（默认）` : `${m} 分钟`]),
  ]

  const ownerCard = el('div', { className: 'card' },
    el('h2', {}, '二、主人评论区 @ 她看视频与总结设置'),
    el('p', { className: 'card-sub' }, '当你在 B 站视频评论区 @ 大鲸鱼让她看或总结时生效（仅认「主人信息」里配置的 UID）。'),
    !ownerMentionReady
      ? el('div', { className: 'banner warn', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
          el('span', {}, '提示：尚未开启主人评论区 @ 总结监听，可前往「分享与监听」开启。'),
          el('button', { type: 'button', className: 'btn sm', onClick: () => actions.switchTab('interact') }, '前往开启'))
      : null,
    renderDurationStrip(ownerAutoMax, ownerConfirmMax, '主人'),
    row(
      '直接看并总结的时长上限',
      '小于等于该时长的视频，你 @ 她后会直接观看并总结回复。',
      selectCtrl(ownerAutoMax, [
        ['3', '3 分钟以内'],
        ['5', '5 分钟以内（默认）'],
        ['8', '8 分钟以内'],
        ['10', '10 分钟以内'],
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
      '需先回复主人确认的时长上限',
      '介于两档之间时先评论问你确不确定看；超过该上限一律不看。',
      selectCtrl(ownerConfirmMax, ownerConfirmOptions, v => actions.setCfg(['watch', 'ownerMention', 'confirmMaxMin'], Number(v), true))),
    row(
      '总结结果的回复方式',
      '选择直接回复在原视频评论区，或发 B 站私信给你。',
      selectCtrl(ownerReplyStyle, [
        ['comment', '在原视频评论区直接回复你（默认）'],
        ['dm', '通过 B 站私信发给你（需互关，不发公开评论）'],
        ['both', '评论区回复 + B 站私信同步发'],
      ], v => actions.setCfg(['watch', 'ownerMention', 'replyStyle'], v, true))),
    renderWatchMethodBlock(['watch', 'ownerMention'], ownerM, actions))

  // 三、粉丝（仅已关注大鲸鱼）评论区 @ 看视频与总结
  const fanAutoMax = Number(fanM.autoMaxMin ?? 3)
  const fanConfirmMax = Math.max(fanAutoMax, Number(fanM.confirmMaxMin ?? 5))
  const fanMentionReady = getPath(cfg, ['listen', 'commentFan']) === true && getPath(cfg, ['listen', 'mentionSummaryFan']) === true

  const fanConfirmOptions = [
    [String(fanAutoMax), `不设确认档（超过 ${fanAutoMax} 分钟直接不看）`],
    ...[5, 8, 10, 15, 20, 30].filter(m => m > fanAutoMax).map(m => [String(m), m === 5 ? `${m} 分钟（默认）` : `${m} 分钟`]),
  ]

  const fanCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h2', {}, '三、粉丝评论区 @ 她看视频与总结设置'),
      el('span', { className: 'pill info' }, '仅限已关注大鲸鱼的粉丝')),
    el('p', { className: 'card-sub' }, '系统会通过 B 站关注关系接口实时校验对方是否已关注大鲸鱼；未关注的路人 @ 请求一律忽略，保护配额与账号安全。'),
    !fanMentionReady
      ? el('div', { className: 'banner warn', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
          el('span', {}, '提示：尚未开启粉丝评论区 @ 总结监听，可前往「分享与监听」按需开启。'),
          el('button', { type: 'button', className: 'btn sm', onClick: () => actions.switchTab('interact') }, '前往开启'))
      : null,
    renderDurationStrip(fanAutoMax, fanConfirmMax, '该粉丝'),
    row(
      '直接看并总结的时长上限',
      '小于等于该时长的视频，已关注粉丝 @ 她后会直接观看并在评论区回复总结。',
      selectCtrl(fanAutoMax, [
        ['2', '2 分钟以内'],
        ['3', '3 分钟以内（默认）'],
        ['5', '5 分钟以内'],
        ['8', '8 分钟以内'],
        ['10', '10 分钟以内'],
        ['15', '15 分钟以内'],
      ], v => {
        const nextAuto = Number(v)
        actions.setCfg(['watch', 'fanMention', 'autoMaxMin'], nextAuto, false)
        if (fanConfirmMax < nextAuto) actions.setCfg(['watch', 'fanMention', 'confirmMaxMin'], nextAuto, false)
        actions.rerender()
      })),
    row(
      '需先回复粉丝确认的时长上限',
      '介于两档之间时先问粉丝确不确定看；超过该上限一律不看。',
      selectCtrl(fanConfirmMax, fanConfirmOptions, v => actions.setCfg(['watch', 'fanMention', 'confirmMaxMin'], Number(v), true))),
    row(
      '每位粉丝每天最多 @ 总结次数',
      '防止个别粉丝高频 @ 看片刷爆模型配额。',
      selectCtrl(Number(fanLimits.mentionPerUserDaily ?? 1), [
        ['1', '每人每天最多 1 次（默认）'],
        ['2', '每人每天最多 2 次'],
        ['3', '每人每天最多 3 次'],
        ['5', '每人每天最多 5 次'],
      ], v => actions.setCfg(['fanLimits', 'mentionPerUserDaily'], Number(v), true))),
    row(
      '全天粉丝 @ 总结总上限',
      '每天响应所有粉丝 @ 看片总结的总次数上限。',
      selectCtrl(Number(fanLimits.mentionTotalDaily ?? 5), [
        ['3', '每天最多 3 次'],
        ['5', '每天最多 5 次（默认）'],
        ['10', '每天最多 10 次'],
        ['20', '每天最多 20 次'],
      ], v => actions.setCfg(['fanLimits', 'mentionTotalDaily'], Number(v), true))),
    renderWatchMethodBlock(['watch', 'fanMention'], fanM, actions, { textOnlyDefault: true }))

  return el('div', {}, autoCard, ownerCard, fanCard)
}
