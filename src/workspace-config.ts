/**
 * The project-level configuration file, `.dsh/workspace.yml`.
 *
 * Why a file at all: the plugin's row config lives in a DSH *profile*, and one
 * row serves every workspace in the process — the profile cannot say "memory is
 * off in this repository". Anything a project should decide for itself has to
 * travel with the project. `.dsh/workspace.yml` is that file, and it belongs to
 * DSH rather than to WorkBuddy because the plugin is DSH-specific: the
 * `.workbuddy/` tree is a compatibility surface it reads, not a place it owns.
 *
 * The format is meant to be reusable by other DSH plugins:
 *
 * ```yaml
 * version: 1
 * layers:                  # convenience: applies to every plugin section
 *   rules: false
 * workspace-conventions:   # one section per plugin, keyed by its loader row id
 *   memory: read-only
 * ```
 *
 * A plugin owns the shape of its own section and addresses it by the id its row
 * carries in the composition, so two plugins cannot collide on a section name.
 * A section with no `workspace-conventions` key simply means this plugin is
 * unconfigured, not misconfigured.
 *
 * Two rules keep a typo from becoming a silent change of behaviour:
 *
 * 1. Unknown keys inside this plugin's own section are reported, never ignored —
 *    `memroy: off` must not read as "use the default".
 * 2. A file that cannot be read or parsed fails the layer **closed** (disabled)
 *    instead of falling back to defaults, so a broken switch cannot quietly
 *    leave a layer on.
 *
 * Reading is asynchronous and cached by the caller; the prompt provider that
 * consumes the result is synchronous by contract.
 *
 * @module @jinngoo/dsh-workspace-conventions/workspace-config
 */

import { dirname, join } from 'node:path'

import { DEFAULT_DIR } from './layout.js'
import { parseMapDocument, PatchFormatError, type PatchMap, type PatchValue } from './patch.js'

/** The configuration format version this module understands. */
export const WORKSPACE_CONFIG_VERSION = 1

/** Workspace-relative path of the project-level configuration file. */
export const WORKSPACE_CONFIG_REL = `${DEFAULT_DIR}/workspace.yml`

/** The section this plugin owns, matching the `id` its row carries. */
export const CONFIG_SECTION = 'workspace-conventions'

/** How the memory layer behaves. `read-only` keeps reading but stops writing. */
export type MemoryMode = 'enabled' | 'read-only' | 'disabled'

/**
 * Where new memory ledgers are written.
 *
 * `auto` keeps whatever layout the store already uses. `host` puts them under a
 * per-computer subdirectory (the WorkBuddy layout, which lets one repository be
 * shared between machines without two ledgers colliding). `flat` keeps them in
 * the store directory itself.
 */
export type MemoryLayoutPreference = 'auto' | 'flat' | 'host'

/** The layers whose global counterpart a workspace may inherit or block. */
export interface InheritConfig {
  /** `true` merges the global persona fragments; `false` blocks them. */
  readonly persona: boolean
  /** `true` may fall back to the global mood state; `false` blocks it. */
  readonly mood: boolean
  /** `true` injects and reads the global memory index; `false` blocks it. */
  readonly memory: boolean
  /** `true` injects the global rule books; `false` blocks them. */
  readonly rules: boolean
}

/** The resolved switches for this plugin's layers plus the two scope axes. */
export interface LayerConfig {
  /** `enabled` injects and writes, `read-only` stops writing, `disabled` is off. */
  readonly memory: MemoryMode
  /** `true` injects rule books, `false` disables the layer. */
  readonly rules: boolean
  /** `true` publishes `.workbuddy/skills`, `false` disables the layer. */
  readonly skills: boolean
  /** `true` injects persona fragments, `false` disables the layer. */
  readonly persona: boolean
  /** `true` injects the mood state, `false` disables the layer. */
  readonly mood: boolean
  /** Whether each layer inherits the global scope's counterpart. */
  readonly inherit: InheritConfig
  /** Which layout new ledgers use. */
  readonly memoryLayout: MemoryLayoutPreference
}

/** The switches every workspace starts from. */
export const DEFAULT_LAYERS: LayerConfig = {
  memory: 'enabled',
  rules: true,
  skills: true,
  persona: true,
  mood: true,
  inherit: { persona: true, mood: true, memory: true, rules: true },
  memoryLayout: 'auto',
}

/** The global scope is inherited by default; blocking one layer is a per-workspace opt-out. */
export const DEFAULT_INHERIT: InheritConfig = { persona: true, mood: true, memory: true, rules: true }

