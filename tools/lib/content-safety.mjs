import fs from 'node:fs'
import path from 'node:path'
import { WHALE_HOME } from './paths.mjs'
import { normalizeSafety } from './config.mjs'
import { callSidecarIpc } from '../../lib/sidecar-ipc.js'

/**
 * 第一层：代码层本地硬拦截规则（零延迟、防绕过）。
 * 覆盖明显违反中国法律法规、暴力恐怖、赌博诈骗、色情低俗、邪教迷信、人肉开盒与违禁引流红线。
 */
const BUILTIN_RULES = [
  {
    category: '违法犯罪与危险物品',
    re: /制造炸弹|制毒|贩毒|冰毒|海洛因|甲基苯丙胺|买枪|枪支弹药|走私枪支|雇凶杀人|教唆自杀|自杀教程|洗钱跑分|帮信罪教程|盗刷银行卡/i,
  },
  {
    category: '政治敏感与危害国家安全',
    re: /推翻政府|颠覆国家政权|分裂国家|台独万岁|港独万岁|疆独|藏独|法轮功|六四事件|天安门事件|政治庇护教程/i,
  },
  {
    category: '色情低俗与未成年人保护红线',
    re: /约炮群|裸聊|色情片资源|幼女资源|炼铜|儿童色情|招嫖|卖淫嫖娼/i,
  },
  {
    category: '赌博诈骗与黑灰产引流',
    re: /线上赌场|网赌充值|博彩代理|刷单兼职日结|裸贷|套现洗白|办假证|代开发票|窃听器出售/i,
  },
  {
    category: '人肉开盒与隐私侵害',
    re: /开盒挂人|人肉搜索.*(?:住址|身份证|手机号)|社工库查询|出售身份证号|出售个人信息/i,
  },
]

function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .trim()
}

export function checkLocalSafety(text, rawSafetyCfg) {
  const safety = normalizeSafety(rawSafetyCfg)
  const clean = normalizeForMatch(text)
  if (!clean) return { ok: true, blocked: false, category: '', reason: '', layer: 'local' }

  for (const rule of BUILTIN_RULES) {
    const m = clean.match(rule.re)
    if (m) {
      return {
        ok: false,
        blocked: true,
        category: rule.category,
        reason: `触发本地安全红线（${rule.category}），已拦截禁止发出`,
        matched: m[0],
        layer: 'local',
      }
    }
  }

  const lower = clean.toLowerCase()
  for (const word of safety.customWords) {
    const w = normalizeForMatch(word).toLowerCase()
    if (w && lower.includes(w)) {
      return {
        ok: false,
        blocked: true,
        category: '自定义敏感词',
        reason: `命中自定义屏蔽词「${word}」，已拦截禁止发出`,
        matched: word,
        layer: 'local-custom',
      }
    }
  }

  return { ok: true, blocked: false, category: '', reason: '', layer: 'local' }
}

export function logSafetyBlock(entry, whaleHome = WHALE_HOME) {
  try {
    fs.mkdirSync(whaleHome, { recursive: true })
    const file = path.join(whaleHome, 'safety-blocked.jsonl')
    const line = JSON.stringify({
      at: new Date().toISOString(),
      channel: entry.channel || 'unknown',
      layer: entry.layer || 'local',
      category: entry.category || '合规拦截',
      reason: String(entry.reason || '').slice(0, 200),
      preview: String(entry.text || '').slice(0, 60),
    }) + '\n'
    fs.appendFileSync(file, line, 'utf8')
  } catch {}
}

export function readRecentSafetyBlocks(whaleHome = WHALE_HOME, limit = 20) {
  try {
    const file = path.join(whaleHome, 'safety-blocked.jsonl')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-limit).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 统一外发内容安全审核闸门（供 comment / dm / dm-batch / dynamic 等写操作强制调用）。
 * 1) 先跑第一层本地红线规则与自定义词库（零延迟、绝不可绕过）。
 * 2) 当 mode === 'dual' 且后台守护 Sidecar 在线时，再调用内置模型独立语义复审（防隐喻、谐音、诱导触线）。
 */
export async function enforceOutboundSafety({
  text,
  channel = 'comment',
  context = '',
  isOwnerTarget = false,
  cfg = {},
  whaleHome = WHALE_HOME,
  ipcClient = callSidecarIpc,
} = {}) {
  const safety = normalizeSafety(cfg.safety)
  if (!safety.enabled) return { ok: true, skipped: true }
  if (safety.scope === 'external_only' && isOwnerTarget && channel === 'dm') {
    return { ok: true, skipped: true }
  }

  const localRes = checkLocalSafety(text, safety)
  if (localRes.blocked) {
    logSafetyBlock({ channel, text, ...localRes }, whaleHome)
    return localRes
  }

  if (safety.mode === 'dual') {
    try {
      const remote = await ipcClient('/safety-check', {
        method: 'POST',
        body: { text: String(text ?? ''), channel, context: String(context ?? '').slice(0, 600) },
        timeoutMs: 30_000,
      })
      if (remote?.running && remote.checked) {
        if (remote.decision === 'block') {
          const out = {
            ok: false,
            blocked: true,
            category: remote.category || '内置模型合规拦截',
            reason: remote.reason || '内置模型安全复审未通过，疑似涉及违法违规或敏感风险内容',
            layer: 'model',
          }
          logSafetyBlock({ channel, text, ...out }, whaleHome)
          return out
        }
        return { ok: true, blocked: false, layer: 'dual', reason: '' }
      }
    } catch {
      // Sidecar 离线或审查超时时，已通过第一层本地红线保护，不误伤正常发送
    }
  }

  return { ok: true, blocked: false, layer: 'local', reason: '' }
}
