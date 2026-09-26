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

/** The resolved switches for this plugin's three layers. */
export interface LayerConfig {
  /** `enabled` injects and writes, `read-only` stops writing, `disabled` is off. */
  readonly memory: MemoryMode
  /** `true` injects rule books, `false` disables the layer. */
  readonly rules: boolean
  /** `true` publishes `.workbuddy/skills`, `false` disables the layer. */
  readonly skills: boolean
  /** Which layout new ledgers use. */
  readonly memoryLayout: MemoryLayoutPreference
}

/** The switches every workspace starts from. */
export const DEFAULT_LAYERS: LayerConfig = { memory: 'enabled', rules: true, skills: true, memoryLayout: 'auto' }

/**
 * What a file that could not be read or understood resolves to: every layer
 * stopped. Reporting a problem while still applying defaults would leave the
 * switch silently inert, which is the failure this file exists to prevent.
 *
 * `memoryLayout` is not a layer, so it keeps its default — with the memory layer
 * stopped there is no ledger to write.
 */
const FAIL_CLOSED: LayerConfig = { memory: 'disabled', rules: false, skills: false, memoryLayout: 'auto' }

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

/**
 * Fold a parsed document into this plugin's switches.
 * @param document - the parsed top-level map.
 * @returns the switches, plus every problem found on the way.
 */
export function interpret(document: PatchMap): Interpretation {
  const issues: ConfigIssue[] = []
  const layers: { memory: MemoryMode, rules: boolean, skills: boolean, memoryLayout: MemoryLayoutPreference } = { ...DEFAULT_LAYERS }

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
 * plugin's own section has the same shape, so both go through here.
 */
function applySection(
  section: PatchValue | undefined,
  name: string,
  layers: { memory: MemoryMode, rules: boolean, skills: boolean, memoryLayout: MemoryLayoutPreference },
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

    if (key === 'rules' || key === 'skills') {
      const enabled = readToggle(raw, `${name}.${key}`, issues)
      if (enabled !== undefined) layers[key] = enabled
      continue
    }

    if (key === 'memoryLayout') {
      const layout = readMemoryLayout(raw, `${name}.memoryLayout`, issues)
      if (layout !== undefined) layers.memoryLayout = layout
      continue
    }

    issues.push({
      line: 0,
      message: `\`${name}\` has an unknown key \`${key}\`; this plugin understands \`memory\`, \`memoryLayout\`, \`rules\`, \`skills\``,
    })
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
export const WORKSPACE_CONFIG_TEMPLATE = `# 项目级工作区配置（DSH）。
#
# 顶层是一个容器：\`version\`、\`layers\`，以及若干「插件段」。
# 每个插件段以该插件在组合里的行 id 命名，各自解释自己的字段，
# 因此两个插件不会撞名，别的插件也能复用同一个文件。
#
# 本插件的行 id 是 \`workspace-conventions\`。完整规格见
# \`@jinngoo/dsh-workspace-conventions\` 的 docs/workspace-config.md。
#
# 全部内容可选：删掉这个文件、或只留注释，行为与「三层全开」完全一致。
#
# version: 1
#
# # 便捷段：作用于每个插件段；插件段里的同名键优先。
# layers:
#   rules: false
#
# workspace-conventions:
#   # 记忆层。read-only = 不注入记忆段落、拒绝写入与提升，读工具照常。
#   memory: enabled          # enabled | read-only | disabled
#   # 规则层：段落注入、条件册触发、rule_read / rule_status 一起开关。
#   rules: true
#   # 技能层：.workbuddy/skills 是否发布进原生技能目录；关闭则不扫描该目录。
#   skills: true
#   # 记忆布局：新流水写到哪里。auto = 沿用目录里已有的布局。
#   memoryLayout: auto       # auto | flat | host
#
# 注意：未知键或类型不对会让**三层全部停用**，并在工具调用与
# \`rule_status\` 里报出逐条原因——让一个拼错的开关静默失效，
# 正是这份文件要防的事。
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