/**
 * What a file that could not be read or understood resolves to: every layer
 * stopped. Reporting a problem while still applying defaults would leave the
 * switch silently inert, which is the failure this file exists to prevent.
 *
 * `memoryLayout` is not a layer, so it keeps its default — with the memory layer
 * stopped there is no ledger to write. `inherit` keeps its defaults because it
 * only narrows what a live layer may read, and every live layer is stopped here.
 */
const FAIL_CLOSED: LayerConfig = {
  memory: 'disabled',
  rules: false,
  skills: false,
  persona: false,
  mood: false,
  inherit: DEFAULT_INHERIT,
  memoryLayout: 'auto',
}

/** One problem found while reading the file. */
export interface ConfigIssue {
  /** 1-based line in the configuration file; `0` when the problem has no line. */
  readonly line: number
  /** What is wrong, in a form that names the offending key. */
  readonly message: string
}

/** The outcome of reading `.dsh/workspace.yml` for one workspace. */
export interface ParsedWorkspaceConfig {
  /** Workspace-relative path, for display. */
  readonly rel: string
  /** Absolute path, for diagnostics. */
  readonly path: string
  /** Whether the file exists at all. */
  readonly exists: boolean
  /** Every problem found; empty means the file was read and understood. */
  readonly issues: readonly ConfigIssue[]
  /** The resolved switches, with defaults applied per field. */
  readonly layers: LayerConfig
  /** The raw document, for a consumer that wants a key of its own. */
  readonly sections: PatchMap | undefined
  /** Whether this workspace's file was seeded by this plugin just now. */
  readonly created?: boolean
}

/** The result of folding a raw document into this plugin's switches. */
interface Interpretation {
  readonly layers: LayerConfig
  readonly issues: readonly ConfigIssue[]
}

/** The slice of the host filesystem this module needs, so it stays testable. */
export interface ConfigReader {
  /** Whether a path is an existing file. */
  stat: (path: string) => Promise<boolean>
  /** The file's text, or `undefined` when it cannot be read. */
  read: (path: string) => Promise<string | undefined>
  /** Create a directory and its parents, when the caller wants seeding. */
  mkdir?: (path: string) => Promise<void>
}

/**
 * Read one workspace's configuration file.
 *
 * Never throws: an unreadable or malformed file becomes an issue, and the
 * switches then fail closed.
 * @param reader - host file access for the workspace in question.
 * @param workspace - the workspace root.
 * @returns the resolved configuration.
 */
export async function readWorkspaceConfig(reader: ConfigReader, workspace: string): Promise<ParsedWorkspaceConfig> {
  const absolute = join(workspace, WORKSPACE_CONFIG_REL)
  const base = { rel: WORKSPACE_CONFIG_REL, path: absolute, sections: undefined as PatchMap | undefined }
  const unreadable = (): ParsedWorkspaceConfig => ({
    ...base,
    exists: true,
    issues: [{ line: 0, message: 'the file exists but could not be read; every layer is disabled until it can be' }],
    layers: FAIL_CLOSED,
  })

  // An absent file is simply unconfigured; one that exists but cannot be read is
  // a broken switch, and those are different answers.
  if (!(await reader.stat(absolute))) return { ...base, exists: false, issues: [], layers: DEFAULT_LAYERS }

  const text = await reader.read(absolute)
  if (text === undefined) return unreadable()

  let document: PatchMap
  try {
    document = parseMapDocument(text, WORKSPACE_CONFIG_REL)
  } catch (error) {
    const line = error instanceof PatchFormatError ? error.line : 0
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...base,
      exists: true,
      issues: [{ line, message: `not valid configuration: ${message}` }],
      layers: FAIL_CLOSED,
    }
  }

  const { layers, issues } = interpret(document)
  return {
    ...base,
    exists: true,
    issues,
    // Any issue fails every layer closed. Reporting a typo while still applying
    // the defaults would leave the switch silently inert, which is the exact
    // failure this file is supposed to prevent.
    layers: issues.length === 0 ? layers : FAIL_CLOSED,
    sections: document,
  }
}

/** The mutable shape `interpret` folds into; the exported `LayerConfig` stays readonly. */
interface MutableLayers {
  memory: MemoryMode
  rules: boolean
  skills: boolean
  persona: boolean
  mood: boolean
  inherit: InheritConfig
  memoryLayout: MemoryLayoutPreference
}

/**
 * Fold a parsed document into this plugin's switches.
 * @param document - the parsed top-level map.
 * @returns the switches, plus every problem found on the way.
 */
