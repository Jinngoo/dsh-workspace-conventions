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

import { join } from 'node:path'

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

/** The resolved switches for this plugin's three layers. */
export interface LayerConfig {
  /** `enabled` injects and writes, `read-only` stops writing, `disabled` is off. */
  readonly memory: MemoryMode
  /** `true` injects rule books, `false` disables the layer. */
  readonly rules: boolean
  /** `true` publishes `.workbuddy/skills`, `false` disables the layer. */
  readonly skills: boolean
}

/** The switches every workspace starts from. */
export const DEFAULT_LAYERS: LayerConfig = { memory: 'enabled', rules: true, skills: true }

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
    layers: { memory: 'disabled', rules: false, skills: false },
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
      layers: { memory: 'disabled', rules: false, skills: false },
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
    layers: issues.length === 0 ? layers : { memory: 'disabled', rules: false, skills: false },
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
  const layers: { memory: MemoryMode, rules: boolean, skills: boolean } = { ...DEFAULT_LAYERS }

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
  layers: { memory: MemoryMode, rules: boolean, skills: boolean },
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

    issues.push({
      line: 0,
      message: `\`${name}\` has an unknown key \`${key}\`; this plugin understands \`memory\`, \`rules\`, \`skills\``,
    })
  }
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

function isPlainObject(value: PatchValue): value is PatchMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
