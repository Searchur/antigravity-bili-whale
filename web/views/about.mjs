/**
 * Tab 8 视图（关于与更新）：展示插件版本、GitHub 检查更新与原地更新、以及本地关键路径定位。
 */
import { el, row, statusPill, metaPill, banner } from './sections.mjs'

const REPO_URL = 'https://github.com/Searchur/antigravity-bili-whale'

function fmtTime(iso) {
  if (!iso) return '尚未记录'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN')
}

/**
 * Tab 8：关于与更新
 * - 展示当前版本、GitHub 仓库地址、检查更新与本地一键更新（零依赖下载并校验覆盖插件文件）。
 */
export function renderAboutTab(state, actions) {
  const local = state.about?.local ?? {}
  const check = state.updateCheck
  const remote = check?.remote
  const repoUrl = local.repository || REPO_URL
  const statusMap = {
    update_available: { cls: 'info', text: `发现新版本 v${remote?.latestVersion || ''}` },
    commit_available: { cls: 'warn', text: `发现新提交 ${remote?.mainCommit?.shortSha || ''}` },
    up_to_date: { cls: 'ok', text: '已是最新版本' },
    incomplete: { cls: 'warn', text: '更新信息不完整' },
  }
  const stBadge = check?.status ? statusMap[check.status] : null
  const updating = state.busy === 'update_apply'
  const checking = state.busy === 'update_check'

  const heroCard = el('div', { className: 'card about-hero-card' },
    el('div', { className: 'stack about-hero-meta' },
      el('div', { className: 'inline' },
        el('span', { className: 'about-title' }, local.displayName || '哔哩哔哩大鲸鱼')),
      el('div', { className: 'row-hint' }, `插件标识：${local.name || 'antigravity-bili-whale'}，作者：${local.author || 'Searchur'}，开源协议：MIT`),
      el('div', { className: 'inline mt-2' },
        el('span', { className: 'row-hint mono mono-break' }, repoUrl))),
    el('div', { className: 'inline' },
      el('button', { type: 'button', className: 'btn primary', onClick: () => actions.openUrl(repoUrl) }, '打开 GitHub')))

  const updateCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '版本检查与更新'),
        stBadge ? statusPill(stBadge.cls, stBadge.text) : metaPill('尚未检查更新')),
      el('div', { className: 'inline' },
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.checkUpdate },
          checking ? '检查中…' : '检查更新'),
        el('button', {
          type: 'button',
          className: 'btn ' + (check?.hasUpdate ? 'primary' : ''),
          disabled: !!state.busy || Boolean(local.isGitCheckout),
          onClick: () => actions.applyUpdate(remote?.targetRef || 'main'),
        }, updating ? '更新中…' : (check?.hasUpdate ? `一键更新（${remote?.targetRef === 'main' ? '最新 main' : remote?.targetRef}）` : '本地一键更新')))),
    el('p', { className: 'card-sub' }, '本地一键更新将直接从 GitHub 下载最新插件压缩包，通过完整性校验后仅原地更新插件程序文件；大鲸鱼的 B 站登录状态、人设、长期记忆与配置均保存在独立数据目录中，不会丢失。'),
    local.isGitCheckout
      ? banner('warn', '当前插件目录检测到 .git（源码开发仓库），已禁用覆盖更新；请直接在仓库中运行 git pull 与部署脚本。')
      : null,
    state.updateResult
      ? banner(state.updateResult.kind, state.updateResult.text)
      : null,
    state.updateError
      ? banner('err', state.updateError)
      : null,
    el('div', { className: 'grid-2' },
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '当前本地版本'),
        el('div', { className: 'stat-v' }, local.version ? `v${local.version}` : '版本未知'),
        el('div', { className: 'row-hint mono hint-mt' },
          local.installedCommit ? `已安装提交：${local.installedCommit.slice(0, 7)}，${fmtTime(local.updatedAt)}` : '来源：本地部署或手动安装至插件目录')),
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, 'GitHub 远程最新状态'),
        el('div', { className: 'stat-v' }, remote
          ? [remote.latestVersion ? 'v' + remote.latestVersion : '版本未知', remote.mainCommit?.shortSha].filter(Boolean).join('，提交 ')
          : '点击右上角【检查更新】获取'),
        el('div', { className: 'row-hint hint-mt' },
          remote?.mainCommit
            ? `${remote.mainCommit.message || '最新提交'}，${fmtTime(remote.mainCommit.date)}`
            : (check ? check.summary : '支持检测 Release 正式版本与 main 分支最新提交。')))),
    remote?.release?.notes
      ? el('details', { className: 'fold', open: true },
          el('summary', {}, `更新说明（${remote.release.name}）`),
          el('pre', { className: 'console-out' }, remote.release.notes))
      : null)

  const paths = state.about?.paths ?? {}
  const dataRoot = paths.dataDir || local.dataDir || '%USERPROFILE%\\.antigravity-bili-whale'
  const pluginRootPath = paths.pluginRoot || local.pluginRoot || '-'
  const pathRow = (label, hint, fullPath, key, isFile = false) => row(
    label,
    hint,
    el('div', { className: 'path-row-ctrl' },
      el('span', { className: 'path-chip mono' }, fullPath),
      el('button', {
        type: 'button',
        className: 'btn sm',
        disabled: !!state.busy,
        onClick: () => actions.openPath(key),
      }, isFile ? '定位文件' : '打开目录')),
  )

  const infoCard = el('div', { className: 'card' },
    el('h2', {}, '目录路径与项目说明'),
    el('p', { className: 'card-sub' }, '列出插件核心目录、行为规范、配置文件与安全审核模块路径，点击右侧按钮可直接通过 Windows 资源管理器打开或定位。'),
    state.pathMsg ? banner(state.pathMsg.kind, state.pathMsg.text) : null,
    pathRow('插件安装目录', '本地一键更新仅覆盖此目录下的插件程序文件。', pluginRootPath, 'plugin_root', false),
    pathRow('行为规范目录', '存放各场景行为规范与表达说明（.md）；更新插件时会随程序文件一并更新。', paths.behaviorDir || `${pluginRootPath}\\behavior`, 'behavior_dir', false),
    pathRow('独立数据目录', '保存配置、登录凭据、人设、记忆与导出文件；更新与重装插件均不会覆盖。', dataRoot, 'data_dir', false),
    pathRow('主配置文件', '保存账号信息、基础称呼、模型与配额、观看规则、互动与安全配置。', paths.configFile || `${dataRoot}\\config.json`, 'config_file', true),
    pathRow('人设正文', '大鲸鱼的专属人设正文，硬上限 4000 字，不影响日常编程对话。', paths.personaFile || `${dataRoot}\\persona.md`, 'persona_file', true),
    pathRow('长期记忆目录', '保存长期记忆账本、过往观看经历与心情状态。', paths.memoryDir || `${dataRoot}\\memory`, 'memory_dir', false),
    pathRow('安全审核拦截日志', '记录被外发内容安全审核拦截的敏感或违规文本审计记录。', paths.safetyLog || `${dataRoot}\\logs\\safety-blocked.jsonl`, 'safety_log', true),
    pathRow('外发内容安全审核规则', '插件内置的中国法律法规红线规则与双层外发安全审核核心模块。', paths.safetyRules || `${pluginRootPath}\\src\\social\\content-safety.mjs`, 'safety_rules', true),
    pathRow('导出文件目录', '存放带时间戳的脱敏诊断日志与长期记忆备份文件。', paths.exportsDir || `${dataRoot}\\exports`, 'exports_dir', false),
    row('上游原项目致谢', '移植自 Alterssss/dsh-bili-whale（MIT License），专为 Windows 版 Antigravity 原生重构。',
      el('button', { type: 'button', className: 'btn sm', onClick: () => actions.openUrl('https://github.com/Alterssss/dsh-bili-whale') }, '查看上游仓库')))

  return el('div', {}, heroCard, updateCard, infoCard)
}