export function interpret(document: PatchMap): Interpretation {
  const issues: ConfigIssue[] = []
  const layers: MutableLayers = { ...DEFAULT_LAYERS, inherit: { ...DEFAULT_INHERIT } }

  const version = document['version']
  if (version !== undefined && typeof version !== 'number') {
    issues.push({ line: 0, message: `\`version\` must be a number, found ${describe(version)}` })
  } else if (typeof version === 'number' && version !== WORKSPACE_CONFIG_VERSION) {
    issues.push({
      line: 0,
      message: `\`version: ${String(version)}\` is not the version this plugin understands (${String(WORKSPACE_CONFIG_VERSION)})`,
    })
  }

  applySection(document['layers'], 'layers', layers, issues)
  applySection(document[CONFIG_SECTION], CONFIG_SECTION, layers, issues)

  return { layers, issues }
}

/**
 * Read a layer-keyed section into the resolved switches.
 *
 * `layers` is the convenience section that applies to every plugin; the
 * plugin's own section has the same shape, so both go through here. Two axes
 * live side by side: which layers run, and — in the nested `inherit` mapping —
 * whether each running layer may also read the global scope's counterpart.
 */
function applySection(
  section: PatchValue | undefined,
  name: string,
  layers: MutableLayers,
  issues: ConfigIssue[],
): void {
  if (section === undefined) return
  if (!isPlainObject(section)) {
    issues.push({ line: 0, message: `\`${name}\` must be a mapping of layer switches, found ${describe(section)}` })
    return
  }

  for (const key of Object.keys(section)) {
    const raw = Reflect.get(section, key) as PatchValue

    if (key === 'memory') {
      const mode = readMemoryMode(raw, `${name}.memory`, issues)
      if (mode !== undefined) layers.memory = mode
      continue
    }

    if (key === 'rules' || key === 'skills' || key === 'persona' || key === 'mood') {
      const enabled = readToggle(raw, `${name}.${key}`, issues)
      if (enabled !== undefined) layers[key] = enabled
      continue
    }

    if (key === 'memoryLayout') {
      const layout = readMemoryLayout(raw, `${name}.memoryLayout`, issues)
      if (layout !== undefined) layers.memoryLayout = layout
      continue
    }

    if (key === 'inherit') {
      applyInherit(raw, `${name}.inherit`, layers, issues)
      continue
    }

    issues.push({
      line: 0,
      message: `\`${name}\` has an unknown key \`${key}\`; this plugin understands \`memory\`, \`memoryLayout\`, \`rules\`, \`skills\`, \`persona\`, \`mood\`, \`inherit\``,
    })
  }
}

/**
 * Read the nested `inherit` mapping.
 *
 * A layer named here that is not one of the four inheritable ones is an issue
 * rather than a silent ignore: writing `inherit: { remember: false }` and
 * believing the global memory is blocked is exactly the inert-switch failure the
 * rest of this file guards against.
 * @param raw - the mapping value.
 * @param where - dotted path for messages.
 * @param layers - switches to update in place.
 * @param issues - issue sink.
 */
function applyInherit(raw: PatchValue, where: string, layers: MutableLayers, issues: ConfigIssue[]): void {
  if (!isPlainObject(raw)) {
    issues.push({ line: 0, message: `\`${where}\` must be a mapping of layer switches, found ${describe(raw)}` })
    return
  }
  for (const key of Object.keys(raw)) {
    const value = Reflect.get(raw, key) as PatchValue
    if (key !== 'persona' && key !== 'mood' && key !== 'memory' && key !== 'rules') {
      issues.push({
        line: 0,
        message: `\`${where}\` has an unknown layer \`${key}\`; it understands \`persona\`, \`mood\`, \`memory\`, \`rules\``,
      })
      continue
    }
    const enabled = readToggle(value, `${where}.${key}`, issues)
    if (enabled !== undefined) layers.inherit = { ...layers.inherit, [key]: enabled }
  }
}

/** Read which layout new ledgers use. */
function readMemoryLayout(raw: PatchValue, where: string, issues: ConfigIssue[]): MemoryLayoutPreference | undefined {
  if (raw === 'auto' || raw === 'flat' || raw === 'host') return raw

  issues.push({
    line: 0,
    message: `\`${where}\` must be one of \`auto\`/\`flat\`/\`host\`, found ${describe(raw)}`,
  })
  return undefined
}

/** Read a plain on/off switch. */
function readToggle(raw: PatchValue, where: string, issues: ConfigIssue[]): boolean | undefined {
  if (typeof raw === 'boolean') return raw

  issues.push({ line: 0, message: `\`${where}\` must be true or false, found ${describe(raw)}` })
  return undefined
}

