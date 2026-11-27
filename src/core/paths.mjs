/**
 * 统一路径解析（Windows Antigravity App 插件根目录与独立数据目录）。
 *
 * 所有状态、配置、凭据、记忆库、抽帧缓存与专用工作区
 * 全部收口到独立目录：%USERPROFILE%\.antigravity-bili-whale\
 * （测试或便携场景可通过环境变量 BILI_WHALE_HOME 覆盖）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHome } from './home.mjs'
import { dataPathsFor } from './data-paths.mjs'

export { dataPathsFor } from './data-paths.mjs'

/** 插件安装根目录 */
export const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** B 站统一 CLI 入口脚本 */
export const biliCliPath = path.join(PLUGIN_ROOT, 'src', 'cli', 'bili.mjs')

/** 预打包单文件控制台前端产物 */
export const appHtmlPath = path.join(PLUGIN_ROOT, 'dist', 'app.html')

/** 插件随包自带的行为规范目录 */
export const behaviorRoot = path.join(PLUGIN_ROOT, 'behavior')

/** 插件内置安全审核核心模块路径 */
export const safetyRulesPath = path.join(PLUGIN_ROOT, 'src', 'social', 'content-safety.mjs')

/** 插件随包自带的表情包目录（开箱即用，无需手动复制） */
export const bundledStickerRoot = path.join(PLUGIN_ROOT, 'stickers')

/** 当前 Windows 用户主目录 */
export const HOME = resolveHome()

/** 插件独立数据根目录（支持 BILI_WHALE_HOME 覆盖） */
export const WHALE_HOME = process.env.BILI_WHALE_HOME
  ? path.resolve(process.env.BILI_WHALE_HOME)
  : path.join(HOME, '.antigravity-bili-whale')

/** 拼接位于独立数据根目录下的路径 */
export const whalePath = (...parts) => path.join(WHALE_HOME, ...parts)

/** 兼容别称（等价于 whalePath） */
export const dataPath = whalePath

/** 拼接用户主目录下路径（仅用于显式外部定位） */
export const homePath = (...parts) => path.join(HOME, ...parts)

/** 插件配置文件（支持 BILI_WHALE_CONFIG 覆盖） */
export const configPath = process.env.BILI_WHALE_CONFIG
  ? path.resolve(process.env.BILI_WHALE_CONFIG)
  : whalePath('config.json')

/** 基于当前 WHALE_HOME 与 configPath 预计算的六类数据目录路径集合 */
export const DATA_PATHS = dataPathsFor(WHALE_HOME, { cfgFile: configPath })

/** B 站登录凭据（Windows icacls 仅本人可读，绝不回显） */
export const credentialsPath = DATA_PATHS.credentials

/** 鲸鱼专属人设文档 */
export const personaPath = DATA_PATHS.persona

/** 鲸鱼专用隔离工作目录 */
export const workDirPath = DATA_PATHS.workspaceDir

/** 封面/字幕/抽帧缓存目录 */
export const shotsPath = DATA_PATHS.shotsDir

/** 插件本地二进制目录，可放置自行安装的 ffmpeg.exe */
export const binPath = DATA_PATHS.binDir

/** Sidecar ↔ MCP Server 本机回环 IPC 端点描述文件 */
export const ipcPath = DATA_PATHS.sidecarIpc

/** 用户自定义表情包目录（存在 index.json 时优先覆盖自带目录） */
export const userStickerRoot = DATA_PATHS.stickersDir
