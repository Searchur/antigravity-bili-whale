/**
 * 用户独立数据目录（%USERPROFILE%\.antigravity-bili-whale\）六类规范布局的唯一路径真理源。
 *
 * 目录结构：
 * - 根目录（用户直管）：config.json、credentials.json、persona.md、stickers/、bin/、exports/
 * - memory/  ：长期记忆（按 <fingerprint>/ 隔离 checkpoint.json、state.json、archive/、search.sqlite）
 * - state/   ：持久化运行状态与账本（schedule/listen-cursor/scheduler-health/deliveries/sessions/dm-listeners/traffic/quota/...）
 * - runtime/ ：临时运行控制（sidecar-ipc.json、locks/、write-previews/、workspace/）
 * - cache/   ：可安全清空缓存（api-cache/api-ban/feed-search/picture-uploads/shots/）
 * - logs/    ：审计与运行日志（safety-blocked.jsonl、api-requests.log、dm-listener-errors.log）
 */
import path from 'node:path'

export function dataPathsFor(whaleHome, { cfgFile } = {}) {
  const root = path.resolve(whaleHome)
  const at = (...parts) => path.join(root, ...parts)
  return Object.freeze({
    root,
    // 用户直管与扩展
    config: cfgFile ? path.resolve(cfgFile) : at('config.json'),
    credentials: at('credentials.json'),
    persona: at('persona.md'),
    stickersDir: at('stickers'),
    binDir: at('bin'),
    exportsDir: at('exports'),
    // 长期记忆
    memoryDir: at('memory'),
    // 持久化运行状态与账本
    stateDir: at('state'),
    schedule: at('state', 'schedule.json'),
    listenCursor: at('state', 'listen-cursor.json'),
    schedulerHealth: at('state', 'scheduler-health.json'),
    deliveries: at('state', 'deliveries.json'),
    sessionsDir: at('state', 'sessions'),
    dmListenersDir: at('state', 'dm-listeners'),
    traffic: at('state', 'traffic.json'),
    quota: at('state', 'quota.json'),
    quotaRecoveryDir: at('state', 'quota-recovery'),
    fanQuota: at('state', 'fan-quota.json'),
    dmQuota: at('state', 'dm-quota.json'),
    favorites: at('state', 'favorites.json'),
    deviceId: at('state', 'device-id.txt'),
    selftest: at('state', 'selftest.json'),
    // 临时运行控制
    runtimeDir: at('runtime'),
    sidecarIpc: at('runtime', 'sidecar-ipc.json'),
    locksDir: at('runtime', 'locks'),
    writePreviewsDir: at('runtime', 'write-previews'),
    workspaceDir: at('runtime', 'workspace'),
    // 可安全清空缓存
    cacheDir: at('cache'),
    apiCache: at('cache', 'api-cache.json'),
    apiBan: at('cache', 'api-ban.json'),
    feedSearchCache: at('cache', 'feed-search.json'),
    pictureUploads: at('cache', 'picture-uploads.json'),
    shotsDir: at('cache', 'shots'),
    // 审计与运行日志
    logsDir: at('logs'),
    safetyLog: at('logs', 'safety-blocked.jsonl'),
    apiRequestsLog: at('logs', 'api-requests.log'),
    dmListenerErrorsLog: at('logs', 'dm-listener-errors.log'),
  })
}
