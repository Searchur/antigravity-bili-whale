/**
 * debrief 的默认渲染器：把 buildDebriefReport() 产出的 report 渲染成终端文本行。
 *
 * 约定：render(report) -> { lines: string[] }
 *   · 每行一个字符串，**不带换行符**（调用方 debrief.mjs 逐行 console.log；那里有主人昵称/mid 打码的
 *     console.log 包装，所以文本必须经过 console.log，不能直接 process.stdout.write）；
 *   · 这里只做排版：不请求、不读文件、不打印；
 *   - 顺序和缩进沿用现有报告格式，展示文案遵循项目统一的标点用法。
 *
 * 覆盖的六段（+ 结尾提示）：
 *   ① 元信息  ② 封面  ③ 官方字幕  ④ 弹幕热区  ⑤ 热评  ⑥ 画面 / ⑥b 字幕条
 *   结尾「下一步」提示
 */

// 与 debrief.mjs 里的同名函数一致（mm:ss）。渲染器不 import 采集脚本，纯函数在这里留一份。
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
// 弹幕排行：出现 1 次只写文本，多次写「文本×次数」
const joinTop = (list) => list.map(({ text, count }) => (count > 1 ? `${text}×${count}` : text)).join(' | ')

export function render(report) {
  const lines = []
  const push = (...xs) => { for (const x of xs) lines.push(x) }
  const meta = report.meta ?? {}
  const stat = meta.stat ?? {}
  const options = report.options ?? {}

  // ── ① 元信息（它自称是什么）──
  push('══════════ ① 元信息（它自称是什么）══════════')
  push(`标题: ${meta.title}`)
  push(`UP: ${meta.owner}   时长: ${fmt(meta.durSeconds)}   分区: ${meta.tname || '-'}   发布: ${new Date(meta.pubdateMs).toLocaleDateString('zh-CN')}`)
  push(`播放 ${stat.view}  点赞 ${stat.like}  收藏 ${stat.favorite}  投币 ${stat.coin}  弹幕 ${stat.danmaku}  评论 ${stat.reply}`)
  if (meta.desc) push(`简介: ${meta.desc.replace(/\n+/g, ' / ').slice(0, 300)}`)

  // ── ② 封面（已随响应附带，或通过 bili_read read-shot 查看）──
  const cover = report.cover ?? {}
  push('', '══════════ ② 封面 ══════════')
  if (cover.ok) push(`${cover.file}（已随工具响应附带，或用 bili_read read-shot 查看）`)
  else push(`封面下载失败：${cover.error}`)

  // ── ③ 官方字幕（它到底说了什么）──
  push('', '══════════ ③ 官方字幕（它到底说了什么）══════════')
  const sub = report.subtitles ?? { mode: 'none' }
  if (sub.pages?.length) {
    push('有字幕：'+sub.pages.reduce((n,p)=>n+p.entries.length,0)+' 行 → '+sub.file)
    push('采样分 P '+sub.selectedPages.join(', ')+'；弹幕与画面对齐第一分 P。')
  } else if (sub.mode === 'single') {
    push(`有字幕：${sub.lineCount} 行（${fmt(sub.fromSeconds)} → ${fmt(sub.toSeconds)}）→ ${sub.file}`)
  } else {
    push('✗ 无官方字幕轨道 → 这一路缺失，只能靠弹幕 + 热评 + 画面（这正是要六路互补的原因）')
  }

  // ── ④ 弹幕热区（对齐到字幕时间轴）──
  push('', '══════════ ④ 弹幕热区（观众在哪炸了）══════════')
  const dm = report.danmaku ?? { available: false }
  if (!dm.available) {
    push('（没取到弹幕：可能被风控或该视频关闭弹幕）')
  } else {
    // ⚠️ XML 只给采样集 → 标称条数和采样比一起打，别让人把「实际拿到」当全集
    push(`实际拿到 ${dm.count} 条` +
      (dm.claimed ? ` ／ 接口标称 ${dm.claimed} 条（采样比约 1/${dm.sampleRatio}）` : ''))
    if (dm.spam) {
      push(`⚠️ 疑似刷屏波（归一化后单句占全片 >30%，已剔除；命中 ${dm.spam.hits} 条 / ${((dm.spam.hits / dm.count) * 100).toFixed(0)}%）：`)
      for (const k of dm.spam.keys) push(`     ${k.count} 条  归一化: ${k.normalized.slice(0, 40)}`)
    }
    push(`覆盖 ${dm.bucketCount} 桶；剔刷屏后共 ${dm.realTotal} 条，平均 ${dm.avgReal.toFixed(1)} 条/桶`)
    push('', `--- 最热的 ${options.topN} 段（按有效条数排序；≥平均 1.5 倍标 🔥）---`)
    for (const p of dm.peaks) {
      push('', `${p.hot ? '🔥' : '  '} [${fmt(p.start)}–${fmt(p.end)}]  有效 ${p.realCount} 条（原始 ${p.rawCount} 条）`)
      if (p.subtitleLine) push(`     字幕: ${p.subtitleLine}`)
      push(`     弹幕: ${p.top.length ? joinTop(p.top) : '（无有效内容）'}`)
    }
    push('', `全程高频弹幕（已剔刷屏）: ${joinTop(dm.topAll)}`)
  }

  // ── ⑤ 热评（看完的人怎么看）──
  push('', '══════════ ⑤ 热评（看完的人怎么看）══════════')
  const cm = report.comments ?? { items: [] }
  if (cm.error) {
    push(`（热评拉取失败：${cm.error}）`)
  } else if (!(cm.items ?? []).length) {
    push(`（没取到热评：code=${cm.code}）`)
  } else {
    for (const r of cm.items) {
      push(`  👍${String(r.like).padStart(5)}  回复${String(r.rcount ?? 0).padStart(3)}  ${r.uname}: ${r.text}`)
    }
  }

  // ── ⑥ 画面 ──
  const fr = report.frames ?? { enabled: false }
  if (fr.enabled) {
    push('', '══════════ ⑥ 画面（长什么样）══════════')
    for (const line of fr.toolLines ?? []) push(line)
    if (fr.error) push(`（抽帧失败：${fr.error}）`)

    // ── ⑥b 字幕条拼图（--substrip [每N秒]）──
    const st = fr.strip ?? { enabled: false }
    if (st.enabled) {
      push('', '══════════ ⑥b 字幕条（硬字幕拼图）══════════')
      if (st.error) {
        push(`（字幕条失败：${st.error}）`)
      } else if (st.noMp4) {
        push('（没有可用的 mp4，跳过字幕条）')
      } else {
        push(`STRIP: ${st.outPng}`)
        push(`取帧方式: 每 ${st.everySeconds} 秒一帧 × ${st.rows} 行，裁下画面下方 32% 的字幕带`)
        push('（可结合 bili_read read-shot 查看 —— 整片台词基本都在这一张图里）')
      }
    }
  }

  // ── 下一步（交给模型）──
  push('', '══════════ 下一步（交给模型）══════════')
  push('结合封面与画面拼图（随工具响应附带或通过 bili_read read-shot 查看），再把上面各路信息合起来形成判断 —— 脚本只备素材，不作判断。')

  return { lines }
}
