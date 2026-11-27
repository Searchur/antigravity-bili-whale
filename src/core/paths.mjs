/**
 * 统一路径解析（Windows Antigravity App 独立数据目录）。
 *
 * 所有状态、配置、凭据、记忆库、抽帧缓存与专用工作区
 * 全部收口到独立目录：%USERPROFILE%\.antigravity-bili-whale\
 * （测试或便携场景可通过环境变量 BILI_WHALE_HOME 覆盖）。
 *
 * 不共用 DSH（~/.dsh）或 ~/.bili-ai 目录，确保完全隔离。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHome } from './home.mjs'

/** 插件安装根目录 */
export const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** B 站统一 CLI 入口脚本 */
export const biliCliPath = path.join(PLUGIN_ROOT, 'src', 'cli', 'bili.mjs')

/** 预打包单文件控制台前端产物 */
export const appHtmlPath = path.join(PLUGIN_ROOT, 'dist', 'app.html')

/** 插件随包自带的行为规范目录 */
export const behaviorRoot = path.join(PLUGIN_ROOT, 'behavior')

/** 当前 Windows 用户主目录 */
export const HOME = resolveHome()

/** 插件独立数据根目录（支持 BILI_WHALE_HOME 覆盖） */
export const WHALE_HOME = process.env.BILI_WHALE_HOME
  ? path.resolve(process.env.BILI_WHALE_HOME)
  : path.join(HOME, '.antigravity-bili-whale')

/** 内部兼容别名（保持既有模块参数命名最小改动，实际恒指向 WHALE_HOME） */
export const DSH_HOME = WHALE_HOME

/** 拼接位于独立数据根目录下的路径 */
export const whalePath = (...parts) => path.join(WHALE_HOME, ...parts)

/** 内部兼容别名 */
export const dshPath = whalePath
export const dataPath = whalePath

/** 拼接用户主目录下路径（仅用于显式外部定位） */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 插件配置文件（支持 BILI_WHALE_CONFIG 覆盖） */
export const configPath = process.env.BILI_WHALE_CONFIG
  ? path.resolve(process.env.BILI_WHALE_CONFIG)
  : whalePath('config.json')

/** B 站登录凭据（Windows icacls 仅本人可读，绝不回显） */
export const credentialsPath = whalePath('credentials.json')

/** 鲸鱼专属人设文档 */
export const personaPath = whalePath('persona.md')

/** 鲸鱼专用隔离工作目录 */
export const workDirPath = whalePath('whale-work')

/** 封面/字幕/抽帧缓存目录 */
export const shotsPath = whalePath('shots')

/** 插件本地二进制目录，可放置自行安装的 ffmpeg.exe */
export const binPath = whalePath('bin')

/** Sidecar ↔ MCP Server 本机回环 IPC 端点描述文件 */
export const ipcPath = whalePath('sidecar-ipc.json')

/** 插件随包自带的表情包目录（开箱即用，无需手动复制） */
export const bundledStickerRoot = path.join(PLUGIN_ROOT, 'stickers')

/** 用户自定义表情包目录（存在 index.json 时优先覆盖自带目录） */
export const userStickerRoot = whalePath('stickers')
