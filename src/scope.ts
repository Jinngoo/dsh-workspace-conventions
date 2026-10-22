/**
 * 双层作用域：`workspace`（`<workspace>/.dsh`）与 `global`（默认 `$DSH_HOME`）。
 *
 * 每一层（persona / mood / memory / rules）在两个作用域下各有一份目录，本模块
 * 只负责「作用域 → 根目录 → 层目录」的解析，不读文件、不碰缓存，因此可以纯函数
 * 测试。目录名统一从 {@link ./layout.ts} 取，避免两层作用域各自漂移。
 *
 * 全局根刻意做成可配置（{@link resolveGlobalRoot}）：`$DSH_HOME/{persona,mood,
 * memory,rules}` 现在是空的、没有其它机制占用，但记忆这一格未来被 DSH 官方或别的
 * 插件征用并非不可能。一旦冲突，换 `globalRoot` 即可整体搬家，无需改代码。
 *
 * @module @jinngoo/dsh-workspace-conventions/scope
 */

import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  DEFAULT_DIR,
  MEMORY_SUBDIR,
  MOOD_SUBDIR,
  PERSONA_SUBDIR,
  RULES_SUBDIR,
} from './layout.js'

/** 一份内容所处的作用域。 */
export type LayerScope = 'global' | 'workspace'

/** 全部受作用域管辖的层，顺序即注入顺序（persona → mood → rules → memory）。 */
export const LAYERS = ['persona', 'mood', 'rules', 'memory'] as const

/** 层名。 */
export type LayerName = (typeof LAYERS)[number]

/** 作用域的中文标签，供工具输出与 prompt 段落标题使用。 */
export const SCOPE_LABEL: Readonly<Record<LayerScope, string>> = { global: '全局', workspace: '工作区' }

/** 层的中文标签。 */
export const LAYER_LABEL: Readonly<Record<LayerName, string>> = {
  persona: '人格',
  mood: '情绪',
  rules: '规则',
  memory: '记忆',
}

/** 每一层在作用域根目录下的子目录名。 */
const LAYER_SUBDIR: Readonly<Record<LayerName, string>> = {
  persona: PERSONA_SUBDIR,
  mood: MOOD_SUBDIR,
  rules: RULES_SUBDIR,
  memory: MEMORY_SUBDIR,
}

/** 工作区作用域的根目录名（`.dsh`）。 */
export const WORKSPACE_ROOT_DIR = DEFAULT_DIR

/**
 * 解析全局作用域的根目录。
 *
 * 优先级：显式配置 `globalRoot` > 进程的 `DSH_HOME` > `~/.dsh`。与 DSH 自己的
 * `@deepseek-ai/dsh-home-paths` 保持同一顺序，但不引入该依赖（本包零依赖）。
 * @param configured - 行配置里的 `globalRoot`；空白或省略表示跟随 `$DSH_HOME`。
 * @returns 绝对路径的全局根。
 */
export function resolveGlobalRoot(configured?: string): string {
  const explicit = configured?.trim()
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * 某个作用域的根目录。
 * @param scope - 作用域。
 * @param workspace - 会话的工作目录。
 * @param globalRoot - 已解析的全局根（见 {@link resolveGlobalRoot}）。
 * @returns 该作用域的根目录。
 */
export function scopeRoot(scope: LayerScope, workspace: string, globalRoot: string): string {
  return scope === 'workspace' ? join(workspace, WORKSPACE_ROOT_DIR) : globalRoot
}

/**
 * 层目录：`<scope root>/<layer subdir>`。
 * @param root - 作用域根目录。
 * @param layer - 层名。
 * @returns 该层的目录绝对路径。
 */
export function layerDir(root: string, layer: LayerName): string {
  return join(root, LAYER_SUBDIR[layer])
}

/**
 * 工作区作用域下某一层的目录（`<workspace>/.dsh/<layer>`）。
 * @param workspace - 会话的工作目录。
 * @param layer - 层名。
 * @returns 该层的工作区目录。
 */
export function workspaceLayerDir(workspace: string, layer: LayerName): string {
  return layerDir(join(workspace, WORKSPACE_ROOT_DIR), layer)
}

/**
 * 全局作用域下某一层的目录（`<globalRoot>/<layer>`）。
 * @param globalRoot - 已解析的全局根。
 * @param layer - 层名。
 * @returns 该层的全局目录。
 */
export function globalLayerDir(globalRoot: string, layer: LayerName): string {
  return layerDir(globalRoot, layer)
}

/** 去掉末尾分隔符并统一大小写，用于路径包含判断。 */
function canonical(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * `candidate` 是否等于 `parent` 或位于其内部。
 *
 * 用来判断一个计划写入的路径是否被当前文件策略允许、以及全局目录是否被工作区
 * 目录意外覆盖。大小写按平台语义处理（Windows 不敏感）。
 * @param parent - 外层目录。
 * @param candidate - 待判断的路径。
 * @returns 是否位于外层之内。
 */
export function isWithin(parent: string, candidate: string): boolean {
  const outer = canonical(parent)
  const inner = canonical(candidate)
  if (outer === inner) return true
  const rel = relative(outer, inner)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
