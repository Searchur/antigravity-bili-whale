import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAntigravitySessionController } from '../lib/antigravity-session.js'
import { createAntigravityTextComplete, extractJsonText } from '../lib/antigravity-text-complete.js'
import { createSessionDelivery } from '../lib/session-delivery.js'
import { normalizeModelCatalog, fallbackModelCatalog } from '../lib/antigravity-rpc.js'

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('createAntigravitySessionController creates via HTTP, continues via sendMessage, externalizes >22k prompts, and checks busy', async () => {
  const workDir = mkTmp('ag-whale-work-')
  try {
    const calls = []
    let runState = 'RUN_STATE_IDLE'
    const rpc = {
      available: () => true,
      async createConversation(params) {
        calls.push({ op: 'create', params })
        return { conversation: { id: 'conv-uuid-1' } }
      },
      async getConversation(id) {
        calls.push({ op: 'get', id })
        if (id === 'missing-id') throw Object.assign(new Error('not found'), { code: 'session/not-found' })
        return { id, state: { runState } }
      },
      async sendMessage(id, content, opts) {
        calls.push({ op: 'send', id, content, opts })
        return { ok: true }
      },
    }

    const ctrl = createAntigravitySessionController({ rpc, workDir, defaultModel: () => 'flash' })
    const created = await ctrl.createAndPrompt({
      sessionRole: 'browse-main',
      model: 'pro',
      content: [{ type: 'text', text: 'hello whale' }],
    })
    assert.equal(created.sessionId, 'conv-uuid-1')
    assert.equal(calls[0].params.model, 'pro')
    assert.deepEqual(calls[0].params.prompt, [{ text: 'hello whale' }])

    runState = 'RUN_STATE_RUNNING'
    assert.equal(await ctrl.isBusy('conv-uuid-1'), true)
    runState = 'RUN_STATE_IDLE'
    assert.equal(await ctrl.isBusy('conv-uuid-1'), false)

    // Large prompt (>22k chars) must materialize to file to avoid Windows 32KB argv limit
    const hugeText = 'X'.repeat(25_000)
    await ctrl.prompt({ sessionId: 'conv-uuid-1', requestId: 'req-huge', sessionRole: 'browse-main', content: [{ type: 'text', text: hugeText }] })
    const sendCall = calls.find(c => c.op === 'send')
    assert.ok(sendCall.content.length < 3000)
    assert.ok(sendCall.content.includes('read-prompt'))
    const promptFile = path.join(workDir, '.prompts', 'req-huge.md')
    assert.equal(fs.readFileSync(promptFile, 'utf8'), hugeText)

    await assert.rejects(() => ctrl.prompt({ sessionId: 'missing-id', content: [{ type: 'text', text: 'hi' }] }), { code: 'session/not-found' })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})

test('createAntigravityTextComplete reads transcript_full.jsonl, strips code fences, rejects tool calls, and ALWAYS archives', async () => {
  const appData = mkTmp('ag-whale-appdata-')
  try {
    const archived = []
    let counter = 0
    const transcriptSteps = new Map()
    const rpc = {
      available: () => true,
      appDataDir: () => appData,
      async createConversation(params) {
        const id = `worker-conv-${++counter}`
        const logsDir = path.join(appData, 'brain', id, '.system_generated', 'logs')
        fs.mkdirSync(logsDir, { recursive: true })
        const steps = transcriptSteps.get(counter) || []
        fs.writeFileSync(path.join(logsDir, 'transcript_full.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n')
        return { conversation: { id }, _params: params }
      },
      async getConversation(id) {
        return { id, state: { runState: 'RUN_STATE_IDLE' } }
      },
      async updateConversation(id, annotations) {
        archived.push({ id, annotations })
        return { id, annotations }
      },
    }

    const complete = createAntigravityTextComplete({
      rpc,
      model: () => 'flash_lite',
      pollIntervalMs: 5,
      codePrefix: 'TEST',
    })

    // Case 1: valid fenced JSON -> extracted & archived
    transcriptSteps.set(1, [
      { step_index: 0, type: 'USER_INPUT', content: 'prompt' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: '```json\n{"action":"skip"}\n```' },
    ])
    const out = await complete({ prompt: 'test prompt', stage: 'diary' })
    assert.equal(out, '{"action":"skip"}')
    assert.deepEqual(archived[0], { id: 'worker-conv-1', annotations: { archived: true } })

    // Case 2: model attempted tool_calls -> rejected with TEST_TOOL_CALL and STILL archived
    transcriptSteps.set(2, [
      { step_index: 0, type: 'USER_INPUT', content: 'prompt' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: {} }], content: '' },
    ])
    await assert.rejects(() => complete({ prompt: 'test prompt 2', stage: 'formation' }), { code: 'TEST_TOOL_CALL' })
    assert.deepEqual(archived[1], { id: 'worker-conv-2', annotations: { archived: true } })

    assert.equal(extractJsonText('```JSON\n{"a":1}\n```'), '{"a":1}')
  } finally {
    fs.rmSync(appData, { recursive: true, force: true })
  }
})

