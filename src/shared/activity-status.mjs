/**
 * 控制台「动态与记忆」统一活动状态机（L0 纯计算，零 node:* 依赖，前后端与单测共享）。
 *
 * 优先级（高优先级阻断低优先级，任意时刻仅输出一枚权威主状态徽章，杜绝「正常运行中」与各类暂停/未就绪态并存）：
 * 1. identity_missing  —— 未完成大鲸鱼 B 站登录或主人 UID 保存
 * 2. sidecar_offline   —— Sidecar 后台守护未连接
 * 3. paused_both       —— 已手动暂停主动活动，且同时触发模型配额保护
 * 4. paused_manual     —— 仅手动暂停主动活动
 * 5. paused_quota      —— 仅模型配额保护自动暂停全部后台活动
 * 6. loading           —— 身份与守护正常，等待读取长期状态快照
 * 7. standby           —— 一切就绪但自动观看视频与私信/评论监听均未开启
 * 8. running           —— 一切就绪且已开启自动活动，正常运行中
 */

export function resolveIdentityState(savedConfig, draftConfig = null, status = null) {
  const saved = savedConfig ?? draftConfig ?? {}
  const draft = draftConfig ?? saved
  const accountMid = String(saved?.self?.mid ?? status?.identity?.accountMid ?? '').trim()
  const ownerMid = String(saved?.owner?.mid ?? status?.identity?.ownerMid ?? '').trim()
  const draftOwnerMid = String(draft?.owner?.mid ?? '').trim()
  const credentialsMissing = status?.identity?.credentialsPresent === false
  const hasAccount = Boolean(accountMid) && !credentialsMissing
  const hasOwner = Boolean(ownerMid)
  return {
    accountMid: hasAccount ? accountMid : '',
    ownerMid,
    hasAccount,
    hasOwner,
    ready: hasAccount && hasOwner,
    unsavedOwnerDraft: !hasOwner && Boolean(draftOwnerMid),
  }
}

export function hasAnyAutoActivity(savedConfig) {
  const listen = savedConfig?.listen ?? {}
  return Boolean(
    savedConfig?.browse?.enabled === true
    || listen.dmOwner === true
    || listen.dmFan === true
    || listen.commentOwner === true
    || listen.commentFan === true,
  )
}

function formatQuotaClause(quota) {
  if (!quota) return ''
  const rem = quota.remainingPercent
  const thr = quota.threshold
  if (Number.isFinite(rem) && Number.isFinite(thr)) {
    return `剩余 ${rem}% < ${thr}%`
  }
  return ''
}

