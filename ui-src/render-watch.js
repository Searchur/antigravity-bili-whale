import { el, getPath, row, selectCtrl } from './render-sections.js'

/**
 * Tab 4：视频观看设置
 * - 第一类：大鲸鱼自主刷 B 站时的看片限制（时长范围、观看方式、按秒抽帧/固定拼图策略）。
 * - 第二类：主人在评论区 @ 她看视频时的三段时长规则（直接总结 / 先回复确认 / 超长一律不看）。
 */
export function renderWatchTab(state, actions) {
  const cfg = state.cfg
  const auto = getPath(cfg, ['watch', 'auto']) ?? {}
  const mention = getPath(cfg, ['watch', 'mention']) ?? {}

  const maxDurMin = Number(auto.maxDurationMin ?? 15)
  const minDurSec = Number(auto.minDurationSec ?? 30)
  const mode = auto.mode || 'auto'
  const frameStrategy = auto.frameStrategy || 'interval'
  const frameEverySec = Number(auto.frameEverySec ?? 15)
  const maxFrames = Number(auto.maxFrames ?? 16)
  const frameGrid = auto.frameGrid || '3x3'

  const autoMaxMin = Number(mention.autoMaxMin ?? 5)
  const confirmMaxMin = Math.max(autoMaxMin, Number(mention.confirmMaxMin ?? 10))
  const mentionFrameMode = mention.frameMode || 'auto'
  const replyStyle = mention.replyStyle || 'comment'

  const mentionReady = getPath(cfg, ['listen', 'comment']) === true && getPath(cfg, ['listen', 'mentionSummary']) === true

  const autoCard = el('div', { className: 'card' },
    el('h2', {}, '一、大鲸鱼自主看视频设置'),
    el('p', { className: 'card-sub' }, '控制生物钟醒来后她自己挑视频、读字幕和抽帧看画面的方式。修改后点击右上角「保存配置」生效。'),
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
      '过滤掉太短的碎片/纯水视频，避免浪费一次深看名额。',
      selectCtrl(minDurSec, [
        ['0', '不限制（0 秒）'],
        ['15', '至少 15 秒'],
        ['30', '至少 30 秒（默认）'],
        ['60', '至少 1 分钟'],
        ['120', '至少 2 分钟'],
        ['300', '至少 5 分钟'],
      ].filter(([val]) => Number(val) < maxDurMin * 60), v => actions.setCfg(['watch', 'auto', 'minDurationSec'], Number(v), true))),
    row(
      '每条视频的观看方式',
      '决定是纯看字幕/弹幕/热评，还是结合 ffmpeg 抽帧直接看视频画面。',
      selectCtrl(mode, [
        ['auto', '文字为主 + 必要时抽帧（推荐）'],
        ['always_frames', '每条深看视频都抽帧看画面'],
        ['text_only', '仅看文字（字幕/弹幕/热评，不抽帧）'],
      ], v => actions.setCfg(['watch', 'auto', 'mode'], v, true))),
    mode !== 'text_only'
      ? el('div', { className: 'sub-block' },
          row(
            '画面抽帧策略',
            '「按秒抽帧」会根据视频长度每 N 秒截一帧；「固定拼图」不管多长都均分截固定帧数。',
            selectCtrl(frameStrategy, [
              ['interval', '按固定间隔：每 N 秒抽 1 帧（默认）'],
              ['grid', '按固定拼图：整片均分固定格数'],
            ], v => actions.setCfg(['watch', 'auto', 'frameStrategy'], v, true))),
          frameStrategy === 'interval'
            ? row(
                '每隔多少秒抽一帧',
                '间隔越短画面越细，但帧数越多、消耗的视觉配额也越大。',
                selectCtrl(frameEverySec, [
                  ['5', '每 5 秒抽 1 帧（超精细）'],
                  ['10', '每 10 秒抽 1 帧（较细）'],
                  ['15', '每 15 秒抽 1 帧（默认推荐）'],
                  ['20', '每 20 秒抽 1 帧'],
                  ['30', '每 30 秒抽 1 帧（省配额）'],
                  ['60', '每 60 秒抽 1 帧（长片概览）'],
                ], v => actions.setCfg(['watch', 'auto', 'frameEverySec'], Number(v), true)))
            : null,
          frameStrategy === 'interval'
            ? row(
                '单条视频最多抽帧上限',
                '防止较长视频抽图过多导致拼图模糊或超配额；超过上限自动均分采样。',
                selectCtrl(maxFrames, [
                  ['9', '最多 9 帧（3×3）'],
                  ['12', '最多 12 帧（4×3）'],
                  ['16', '最多 16 帧（4×4，默认）'],
                  ['25', '最多 25 帧（5×5）'],
                  ['36', '最多 36 帧（6×6）'],
                ], v => actions.setCfg(['watch', 'auto', 'maxFrames'], Number(v), true)))
            : null,
          frameStrategy === 'grid'
            ? row(
                '固定拼图格数',
                '无论视频时长多少，均分抽帧并拼成一张图交给模型看。',
                selectCtrl(frameGrid, [
                  ['2x2', '2×2（共 4 帧）'],
                  ['3x3', '3×3（共 9 帧，默认）'],
                  ['4x4', '4×4（共 16 帧）'],
                ], v => actions.setCfg(['watch', 'auto', 'frameGrid'], v, true)))
            : null)
      : null)

  const confirmOptions = [
    [String(autoMaxMin), `不设确认区间（超过 ${autoMaxMin} 分钟直接不看）`],
    ...[8, 10, 15, 20, 30, 45, 60].filter(m => m > autoMaxMin).map(m => [String(m), m === 10 ? `${m} 分钟（默认）` : `${m} 分钟`]),
  ]

  const mentionCard = el('div', { className: 'card' },
    el('h2', {}, '二、评论区 @ 她看视频与总结设置'),
    el('p', { className: 'card-sub' }, '当你在 B 站视频评论区 @ 大鲸鱼并让她看或总结时，严格按以下时长分级策略执行（仅对主人账号生效）。'),
    !mentionReady
      ? el('div', { className: 'banner warn', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
          el('span', {}, '提示：当前尚未开启评论区 @ 监听。如需使用此功能，请到「分享与监听」勾选「开启评论区与 @ 通知监听」和「响应主人的 @ 看片/总结请求」。'),
          el('button', { type: 'button', className: 'btn sm', onClick: () => actions.switchTab('interact') }, '前往开启'))
      : null,
    el('div', { className: 'rule-strip' },
      el('div', { className: 'rule-tier ok' },
        el('div', { className: 'rule-tier-k' }, `≤ ${autoMaxMin} 分钟：直接观看并总结`),
        el('div', { className: 'rule-tier-v' }, '无需等待确认，直接看完并回复总结。')),
      confirmMaxMin > autoMaxMin
        ? el('div', { className: 'rule-tier warn' },
            el('div', { className: 'rule-tier-k' }, `${autoMaxMin}–${confirmMaxMin} 分钟：先回复询问确认`),
            el('div', { className: 'rule-tier-v' }, '先告知你视频时长，等你回复确认后再看并总结。'))
        : null,
      el('div', { className: 'rule-tier err' },
        el('div', { className: 'rule-tier-k' }, `> ${confirmMaxMin} 分钟：一律不看`),
        el('div', { className: 'rule-tier-v' }, '直接礼貌回复说明超过时长上限，不消耗看片配额。'))),
    row(
      '直接看并总结的时长上限',
      '小于等于该时长的视频，你 @ 她后她会直接观看并回复总结。',
      selectCtrl(autoMaxMin, [
        ['3', '3 分钟以内'],
        ['5', '5 分钟以内（默认）'],
        ['8', '8 分钟以内'],
        ['10', '10 分钟以内'],
        ['15', '15 分钟以内'],
        ['20', '20 分钟以内'],
        ['30', '30 分钟以内'],
      ], v => {
        const nextAuto = Number(v)
        actions.setCfg(['watch', 'mention', 'autoMaxMin'], nextAuto, false)
        if (confirmMaxMin < nextAuto) actions.setCfg(['watch', 'mention', 'confirmMaxMin'], nextAuto, false)
        actions.rerender()
      })),
    row(
      '需先回复你确认的时长上限',
      '介于「直接上限」与本上限之间时，她会先评论问你确不确定看；超过本上限一律不看。',
      selectCtrl(confirmMaxMin, confirmOptions, v => actions.setCfg(['watch', 'mention', 'confirmMaxMin'], Number(v), true))),
    row(
      '@ 看片时的阅读方式',
      '决定收到你 @ 让她总结时，是否同时抽帧看画面。',
      selectCtrl(mentionFrameMode, [
        ['auto', '文字为主 + 无字幕时抽帧（默认推荐）'],
        ['always_frames', '完整观看（字幕/弹幕/热评 + 抽帧）'],
        ['text_only', '仅读文字材料（字幕/弹幕/热评，不抽帧）'],
      ], v => actions.setCfg(['watch', 'mention', 'frameMode'], v, true))),
    row(
      '总结结果的回复方式',
      '决定大鲸鱼看完后把总结发在评论区，还是通过通知渠道私发给你。',
      selectCtrl(replyStyle, [
        ['comment', '在原视频评论区直接回复你（默认）'],
        ['notify', '通过「通知推送渠道」发给你（不发公开评论）'],
        ['both', '评论区回复 + 通知渠道同步发送'],
      ], v => actions.setCfg(['watch', 'mention', 'replyStyle'], v, true))))

  return el('div', {}, autoCard, mentionCard)
}