test('createSessionDelivery uses createAndPrompt once, reuses sessionId, recovers on not-found, and stays idempotent', async () => {
  const dataDir = mkTmp('ag-whale-deliv-')
  try {
    let seq = 0
    const logOps = []
    let failNextPromptNotFound = false
    const controller = {
      async createAndPrompt({ sessionRole, model, content }) {
        const sessionId = `ag-session-${++seq}`
        logOps.push({ op: 'createAndPrompt', sessionId, sessionRole, model, len: content[0].text.length })
        return { sessionId }
      },
      async prompt({ sessionId, requestId }) {
        logOps.push({ op: 'prompt', sessionId, requestId })
        if (failNextPromptNotFound) {
          failNextPromptNotFound = false
          throw Object.assign(new Error('not found'), { code: 'session/not-found' })
        }
        return { ok: true }
      },
    }

    const delivery = createSessionDelivery({
      controller,
      dshHome: dataDir,
      sessionId: 'init',
      sessionRole: 'browse-main',
      config: () => ({ models: { main: 'flash' }, sessionRotateDays: 0, personaOncePerSession: true }),
      persona: () => '［身份］小鲸鱼',
    })

    // First send -> createAndPrompt
    await delivery.send({ requestId: 'bili-whale-wake:1', content: [{ type: 'text', text: 'wake 1' }] })
    assert.equal(logOps.length, 1)
    assert.equal(logOps[0].op, 'createAndPrompt')
    assert.equal(logOps[0].sessionId, 'ag-session-1')

    // Duplicate requestId -> idempotent no-op
    await delivery.send({ requestId: 'bili-whale-wake:1', content: [{ type: 'text', text: 'wake 1 dup' }] })
    assert.equal(logOps.length, 1)

    // Second send -> reuses ag-session-1 via prompt()
    await delivery.send({ requestId: 'bili-whale-wake:2', content: [{ type: 'text', text: 'wake 2' }] })
    assert.equal(logOps.length, 2)
    assert.equal(logOps[1].op, 'prompt')
    assert.equal(logOps[1].sessionId, 'ag-session-1')

    // Third send encounters session/not-found -> transparently recreates via createAndPrompt
    failNextPromptNotFound = true
    await delivery.send({ requestId: 'bili-whale-wake:3', content: [{ type: 'text', text: 'wake 3' }] })
    assert.equal(logOps.at(-1).op, 'createAndPrompt')
    assert.equal(logOps.at(-1).sessionId, 'ag-session-2')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('normalizeModelCatalog groups families, sorts Thinking effort Low->XHigh, preserves Antigravity sort order, and handles fallback', () => {
  const raw = {
    clientModelSorts: [{
      groups: [{
        modelLabels: [
          'Gemini 4 Neon (XHigh)',
          'Gemini 4 Neon (Low)',
          'Orchestrator (Neon)',
          'Claude Opus 5.5 (High)',
          'Claude Opus 5.5 (Low)',
        ],
      }],
    }],
    groupedModels: {
      'gemini-4-neon': {
        displayName: 'Gemini 4 Neon',
        supportedThinkingLevels: [
          { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
          { thinkingSuffix: 'xhigh', thinkingDisplayName: 'Extra High' },
        ],
      },
      'claude-opus-5-5': {
        displayName: 'Claude Opus 5.5',
        supportedThinkingLevels: [
          { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
          { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
        ],
      },
    },
    clientModelConfigs: [
      { modelId: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', tagTitle: 'New', supportsImages: true, quotaInfo: { remainingFraction: 1 } },
      { modelId: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)', tagTitle: 'New', supportsImages: true, quotaInfo: { remainingFraction: 0.95 } },
      { modelId: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)', tagTitle: 'New', supportsImages: true, quotaInfo: { remainingFraction: 0.95 } },
      { modelId: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', tagTitle: 'New', supportsImages: true, quotaInfo: { remainingFraction: 0.95 } },
      { modelId: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)', tagTitle: 'New', supportsImages: true, quotaInfo: { remainingFraction: 1 } },
      { modelId: 'disabled-model', label: 'Disabled', disabled: true },
    ],
  }

  const cat = normalizeModelCatalog(raw)
  assert.equal(cat.source, 'live')
  assert.equal(cat.liveCount, 5)
  assert.deepEqual(cat.groups.map(g => g.key), ['auto-tier', 'gemini-4-neon', 'orchestrator', 'claude-opus-5-5'])
  // Effort sorted Low -> Extra High even though XHigh appeared first in sortLabels
  assert.deepEqual(cat.groups[1].variants.map(v => v.thinkingLabel), ['Low', 'Extra High'])
  assert.equal(cat.groups[2].variants[0].thinkingLabel, 'Neon')
  assert.deepEqual(cat.groups[3].variants.map(v => v.thinkingLabel), ['Low', 'High'])

  const fb = fallbackModelCatalog('offline')
  assert.equal(fb.source, 'fallback')
  assert.equal(fb.groups.length, 1)
  assert.equal(fb.groups[0].key, 'auto-tier')
})