/** Read the memory switch, which accepts the extra `read-only` state. */
function readMemoryMode(raw: PatchValue, where: string, issues: ConfigIssue[]): MemoryMode | undefined {
  if (typeof raw === 'boolean') return raw ? 'enabled' : 'disabled'
  if (raw === 'read-only') return 'read-only'

  if (raw === 'enabled' || raw === 'disabled') return raw

  issues.push({
    line: 0,
    message: `\`${where}\` must be true, false, or one of \`enabled\`/\`read-only\`/\`disabled\`, found ${describe(raw)}`,
  })
  return undefined
}

/** Whether the layer is on at all, treating `read-only` as on for reading. */
export function isMemoryReadable(mode: MemoryMode): boolean {
  return mode !== 'disabled'
}

/** Whether the layer accepts writes. */
export function isMemoryWritable(mode: MemoryMode): boolean {
  return mode === 'enabled'
}

/** A short, unambiguous rendering of a value for an error message. */
function describe(value: PatchValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'object') return 'a mapping'
  return `\`${String(value)}\``
}

/**
 * The starter file created when a workspace has none.
 *
 * Every line is commented out, so creating the file changes no behaviour — it
 * exists to be discovered and edited. That is the point of writing it at all: a
 * file nobody knows about is indistinguishable from a feature that does not
 * exist, and putting a real default value in it would silently re-implement the
 * default it replaced.
 */
export const WORKSPACE_CONFIG_TEMPLATE = `# 项目级工作区配置（DSH）。全部内容可选——本文件全注释时行为等于「所有层全开、并继承全局」。
# 插件各占一段，段名是该插件在组合里的行 id；本插件是 workspace-conventions。
# 规格与复用约定：@jinngoo/dsh-workspace-conventions 的 docs/workspace-config.md
#
# 未知键或类型不对会让所有层全部停用，并在工具里报出原因（防拼错的开关静默失效）。
#
# version: 1
#
# layers:                    # 便捷段，作用于每个插件段
#   rules: false
#
# workspace-conventions:
#   # 第一轴：这一层是否启用
#   memory: enabled          # enabled | read-only | disabled
#   rules: true
#   skills: true
#   persona: true
#   mood: true
#   memoryLayout: auto       # auto | flat | host
#
#   # 第二轴：是否继承全局作用域（false = 屏蔽全局，只看本工作区）
#   inherit:
#     persona: true
#     mood: true
#     memory: true
#     rules: true
`

/** The outcome of making sure a workspace has a configuration file. */
export interface EnsureResult {
  /** Whether this call created the file. */
  readonly created: boolean
  /** Whether the path is now occupied by a file, whoever created it. */
  readonly exists: boolean
  /** The absolute path considered. */
  readonly path: string
}

/**
 * Create the starter configuration file when a workspace has none.
 *
 * Never overwrites: a file that is already there — written by a user, or by an
 * earlier call to this function — is left exactly as it is.
 * @param reader - host file access for the workspace in question.
 * @param writer - writes the file's text.
 * @param workspace - the workspace root.
 * @param report - sink for a write that was refused, so the reason is not lost.
 * @returns what happened, so the caller can report it.
 */
export async function ensureWorkspaceConfig(
  reader: ConfigReader,
  writer: (path: string, text: string) => Promise<void>,
  workspace: string,
  report: (message: string) => void = () => undefined,
): Promise<EnsureResult> {
  const absolute = join(workspace, WORKSPACE_CONFIG_REL)
  if (await reader.stat(absolute)) return { created: false, exists: true, path: absolute }

  try {
    // `.dsh/` usually does not exist yet in a project that has never been
    // configured, and a write into a missing directory fails outright.
    await reader.mkdir?.(dirname(absolute))
    // Re-check immediately before writing: the filesystem read above can await,
    // and a file another process (or the user's editor) created in that window
    // must win over the starter template rather than be overwritten by it.
    if (await reader.stat(absolute)) return { created: false, exists: true, path: absolute }
    await writer(absolute, WORKSPACE_CONFIG_TEMPLATE)
    return { created: true, exists: true, path: absolute }
  } catch (error) {
    // A workspace the sandbox refuses, or a read-only checkout, is not worth
    // failing a turn over — but a silently swallowed reason is worth reporting,
    // so the caller can say why the file did not appear.
    report(error instanceof Error ? error.message : String(error))
    return { created: false, exists: false, path: absolute }
  }
}

function isPlainObject(value: PatchValue): value is PatchMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
