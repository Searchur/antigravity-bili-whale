export const APP_URI = 'ui://antigravity-bili-whale/app.html'

const APP_ONLY_META = { ui: { visibility: ['app'] } }

/**
 * 左侧栏全局入口工具（仅声明 global，标题「哔哩哔哩大鲸鱼」）+ 管理页专属 app-only 工具。
 * 所有管理页读写工具均为 visibility: ["app"]，对 AI 模型完全隐藏、零上下文占用。
 */
export function appToolDefinitions() {
  return [
    {
      name: 'open_bili_whale',
      title: '哔哩哔哩大鲸鱼',
      description: '打开哔哩哔哩大鲸鱼全页管理控制台（大鲸鱼与主人、人设与作息、Antigravity 内置模型选择、监听通知、待审队列、运行与依赖体检、记忆与语料）。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [{ type: 'global', title: '哔哩哔哩大鲸鱼' }],
        },
      },
    },
    {
      name: 'whale_app_bootstrap',
      title: '初始化控制台数据',
      description: '一次拉取配置、人设、运行状态、待审队列与 Antigravity 可用模型列表（仅 UI 调用）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_settings',
      title: '读写大鲸鱼配置',
      description: '读取或保存配置并热重载后台守护（仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'save'] },
          config: { type: 'object' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_persona',
      title: '读写大鲸鱼人设',
      description: '读取或保存 persona.md（仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'save'] },
          text: { type: 'string' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_auth',
      title: 'B站扫码登录',
      description: '执行 B 站二维码扫码登录（凭据绝不回显，仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['qr_start', 'qr_poll', 'qr_cancel'] },
          id: { type: 'string' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_pending',
      title: '待审回复管理',
      description: '读取、批准发出或拒绝待审回复草稿（仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'approve', 'reject'] },
          id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_ops',
      title: '模型列表、体检、安装依赖、核验主人、推送测试、手工唤醒与版本更新',
      description: '读取 Antigravity 实时模型列表、执行依赖体检、一键安装 ffmpeg、核验主人 UID 与昵称、发送测试通知、读取运行状态、触发手工唤醒、检查与执行插件本地更新（仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['models', 'deps', 'install_ffmpeg', 'verify_owner', 'notify_test', 'status', 'trigger_night', 'about', 'update_check', 'update_apply'] },
          dry: { type: 'boolean' },
          force: { type: 'boolean' },
          ref: { type: 'string' },
          mid: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_life',
      title: '长期记忆与线程管理',
      description: '查询或操作长期记忆、提案审核、线程与未确认发送（仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_corpus',
      title: '表达参考语料管理',
      description: '查询、审核、撤销或导出表达参考语料（仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
  ]
}

function okResult(payload, summaryText) {
  return {
    content: [{ type: 'text', text: summaryText ?? JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function errResult(error) {
  const message = String(error?.message ?? error ?? '操作失败')
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { ok: false, error: message },
  }
}

export function createAppToolRunner(api) {
  return async function invokeAppTool(toolName, args = {}) {
    try {
      switch (toolName) {
        case 'open_bili_whale': {
          const [settings, status, pending] = await Promise.all([
            api.getSettings(),
            api.getStatus(),
            api.getPending(),
          ])
          return okResult(
            { ok: true, settings, status, pending },
            `已打开哔哩哔哩大鲸鱼控制台（数据目录：${settings.dataDir}，后台守护：${status.sidecarRunning ? '运行中' : '未连接'}）。`,
          )
        }
        case 'whale_app_bootstrap': {
          const [settings, persona, status, pending, models, about] = await Promise.all([
            api.getSettings(),
            api.getPersona(),
            api.getStatus(),
            api.getPending(),
            api.getModels(),
            api.getAbout(),
          ])
          return okResult({ ok: true, settings, persona, status, pending, models, about })
        }
        case 'whale_app_settings': {
          if (args.action === 'get') return okResult(await api.getSettings())
          if (args.action === 'save') return okResult(await api.saveSettings(args.config ?? {}))
          throw new Error('未知 settings action: ' + args.action)
        }
        case 'whale_app_persona': {
          if (args.action === 'get') return okResult(await api.getPersona())
          if (args.action === 'save') return okResult(await api.savePersona(args.text ?? ''))
          throw new Error('未知 persona action: ' + args.action)
        }
        case 'whale_app_auth': {
          if (args.action === 'qr_start') return okResult({ ok: true, ...(await api.qrStart()) })
          if (args.action === 'qr_poll') return okResult({ ok: true, ...(await api.qrPoll(args.id)) })
          if (args.action === 'qr_cancel') return okResult({ ok: true, ...(await api.qrCancel(args.id)) })
          throw new Error('未知 auth action: ' + args.action)
        }
        case 'whale_app_pending': {
          if (args.action === 'list') return okResult(await api.getPending())
          if (args.action === 'approve') return okResult(await api.approvePending(args.id))
          if (args.action === 'reject') return okResult(await api.rejectPending(args.id, args.reason))
          throw new Error('未知 pending action: ' + args.action)
        }
        case 'whale_app_ops': {
          if (args.action === 'models') return okResult(await api.getModels())
          if (args.action === 'deps') return okResult(await api.checkDeps())
          if (args.action === 'install_ffmpeg') return okResult(await api.installFfmpeg({ force: args.force === true }))
          if (args.action === 'verify_owner') return okResult(await api.verifyOwner(args.mid, args.name))
          if (args.action === 'notify_test') return okResult(await api.notifyTest())
          if (args.action === 'status') return okResult(await api.getStatus())
          if (args.action === 'trigger_night') return okResult(await api.triggerNightNow(args.dry !== false))
          if (args.action === 'about') return okResult(await api.getAbout())
          if (args.action === 'update_check') return okResult(await api.checkUpdate())
          if (args.action === 'update_apply') return okResult(await api.applyUpdate(args.ref || 'main'))
          throw new Error('未知 ops action: ' + args.action)
        }
        case 'whale_app_life': {
          return okResult(await api.lifeAction(args.action, args.params ?? {}))
        }
        case 'whale_app_corpus': {
          return okResult(await api.corpusAction(args.action, args.params ?? {}))
        }
        default:
          return null
      }
    } catch (error) {
      return errResult(error)
    }
  }
}
