import { el, row } from './render-sections.js'

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
  }
  const stBadge = check?.status ? statusMap[check.status] : null
  const updating = state.busy === 'update_apply'
  const checking = state.busy === 'update_check'

  const heroCard = el('div', { className: 'card' },
    el('div', { className: 'about-hero' },
      el('div', { className: 'stack', style: { gap: '6px', flex: 1, minWidth: '240px' } },
        el('div', { className: 'inline' },
          el('span', { className: 'about-title' }, local.displayName || '哔哩哔哩大鲸鱼'),
          el('span', { className: 'pill info mono' }, `v${local.version || '1.0.0'}`),
          el('span', { className: 'pill' }, 'Windows Antigravity App 专属')),
        el('div', { className: 'row-hint' }, `插件标识：${local.name || 'antigravity-bili-whale'} · 作者：${local.author || 'Searchur'} · 开源协议：MIT`),
        el('div', { className: 'inline', style: { marginTop: '2px' } },
          el('a', {
            className: 'link-btn',
            href: repoUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick: (e) => { e.preventDefault(); actions.openUrl(repoUrl) },
          }, repoUrl))),
      el('div', { className: 'inline' },
        el('button', { type: 'button', className: 'btn primary', onClick: () => actions.openUrl(repoUrl) }, '打开 GitHub'),
        el('button', { type: 'button', className: 'btn', onClick: () => actions.copyText(repoUrl, 'repo') },
          state.copiedKey === 'repo' ? '✓ 已复制地址' : '复制仓库地址'))))

  const updateCard = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('div', { className: 'inline' },
        el('h2', {}, '版本检查与本地一键更新'),
        stBadge ? el('span', { className: `pill ${stBadge.cls}` }, el('span', { className: 'dot' }), stBadge.text) : el('span', { className: 'pill' }, '尚未检查更新')),
      el('div', { className: 'inline' },
        el('button', { type: 'button', className: 'btn', disabled: !!state.busy, onClick: actions.checkUpdate },
          checking ? '正在检查 GitHub…' : '检查更新'),
        el('button', {
          type: 'button',
          className: 'btn ' + (check?.hasUpdate ? 'primary' : ''),
          disabled: !!state.busy || Boolean(local.isGitCheckout),
          onClick: () => actions.applyUpdate(remote?.targetRef || 'main'),
        }, updating ? '正在下载并校验更新…' : (check?.hasUpdate ? `一键更新（${remote?.targetRef === 'main' ? '最新 main' : remote?.targetRef}）` : '本地一键更新 / 覆盖最新')))),
    el('p', { className: 'card-sub' }, '本地一键更新直接从 GitHub 下载最新插件压缩包，通过完整性校验后仅原地更新插件程序文件；你的 B 站登录态、人设、记忆、日记和设置全部保存在独立数据目录中，不会丢失。'),
    local.isGitCheckout
      ? el('div', { className: 'banner warn' }, '当前插件目录检测到 .git（源码开发仓库），已禁用覆盖更新；请直接在仓库中运行 git pull 与部署脚本。')
      : null,
    state.updateResult
      ? el('div', { className: `banner ${state.updateResult.kind}` }, state.updateResult.text)
      : null,
    state.updateError
      ? el('div', { className: 'banner err' }, state.updateError)
      : null,
    el('div', { className: 'grid-2' },
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, '当前本地版本'),
        el('div', { className: 'stat-v' }, `v${local.version || '1.0.0'}`),
        el('div', { className: 'row-hint mono', style: { marginTop: '4px' } },
          local.installedCommit ? `已安装提交：${local.installedCommit.slice(0, 7)} · ${fmtTime(local.updatedAt)}` : '来源：本地首次部署 / 手动放入 plugins')),
      el('div', { className: 'stat-tile' },
        el('div', { className: 'stat-k' }, 'GitHub 远程最新状态'),
        el('div', { className: 'stat-v' }, remote ? `v${remote.latestVersion}${remote.mainCommit ? `（${remote.mainCommit.shortSha}）` : ''}` : '点击右上角「检查更新」获取'),
        el('div', { className: 'row-hint', style: { marginTop: '4px' } },
          remote?.mainCommit
            ? `${remote.mainCommit.message || '最新提交'} · ${fmtTime(remote.mainCommit.date)}`
            : (check ? check.summary : '支持检测 Release 正式版本与 main 分支最新提交')))),
    remote?.release?.notes
      ? el('details', { className: 'fold', open: true },
          el('summary', {}, `更新说明（${remote.release.name}）`),
          el('pre', { className: 'console-out' }, remote.release.notes))
      : null)

  const infoCard = el('div', { className: 'card' },
    el('h2', {}, '安装路径与移植说明'),
    row('插件安装目录', '本地一键更新只会覆盖此目录下的插件程序文件。', el('span', { className: 'mono' }, local.pluginRoot || '-')),
    row('独立数据目录', '保存 config.json、credentials.json、persona.md、记忆与日记；更新与重装插件均不会覆盖。', el('span', { className: 'mono' }, local.dataDir || '%USERPROFILE%\\.antigravity-bili-whale')),
    row('上游原项目致谢', '移植自 Alterssss/dsh-bili-whale（MIT License），专为 Windows 版 Antigravity App 原生重构。',
      el('button', { type: 'button', className: 'btn sm', onClick: () => actions.openUrl('https://github.com/Alterssss/dsh-bili-whale') }, '查看上游仓库')))

  return el('div', {}, heroCard, updateCard, infoCard)
}