export function deriveActivityStatus({ savedConfig = null, draftConfig = null, status = null, life = null } = {}) {
  const identity = resolveIdentityState(savedConfig, draftConfig, status)
  const quota = status?.modelQuota ?? null
  const quotaPaused = Boolean(quota?.paused)
  const quotaClause = formatQuotaClause(quota)
  const manualPaused = Boolean(life?.paused)
  const sidecarOffline = status?.sidecarRunning === false

  // 1. 前置身份未就绪（最高优先级：不可写长期状态、不触发调度与监听）
  if (!identity.ready) {
    let badgeText = '未绑定账号与主人'
    let baseNotice = '请先在「账号与主人」完成大鲸鱼 B 站扫码登录并填写主人 UID，保存后才会启用后台活动、暂停控制与长期记忆。'
    if (!identity.hasAccount && identity.hasOwner) {
      badgeText = '尚未登录大鲸鱼账号'
      baseNotice = '尚未登录大鲸鱼 B 站账号；请先在「账号与主人」扫码登录后再启用后台活动、暂停控制与长期记忆。'
    } else if (identity.hasAccount && !identity.hasOwner) {
      badgeText = '尚未配置主人 UID'
      baseNotice = identity.unsavedOwnerDraft
        ? '检测到已填写主人 UID 但尚未保存；请先点击右上角「保存配置」，保存后才会启用后台活动、暂停控制与长期记忆。'
        : '尚未配置主人 UID；请先在「账号与主人」填写并保存主人信息后再启用后台活动、暂停控制与长期记忆。'
    }
    const quotaNote = quotaPaused
      ? ` 此外，当前模型剩余配额低于保护阈值${quotaClause ? `（${quotaClause}）` : ''}，完成配置后也会受配额保护暂停（可在「模型与配额」调整）。`
      : ''
    return {
      code: 'identity_missing',
      identity,
      quotaPaused,
      manualPaused: false,
      badge: { kind: 'warn', text: badgeText },
      notice: { kind: 'warn', text: baseNotice + quotaNote },
      primaryAction: { type: 'goto_tab', tab: 'account', label: '前往配置账号与主人', style: 'primary' },
      secondaryAction: null,
    }
  }

  // 2. 后台守护未运行
  if (sidecarOffline) {
    return {
      code: 'sidecar_offline',
      identity,
      quotaPaused,
      manualPaused,
      badge: { kind: 'err', text: '后台守护未运行' },
      notice: {
        kind: 'err',
        text: manualPaused
          ? '后台守护（Sidecar）当前未连接，定时观看视频、私信与评论监听及自动归纳不会执行；同时主动活动已手动暂停，可前往「环境与依赖」排查。'
          : '后台守护（Sidecar）当前未连接，定时观看视频、私信与评论监听及自动归纳当前不会执行，请前往「环境与依赖」排查。',
      },
      primaryAction: { type: 'goto_tab', tab: 'env', label: '查看环境状态', style: 'primary' },
      secondaryAction: manualPaused
        ? { type: 'pause', value: false, label: '恢复主动活动', style: '' }
        : null,
    }
  }

  // 3. 手动暂停与配额保护同时生效
  if (manualPaused && quotaPaused) {
    return {
      code: 'paused_both',
      identity,
      quotaPaused: true,
      manualPaused: true,
      badge: { kind: 'warn', text: '已暂停（手动 + 配额保护）' },
      notice: {
        kind: 'warn',
        text: `已手动暂停主动活动，同时当前模型${quotaClause ? `（${quotaClause}）` : ''}已触发配额保护暂停全部后台活动。解除手动暂停后，仍需等待配额恢复或调低阈值才会恢复自动活动。`,
      },
      primaryAction: { type: 'pause', value: false, label: '恢复主动活动', style: 'primary' },
      secondaryAction: { type: 'goto_tab', tab: 'models', label: '调整配额保护', style: '' },
    }
  }

  // 4. 仅手动暂停
  if (manualPaused) {
    return {
      code: 'paused_manual',
      identity,
      quotaPaused: false,
      manualPaused: true,
      badge: { kind: 'warn', text: '主动活动已手动暂停' },
      notice: {
        kind: 'warn',
        text: '已手动暂停按作息观看视频、主动外发与后台记忆归纳（已开启的被动私信与评论回复不受影响）；点击「恢复主动活动」即可恢复。',
      },
      primaryAction: { type: 'pause', value: false, label: '恢复主动活动', style: 'primary' },
      secondaryAction: null,
    }
  }

  // 5. 仅配额保护自动暂停（不展示冲突的「正常运行中」与「暂停主动活动」）
  if (quotaPaused) {
    const reasonText = quota?.reason
      ? `${quota.reason.replace(/。$/, '')}。配额恢复后将自动解除，也可前往「模型与配额」调整保护阈值。`
      : `当前模型剩余配额低于保护阈值${quotaClause ? `（${quotaClause}）` : ''}，已自动暂停视频观看、私信与评论回复及后台归纳等全部活动；配额恢复后将自动解除，也可前往「模型与配额」调整保护阈值。`
    return {
      code: 'paused_quota',
      identity,
      quotaPaused: true,
      manualPaused: false,
      badge: { kind: 'warn', text: quotaClause ? `配额保护已暂停（${quotaClause}）` : '配额保护已暂停' },
      notice: { kind: 'warn', text: reasonText },
      primaryAction: { type: 'goto_tab', tab: 'models', label: '调整配额保护', style: 'primary' },
      secondaryAction: null,
    }
  }

  // 6. 尚未加载长期状态快照
  if (!life) {
    return {
      code: 'loading',
      identity,
      quotaPaused: false,
      manualPaused: false,
      badge: { kind: '', text: '读取状态中…' },
      notice: null,
      primaryAction: null,
      secondaryAction: null,
    }
  }

  // 7. 已就绪但未开启任何自动活动开关
  if (!hasAnyAutoActivity(savedConfig ?? draftConfig)) {
    return {
      code: 'standby',
      identity,
      quotaPaused: false,
      manualPaused: false,
      badge: { kind: 'info', text: '已就绪 · 待命中' },
      notice: {
        kind: 'info',
        text: '账号与守护均已就绪，当前未开启自动观看视频或私信与评论监听（仍可在「人设与作息」手动立即唤醒，或前往「互动与安全」开启自动开关）。',
      },
      primaryAction: { type: 'pause', value: true, label: '暂停主动活动', style: 'danger' },
      secondaryAction: null,
    }
  }

  // 8. 正常运行中
  return {
    code: 'running',
    identity,
    quotaPaused: false,
    manualPaused: false,
    badge: { kind: 'ok', text: '正常运行中' },
    notice: null,
    primaryAction: { type: 'pause', value: true, label: '暂停主动活动', style: 'danger' },
    secondaryAction: null,
  }
}
