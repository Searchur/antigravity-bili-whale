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
      description: '打开哔哩哔哩大鲸鱼全页管理控制台（大鲸鱼与主人、人设与作息、内置模型选择、视频观看设置、分享与监听与安全审核、动态与记忆、环境与依赖、关于与更新）。',
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
      description: '一次拉取配置、人设、运行状态、可用模型列表与版本信息（仅 UI 调用）。',
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
      description: '读取或保存 persona.md（硬上限 4000 字，仅 UI 调用）。',
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
      title: 'B站扫码登录与登出',
      description: '执行 B 站二维码扫码登录或退出登录清除凭据（凭据绝不回显，仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['qr_start', 'qr_poll', 'qr_cancel', 'logout'] },
          id: { type: 'string' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_ops',
      title: '模型列表、环境检测、立即唤醒、日志导出、打开本地目录、核验主人与版本更新',
      description: '读取模型列表、执行环境检测、立即唤醒大鲸鱼、核验主人 UID、导出带时间戳诊断日志、打开受限白名单本地目录、读取运行状态或执行插件更新（仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['models', 'deps', 'wake_now', 'verify_owner', 'status', 'export_diag', 'open_path', 'about', 'update_check', 'update_apply'] },
          ref: { type: 'string' },
          mid: { type: 'string' },
          name: { type: 'string' },
          key: { type: 'string' },
          filename: { type: 'string' },
        },
        required: ['action'],
      },
      _meta: APP_ONLY_META,
    },
    {
      name: 'whale_app_life',
      title: '长期记忆与活动管理',
      description: '查询记忆状态、暂停或恢复主动活动、搜索记忆、导出记忆或核查未确认发送（仅 UI 调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'pause', 'search', 'export', 'resolve'] },
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
          const [settings, status, about] = await Promise.all([
            api.getSettings(),
            api.getStatus(),
            api.getAbout(),
          ])
          return okResult(
            { ok: true, settings, status, about },
            `已打开哔哩哔哩大鲸鱼控制台（数据目录：${settings.dataDir}，版本：v${about.local?.version ?? '1.6.4'}）。`,
          )
        }
        case 'whale_app_bootstrap': {
          const [settings, persona, status, models, about] = await Promise.all([
            api.getSettings(),
            api.getPersona(),
            api.getStatus(),
            api.getModels(),
            api.getAbout(),
          ])
          return okResult({ ok: true, settings, persona, status, models, about })
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
          if (args.action === 'logout') return okResult(await api.logout())
          throw new Error('未知 auth action: ' + args.action)
        }
        case 'whale_app_ops': {
          if (args.action === 'models') return okResult(await api.getModels())
          if (args.action === 'deps') return okResult({ ok: true, report: await api.checkDeps() })
          if (args.action === 'wake_now') return okResult(await api.wakeNow())
          if (args.action === 'verify_owner') return okResult(await api.verifyOwner(args.mid, args.name))
          if (args.action === 'status') return okResult(await api.getStatus())
          if (args.action === 'export_diag') return okResult(await api.exportDiagnostics())
          if (args.action === 'open_path') return okResult(await api.openLocalPath(args.key, args.filename))
          if (args.action === 'about') return okResult(await api.getAbout())
          if (args.action === 'update_check') return okResult(await api.checkUpdate())
          if (args.action === 'update_apply') return okResult(await api.applyUpdate(args.ref || 'main'))
          throw new Error('未知 ops action: ' + args.action)
        }
        case 'whale_app_life': {
          return okResult(await api.lifeAction(args.action, args.params ?? {}))
        }
        default:
          return null
      }
    } catch (error) {
      return errResult(error)
    }
  }
}
