import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as setDeadline, clearTimeout as clearDeadline } from 'node:timers'
import { personaPath } from '../tools/lib/paths.mjs'
import { readDeliveries, updateDelivery } from './delivery-state.js'
import { loadBehavior, behaviorSections, BEHAVIOR_ROOT } from '../tools/lib/behavior.mjs'
import { expressionPrompt } from '../tools/lib/expression.mjs'
import { lifeConfig } from '../tools/lib/life-config.mjs'

export const isUnconfirmedDelivery = e => e?.code === 'DELIVERY_UNCONFIRMED'
const checkAbort = signal => { if (signal?.aborted) throw signal.reason ?? new Error('投递已取消') }
function unconfirmed(requestId, message = 'Antigravity 会话投递结果未确认；本次不重复入队，请检查会话列表') {
  return Object.assign(new Error(message), { code: 'DELIVERY_UNCONFIRMED', requestId })
}

function mayHaveDispatched(error) {
  if (error?.beforePrompt) return false
  return isUnconfirmedDelivery(error) || error?.code === 'AGY_RPC_TIMEOUT' ||
    error?.code === 'AGY_SEND_FAILED' || Number(error?.status) === 408 || Number(error?.status) >= 500
}

export function createSessionDelivery({
  controller,
  dshHome,
  sessionId,
  config,
  persona,
  isBusy = () => false,
  now = Date.now,
  log = () => {},
  onSession = () => {},
  memoryContext = null,
  timeoutMs = 60_000,
  onOutcome = () => {},
  sessionFile = 'whale-session.json',
  contextGeneration = null,
  scopeKey = null,
  sessionRole = null,
  behaviorRoot = BEHAVIOR_ROOT,
}) {
  const file = path.join(dshHome, sessionFile)
  let state = { id: sessionId, startedAt: now() }, ready = false, tail = Promise.resolve(), lastDelivered = 0
  let booted = false
  const recoveryScopes = new Map()
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof saved.id !== 'string' || !saved.id || !Number.isFinite(saved.startedAt) || saved.startedAt < 0) throw Error('invalid state')
    delete saved.behaviorDelivered; delete saved.behaviorReloadKey
    state = saved
    ready = Boolean(saved.created)
  } catch (e) {
    if (e.code !== 'ENOENT') throw Error('会话状态损坏，请检查 ' + sessionFile + '，避免误建会话')
  }
  onSession(state.id)
  readDeliveries(dshHome)
  lastDelivered = Number.isFinite(state.deliveredAt) ? state.deliveredAt : 0

  function save(next) {
    fs.mkdirSync(dshHome, { recursive: true })
    const tmp = file + '.' + crypto.randomUUID() + '.tmp'
    try { fs.writeFileSync(tmp, JSON.stringify(next)); fs.renameSync(tmp, file) }
    finally { fs.rmSync(tmp, { force: true }) }
  }

  function outcome(requestId, update, cfg) {
    const record = updateDelivery(dshHome, requestId, { ...update, scopeKey, updatedAt: now() })
    try { Promise.resolve(onOutcome(record, cfg)).catch(e => log('记录投递事件失败：' + e.message)) }
    catch (e) { log('记录投递事件失败：' + e.message) }
    return record
  }

  function bounded(promise, signal, dispatched, requestId, deadline) {
    return new Promise((resolve, reject) => {
      let done = false, timer
      const finish = (fn, value) => { if (done) return; done = true; clearDeadline(timer); signal?.removeEventListener('abort', abort); fn(value) }
      const abort = () => finish(reject, dispatched ? unconfirmed(requestId) : (signal?.reason ?? Error('投递等待超时（尚未提交提示）')))
      timer = setDeadline(() => finish(reject, dispatched ? unconfirmed(requestId) : Object.assign(Error('建立会话超时，尚未提交提示'), { code: 'DELIVERY_TIMEOUT' })), Math.max(1, deadline - now()))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error))
    })
  }

  return {
    send(request, signal, { retainUntilAck = false, memoryScene, taskKind, memoryQuery, sourceEventIds, compatibleScopeKeys = [] } = {}) {
      const requestId = request.requestId ?? crypto.randomUUID()
      const deliver = async () => {
        checkAbort(signal)
        const existing = readDeliveries(dshHome).find(r => r.requestId === requestId)
        if (scopeKey && existing?.scopeKey && existing.scopeKey !== scopeKey) {
          if (!compatibleScopeKeys.includes(existing.scopeKey)) throw Error('任务回执属于另一账号或场景，需核查任务 ID')
          recoveryScopes.set(requestId, existing.scopeKey)
        }
        if (existing?.status === 'accepted') return
        if (existing && ['dispatching', 'unconfirmed'].includes(existing.status)) throw unconfirmed(requestId)
        if (existing?.status === 'failed' && /^Antigravity RPC CreateConversation 超时/.test(existing.error ?? '')) {
          updateDelivery(dshHome, requestId, { status: 'unconfirmed', updatedAt: now() })
          throw unconfirmed(requestId)
        }

        const startedAt = now(), deadline = startedAt + Math.max(1, Number(timeoutMs) || 60_000)
        const cfg = config(), days = Number(cfg.sessionRotateDays ?? 0), once = cfg.personaOncePerSession !== false
        const mainModel = cfg.models?.main || 'flash'
        const generation = contextGeneration?.()
        const invalidated = contextGeneration && state.contextGeneration !== generation
        const modelChanged = ready && state.model !== mainModel
        const persist = !!memoryScene || !!contextGeneration || retainUntilAck || !!state.pendingRequest || once || (Number.isFinite(days) && days > 0)
        const rotating = invalidated || modelChanged || (!state.pendingRequest && Number.isFinite(days) && days > 0 && now() - state.startedAt >= days * 86400000 && now() - lastDelivered >= 8 * 60000 && !isBusy())
        const needsCreate = !ready || rotating

        let next = rotating ? { id: crypto.randomUUID(), startedAt: now(), rotatedFrom: state.id, contextGeneration: generation, created: false } : state
        if (retainUntilAck) {
          if (!request.requestId) throw Error('可靠交付需要 requestId')
          next = { ...next, pendingRequest: request.requestId }
        }

        const requestedSessionId = next.id
        const bootFirst = !booted || needsCreate

        checkAbort(signal)
        const block = persona(), fingerprint = crypto.createHash('sha256').update(block).digest('hex')
        const include = !once || bootFirst || state.personaHash !== fingerprint
        const reminder = `人设依据：${personaPath}；上下文缺失时用 read_file 重读。`
        const memory = memoryContext ? await memoryContext({ ...request, memoryScene, sessionRole, taskKind, memoryQuery, sourceEventIds, migrateFailedLegacy: false, sessionId: next.id }) : null
        if (memory?.blocked) throw Error('强制记忆规则超出预算')
        const contextText = memoryContext ? '［有界上下文］需要更多资料时按场景检索。\n' + (typeof memory === 'string' ? memory : memory.text) : ''
        const traceHint = memory && typeof memory === 'object' ? 'taskId=' + requestId + '；记忆场景=' + memoryScene + '。需要记录决定时用 bili_life（life decision <JSON文件>）；草稿带 taskId，仅引用本任务供应或授权读取的 ID。详细字段：bili_ops behavior read memory。' : ''
        const recallHint = memory?.dynamicMemory?.mode === 'active' ? '动态记忆已启用；按当前场景用 memory-catalog/history/fetch，需要时 behavior read memory。' : ''
        const chapters = memoryScene ? loadBehavior(behaviorSections(memoryScene, sessionRole, taskKind).filter(id => id !== 'public-comment'), { root: behaviorRoot }) : []
        const behavior = chapters.map(c => `［规范 ${c.id}］\n${c.text}`).join('\n')
        const contract = memoryScene ? `当前身份与人设继续适用；场景=${memoryScene}，角色=${sessionRole ?? 'legacy'}。私密材料不公开；未知发送先核查，程序权限与完整例外优先。规范索引：${path.join(behaviorRoot, 'BEHAVIOR.md')}` : ''
        const policy = lifeConfig(cfg.life)
        const expressionScenes = sessionRole === 'browse-main' ? ['public-comment', 'private-recommendation'] : ['private-reply', 'private-recommendation', 'public-comment', 'reply'].includes(memoryScene) ? [memoryScene] : []
        const expression = expressionScenes.map(scene => '［表达场景 ' + scene + '］\n' + expressionPrompt(scene, policy.draftMode, policy)).join('\n')
        const prefix = [include ? block : reminder, contract, behavior, expression, traceHint, recallHint, contextText].filter(Boolean).join('\n')
        const content = [...(request.content ?? [])]
        if (content[0]?.type === 'text') content[0] = { ...content[0], text: prefix + '\n' + content[0].text }
        else content.unshift({ type: 'text', text: prefix })

        checkAbort(signal)
        const attempt = crypto.randomUUID()
        const channel = requestId.startsWith('bili-whale-wake:') ? 'wake' : requestId.includes('-dm-') ? 'dm' : requestId.includes('-listen-') ? 'comment' : requestId.includes('-activity-') ? 'activity' : 'other'
        const setOutcome = update => outcome(requestId, update, cfg)
        setOutcome({
          attempt, channel, sessionRole, taskKind, memoryScene,
          sessionId: next.id, requestedSessionId, createdSessionId: null,
          promptCharacters: content.filter(c => c.type === 'text').reduce((n, c) => n + c.text.length, 0),
          behaviorSections: chapters.map(c => c.id), expressionScenes,
          status: 'dispatching', startedAt, retained: retainUntilAck, error: null,
        })

        let created = null, deliveryExpired = false
        const beforePrompt = () => {
          checkAbort(signal)
          if (deliveryExpired || now() >= deadline) throw Error('投递期限已到，停止提交旧任务')
          if (contextGeneration && contextGeneration() !== generation) throw Error('记忆权限已变化，停止旧上下文投递')
        }
        const prompt = id => controller.prompt({
          ...request, requestId, sessionId: id, sessionRole, content, beforePrompt,
          identity: { account: String(cfg.self?.mid ?? '').trim(), owner: String(cfg.owner?.mid ?? '').trim() },
        }, signal)
        const raw = Promise.resolve().then(async () => {
          beforePrompt()
          if (needsCreate && typeof controller.createAndPrompt === 'function') {
            created = await controller.createAndPrompt({ sessionRole, model: mainModel, content }, signal)
            return created
          }
          if (needsCreate) {
            created = await controller.create({ sessionId: next.id, sessionRole, model: mainModel }, signal)
            const id = typeof created?.sessionId === 'string' && created.sessionId ? created.sessionId : next.id
            beforePrompt()
            return prompt(id)
          }
          return prompt(next.id)
        })

        const tracked = raw.then(() => {
          const finalId = typeof created?.sessionId === 'string' && created.sessionId ? created.sessionId : next.id
          try { setOutcome({ status: 'accepted', sessionId: finalId, createdSessionId: created?.sessionId ?? null, error: null }) }
          catch (e) { log('宿主已接受投递，但保存回执失败：' + e.message) }
        }, e => {
          try {
            const current = readDeliveries(dshHome).find(r => r.requestId === requestId)
            if (current?.status !== 'unconfirmed') {
              setOutcome({ status: signal?.aborted || mayHaveDispatched(e) ? 'unconfirmed' : 'failed', error: String(e?.message ?? e).slice(0, 300) })
            }
          }
          catch (writeError) { log('保存投递错误失败：' + writeError.message) }
          throw e
        })

        try { await bounded(tracked, signal, true, requestId, deadline) }
        catch (e) {
          deliveryExpired = true
          if (mayHaveDispatched(e) || signal?.aborted) {
            const current = readDeliveries(dshHome).find(r => r.requestId === requestId)
            if (!['accepted', 'unconfirmed'].includes(current?.status)) setOutcome({ status: 'unconfirmed', error: String(e.message).slice(0, 300) })
            throw unconfirmed(requestId)
          }
          throw e
        }

        const resolvedId = typeof created?.sessionId === 'string' && created.sessionId ? created.sessionId : next.id
        if (rotating) log(`会话轮换：${state.id} → ${resolvedId}；原因=${invalidated ? 'permission-generation' : modelChanged ? 'configured-model' : 'configured-age'}；角色=${sessionRole ?? 'legacy'}；旧会话保留`)
        booted = true
        ready = true
        lastDelivered = now()
        state = { ...next, id: resolvedId, created: true, model: mainModel, contextGeneration: generation, personaHash: fingerprint, deliveredAt: lastDelivered, sessionRole }
        onSession(state.id)
        if (persist) try { save(state) } catch (e) { log('会话已投递，但保存状态失败：' + e.message) }
      }

      const job = tail.then(async () => {
        try { return await deliver() }
        catch (e) {
          if (e.code !== 'session/not-found') throw e
          checkAbort(signal); ready = false; booted = false
          state = { id: crypto.randomUUID(), startedAt: now(), contextGeneration: contextGeneration?.(), created: false }
          return deliver()
        }
      })
      tail = job.catch(() => {})
      return job
    },

    confirm(requestId) {
      const job = tail.then(() => {
        const entry = readDeliveries(dshHome).find(r => r.requestId === requestId)
        if (entry?.scopeKey && scopeKey && entry.scopeKey !== scopeKey && recoveryScopes.get(requestId) !== entry.scopeKey) return
        if (entry) updateDelivery(dshHome, requestId, { retained: false })
        const oldScope = recoveryScopes.get(requestId)
        if (oldScope && /^[a-f0-9]{24}$/.test(oldScope)) {
          const oldFile = path.join(dshHome, 'whale-session-' + oldScope + '.json')
          try {
            const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'))
            if (old.pendingRequest === requestId) {
              delete old.pendingRequest
              const tmp = oldFile + '.' + crypto.randomUUID() + '.tmp'
              try { fs.writeFileSync(tmp, JSON.stringify(old)); fs.renameSync(tmp, oldFile) }
              finally { fs.rmSync(tmp, { force: true }) }
            }
          } catch (e) { if (e.code !== 'ENOENT') throw e }
          recoveryScopes.delete(requestId)
        }
        if (state.pendingRequest !== requestId) return
        const next = { ...state }; delete next.pendingRequest
        save(next); state = next
      })
      tail = job.catch(() => {})
      return job
    },
  }
}
