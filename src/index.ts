/**
 * DSH workspace conventions as a composable row: memory, rules and skills.
 *
 * One agent preset mounts this row once; each session joining that scope reads
 * and writes inside **its own working directory**. Three compatibility layers
 * share one store probe and one principle — if the workspace already keeps a
 * WorkBuddy store, follow that system's own shape and criteria; otherwise fall
 * back to a DSH-default location with the same model.
 *
 * | layer | WorkBuddy source | DSH fallback | how it reaches the model |
 * |---|---|---|---|
 * | memory | `.workbuddy/memory/` | `.dsh/memory/` | prompt section + six tools |
 * | rules | `.workbuddy/rules/*.md` | — | prompt section + two tools |
 * | skills | `.workbuddy/skills/` | — | a registered `ctx.skills` provider |
 *
 * The rules layer reproduces WorkBuddy's own contract: `alwaysApply: true` books
 * are injected every turn, `paths:` books are injected once a matching file is
 * read or changed, and a book is capped at 16 KB. The skills layer publishes
 * bundles through the ordinary skill catalog instead of a private loader, so the
 * stock `skill` tool loads them with their relative resources resolved.
 *
 * Two constraints are load-bearing and easy to get wrong:
 *
 * 1. `systemPrompt.context()` is **synchronous** — `assemble()` does not await a
 *    provider, so an `async` provider returns a Promise instead of a string and
 *    fails every turn. Every probe therefore runs asynchronously into a cache and
 *    the providers render that cache synchronously.
 * 2. `fs.writeText()` must be given the **session** sandbox policy. Without a
 *    session, the sandbox falls back to the deployment's default workspace root
 *    and denies writes inside this session's own workspace.
 *
 * @module @jinngoo/dsh-workspace-conventions
 */

import { hostname } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type PreToolDecision, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { approveEscalation, validateEscalationArgs, writableRoots, type EscalationApprover } from '@deepseek-ai/dsh-sandbox'

import {
  GLOBAL_MEMORY_FILE,
  GLOBAL_MEMORY_TITLE,
  checkGlobalEntry,
  flattenEntries,
  globalMemoryBytes as documentBytes,
  parseGlobalMemory,
  reviseGlobalMemory,
  sectionTitle,
  upsertGlobalEntry,
  type GlobalMemoryDocument,
} from './global-memory.js'

import { DEFAULT_DIR, INDEX_FILE, MEMORY_SUBDIR, RULES_SUBDIR, WORKBUDDY_DIR } from './layout.js'
import { approvalRequestFor } from './approval.js'
import {
  ENTRY_KINDS,
  HARD_RULES,
  evaluateEntry,
  ledgerForDate,
  ledgerWritePath,
  renderEntry,
  scanLedgers,
  upsertIndexEntry,
  type DirEntry,
  type HostDirScan,
  type LedgerFile,
  type LedgerLayout,
} from './memory.js'
import {
  RULES_DIR_REL,
  RULE_FILE_BYTES,
  matchingRules,
  parseRule,
  renderRulesSection,
  type RuleDefinition,
} from './rules.js'
import {
  DEFAULT_MOOD_HALF_LIFE_HOURS,
  DEFAULT_MOOD_MAX_AGE_HOURS,
  MOOD_FILE_NAME,
  buildMoodDocument,
  moodView,
  parseMoodDocument,
  renderMoodMaintenanceSection,
  renderMoodSection,
  type MoodState,
} from './mood.js'
import {
  mergePersona,
  parsePersonaFragment,
  renderPersonaSection,
  sortPersona,
  type PersonaFragment,
} from './persona.js'
import {
  globalLayerDir,
  resolveGlobalRoot,
  workspaceLayerDir,
  type LayerScope,
} from './scope.js'
import {
  SKILLS_DIR_REL,
  createWorkbuddySkillProvider,
  type SkillStoreReader,
} from './skills.js'
import { dateStamp, normalizeText, toPosix } from './text.js'
import {
  CONFIG_SECTION,
  DEFAULT_LAYERS,
  WORKSPACE_CONFIG_REL,
  ensureWorkspaceConfig,
  isMemoryWritable,
  readWorkspaceConfig,
  type ParsedWorkspaceConfig,
} from './workspace-config.js'

export const name = 'workspace-conventions'

/**
 * Every service this row reaches. All six are host-plane and are only consumed;
 * the row publishes nothing, so it needs no `isolate` realm. `tools` is required
 * because registration goes through `ctx.tools.register`, and `skills` because
 * the WorkBuddy skill bundles are published as a provider on the shared registry
 * rather than through a private loader.
 */
export const inject = ['fs', 'agents', 'systemPrompt', 'sandboxPolicy', 'tools', 'skills']

export {
  DEFAULT_DIR,
  ENTRY_KINDS,
  HARD_RULES,
  INDEX_FILE,
  RULES_DIR_REL,
  RULE_FILE_BYTES,
  SKILLS_DIR_REL,
  WORKBUDDY_DIR,
  dateStamp,
  evaluateEntry,
  ledgerForDate,
  ledgerWritePath,
  normalizeText,
  renderEntry,
  scanLedgers,
  toPosix,
  upsertIndexEntry,
}
export { detectSectionLevel, parseIndexDocument } from './memory.js'
export {
  DEFAULT_MOOD_HALF_LIFE_HOURS,
  DEFAULT_MOOD_MAX_AGE_HOURS,
  MOOD_FILE_NAME,
  buildMoodDocument,
  moodView,
  parseMoodDocument,
  renderMoodMaintenanceSection,
  renderMoodSection,
} from './mood.js'
export { approvalRequestFor, digestOf } from './approval.js'
export type { ApprovalPolicy, ApprovalRequest, GatedToolCall } from './approval.js'
export {
  mergePersona,
  parsePersonaFragment,
  renderPersonaSection,
  sortPersona,
} from './persona.js'
export {
  LAYERS as SELF_LAYERS,
  globalLayerDir,
  isWithin,
  layerDir,
  resolveGlobalRoot,
  scopeRoot,
  workspaceLayerDir,
} from './scope.js'
export { DEFAULT_INHERIT } from './workspace-config.js'
export type { MoodDecayOptions, MoodRenderOptions, MoodState, MoodView } from './mood.js'
export type { PersonaFragment, PersonaMerge, PersonaRender, PersonaRenderOptions } from './persona.js'
export type { LayerName, LayerScope } from './scope.js'
export { parseFrontmatter, readFrontmatterBoolean } from './frontmatter.js'
export { expandBraces, matchGlob } from './glob.js'
export { matchingRules, parseRule, renderRulesSection } from './rules.js'
export { parseSkill } from './skills.js'
export type { EntryKind, EntryVerdict, LedgerEntry, LedgerLayout, LedgerScan } from './memory.js'
export type { Frontmatter, BooleanRead } from './frontmatter.js'
export type { RuleDefinition } from './rules.js'
export type { WorkbuddySkill } from './skills.js'

/** Plugin config: how much of each store is injected each turn, and per-book caps. */
export interface Config {
  /**
   * Byte cap on the index text injected into the prompt every turn. The
   * remainder stays reachable through `memory_read`. Keeps a large WorkBuddy
   * index from crowding out the conversation.
   */
  indexPromptBytes: number
  /**
   * Byte cap on the whole injected rules section. 常驻册 are placed first and
   * survive truncation; a triggered 条件册 that does not fit degrades to a
   * heading plus a `rule_read` pointer rather than disappearing. This is a guard
   * rail against a pathological rules directory, not an allocation: a workspace
   * whose books fit pays only for what they actually cost, and the default is
   * sized so a project can hold a few standing books plus all of its conditional
   * books without losing one.
   */
  rulesPromptBytes: number
  /** Per-book byte cap, matching WorkBuddy's own ~16 KB contract. */
  ruleFileBytes: number
  /**
   * Byte cap on the injected persona section (`persona/*.md` fragments of both
   * scopes). Kept well below the rules budget: persona is identity prose, not a
   * reference manual, and every turn pays for it.
   */
  personaPromptBytes: number
  /** Per-fragment byte cap; a longer fragment is truncated and pointed at by `persona_read`. */
  personaFileBytes: number
  /** Byte cap on the injected mood line. Deliberately tiny: a mood is one line of state. */
  moodPromptBytes: number
  /** Half-life of the mood decay, in hours. After one half-life the state reads half as strong. */
  moodHalfLifeHours: number
  /** Age after which a mood is reported as settled instead of current. */
  moodMaxAgeHours: number
  /** Byte cap on the global (cross-workspace) memory index section. */
  globalIndexPromptBytes: number
  /**
   * Hard byte budget of the single global memory document. The global scope is a
   * curated long-lived profile, not a date-partitioned ledger: it is injected
   * every turn and rewritten in place, so an unbounded file would poison both the
   * context and the user's profile. A write that would exceed this budget is
   * refused with a "revise first" hint instead of being silently truncated.
   */
  globalMemoryBytes: number
  /** Byte cap on the global rules section, kept separate so neither scope starves the other. */
  globalRulesPromptBytes: number
  /**
   * Override for the global scope root. Empty follows the process `$DSH_HOME`
   * and falls back to `~/.dsh`, matching DSH's own home resolution.
   *
   * The default puts the four global layer directories at `$DSH_HOME/{persona,
   * mood,memory,rules}` — names DSH itself does not use today. If a future
   * mechanism claims one of them, pointing this at a private directory moves
   * every global layer without a code change.
   */
  globalRoot: string
  /**
   * Require a one-time user approval before a write to the GLOBAL memory scope
   * (`memory_write` / `memory_promote` with `scope: "global"`).
   *
   * Global memory is injected into every workspace, so it is the one memory
   * store whose mistakes travel. The approval prompt carries a bounded excerpt
   * of the entry; a rejection means the tool body never runs.
   */
  approveGlobalMemory: boolean
  /**
   * Require a one-time user approval before ANY `persona_write`, in either
   * scope. Persona is identity prose injected every turn, and a workspace
   * fragment can be as costly as a global one; `false` restores the old
   * tool-only behaviour.
   */
  approvePersonaWrite: boolean
  /**
   * Encourage the model to update the workspace mood opportunistically while
   * the mood layer is on. This only adds a short prompt section; it never writes
   * on its own and never forces a call. `false` removes the section entirely.
   */
  moodProactive: boolean
}

/** Every config default in one object: the row schema and the defensive merge both read it. */
const CONFIG_DEFAULTS: Config = {
  indexPromptBytes: 7000,
  rulesPromptBytes: 48 * 1024,
  ruleFileBytes: RULE_FILE_BYTES,
  personaPromptBytes: 3 * 1024,
  personaFileBytes: 8 * 1024,
  moodPromptBytes: 512,
  moodHalfLifeHours: DEFAULT_MOOD_HALF_LIFE_HOURS,
  moodMaxAgeHours: DEFAULT_MOOD_MAX_AGE_HOURS,
  globalIndexPromptBytes: 4 * 1024,
  globalMemoryBytes: 4 * 1024,
  globalRulesPromptBytes: 12 * 1024,
  globalRoot: '',
  approveGlobalMemory: true,
  approvePersonaWrite: true,
  moodProactive: true,
}

/** Runtime schema for the row. */
export const Config: z<Config> = z.object({
  indexPromptBytes: z.number().default(CONFIG_DEFAULTS.indexPromptBytes),
  rulesPromptBytes: z.number().default(CONFIG_DEFAULTS.rulesPromptBytes),
  ruleFileBytes: z.number().default(CONFIG_DEFAULTS.ruleFileBytes),
  personaPromptBytes: z.number().default(CONFIG_DEFAULTS.personaPromptBytes),
  personaFileBytes: z.number().default(CONFIG_DEFAULTS.personaFileBytes),
  moodPromptBytes: z.number().default(CONFIG_DEFAULTS.moodPromptBytes),
  moodHalfLifeHours: z.number().default(CONFIG_DEFAULTS.moodHalfLifeHours),
  moodMaxAgeHours: z.number().default(CONFIG_DEFAULTS.moodMaxAgeHours),
  globalIndexPromptBytes: z.number().default(CONFIG_DEFAULTS.globalIndexPromptBytes),
  globalMemoryBytes: z.number().default(CONFIG_DEFAULTS.globalMemoryBytes),
  globalRulesPromptBytes: z.number().default(CONFIG_DEFAULTS.globalRulesPromptBytes),
  globalRoot: z.string().default(CONFIG_DEFAULTS.globalRoot),
  approveGlobalMemory: z.boolean().default(CONFIG_DEFAULTS.approveGlobalMemory),
  approvePersonaWrite: z.boolean().default(CONFIG_DEFAULTS.approvePersonaWrite),
  moodProactive: z.boolean().default(CONFIG_DEFAULTS.moodProactive),
})

/** The resolved state of one workspace's memory store. */
interface WorkspaceMemoryState {
  readonly name: string
  readonly compat: boolean
  readonly dir: string
  readonly index: string
  readonly hasIndex: boolean
  readonly bytes: number
  readonly indexText: string
  /** This computer's name, as the OS reports it. */
  readonly host: string
  /** The layout discovered in the active store. */
  readonly layout: LedgerLayout
  /** Computer-name subdirectory receiving new ledgers; `''` in the flat layout. */
  readonly hostDir: string
  /** Every dated ledger in the active store, newest first. */
  readonly ledgers: readonly LedgerFile[]
  readonly candidates: readonly {
    readonly name: string
    readonly dir: string
    readonly exists: boolean
    readonly hasIndex: boolean
    readonly ledgerCount: number
    readonly layout: LedgerLayout
  }[]
}

/** The resolved state of one workspace's rule directory. */
interface WorkspaceRulesState {
  /** Absolute rules directory. */
  readonly dir: string
  /** Workspace-relative rules directory, for display. */
  readonly dirRel: string
  /** Whether the rules directory exists. */
  readonly exists: boolean
  /** Every parsed book, sorted by file name. */
  readonly rules: readonly RuleDefinition[]
}

/** One workspace memory store (the dated-ledger backend). */
interface MemoryStoreState {
  /** Absolute store directory. */
  readonly dir: string
  /** Absolute index path. */
  readonly index: string
  /** Whether an index file exists. */
  readonly hasIndex: boolean
  /** Index size in bytes. */
  readonly bytes: number
  /** Index text, or `''` when absent. */
  readonly indexText: string
  /** This computer's name, as the OS reports it. */
  readonly host: string
  /** The layout discovered in the store. */
  readonly layout: LedgerLayout
  /** Computer-name subdirectory receiving new ledgers; `''` in the flat layout. */
  readonly hostDir: string
  /** Every dated ledger in the store, newest first. */
  readonly ledgers: readonly LedgerFile[]
}

/**
 * The resolved state of the GLOBAL memory document.
 *
 * Deliberately not a {@link MemoryStoreState}: the global scope is one curated
 * file injected every turn, not a directory of dated ledgers. Reusing the ledger
 * shape is what made the old global scope accumulate instead of curate.
 */
interface GlobalMemoryState {
  /** Absolute global memory directory. */
  readonly dir: string
  /** Absolute document path (`<dir>/MEMORY.md`). */
  readonly path: string
  /** Whether the document exists on disk. */
  readonly exists: boolean
  /** Document size in bytes. */
  readonly bytes: number
  /** Document text, or `''` when absent. */
  readonly text: string
  /** The parsed document. */
  readonly document: GlobalMemoryDocument
  /** Every entry, flattened in document order. */
  readonly entries: readonly { readonly section: string, readonly kind: string, readonly text: string }[]
  /** Number of non-empty sections. */
  readonly sections: number
}

/** The workspace persona fragments plus the issues met while parsing them. */
interface WorkspacePersonaState {
  /** Fragments found under `<workspace>/.dsh/persona`, sorted by order then name. */
  readonly fragments: readonly PersonaFragment[]
  /** Parse issues worth reporting through the status tools. */
  readonly issues: readonly string[]
}

const EMPTY_RULES: ReadonlySet<string> = new Set()

/**
 * Register the memory tools, the rules tools, the two prompt sections and the
 * skill provider for the mounting scope.
 * @param ctx - an agent-scope context supplying `fs`, `agents`, `systemPrompt`, `sandboxPolicy`, `tools` and `skills`.
 * @param config - the injected-index cap, the rules cap and the per-book cap.
 */
export function apply(ctx: Context, config: Config): void {
  // Defensive merge: a hand-composed row (or an older profile patch) can call
  // apply() with only the fields it knows about. The schema fills defaults on the
  // official path; this makes the function total on every path.
  config = { ...CONFIG_DEFAULTS, ...config }
  const indexPromptBytes = config.indexPromptBytes
  const rulesPromptBytes = config.rulesPromptBytes
  const ruleFileBytes = config.ruleFileBytes
  const personaPromptBytes = config.personaPromptBytes
  const personaFileBytes = config.personaFileBytes
  const moodPromptBytes = config.moodPromptBytes
  const moodHalfLifeHours = config.moodHalfLifeHours
  const moodMaxAgeHours = config.moodMaxAgeHours
  const globalIndexPromptBytes = config.globalIndexPromptBytes
  const globalMemoryBytes = config.globalMemoryBytes
  const globalRulesPromptBytes = config.globalRulesPromptBytes
  const approveGlobalMemory = config.approveGlobalMemory
  const approvePersonaWrite = config.approvePersonaWrite
  const moodProactive = config.moodProactive
  const fs = ctx.fs
  const agents = ctx.agents
  const prompt = ctx.systemPrompt
  const host = hostname()
  /** The global scope root: `globalRoot` when configured, else `$DSH_HOME`/`~/.dsh`. */
  const globalRoot = resolveGlobalRoot(config.globalRoot.length > 0 ? config.globalRoot : undefined)

  const cache = new Map<string, WorkspaceMemoryState>()
  const rulesCache = new Map<string, WorkspaceRulesState>()
  const personaCache = new Map<string, WorkspacePersonaState>()
  /**
   * One mood state per workspace, plus the single global mood.
   *
   * `null` means "probed and absent", which is a different answer from "not
   * probed yet": the prompt provider must warm up on the first case, and stay
   * silent on the second rather than claiming a settled mood nobody wrote.
   */
  const moodCache = new Map<string, MoodState | null>()
  const globalCache: {
    memory: GlobalMemoryState | undefined
    rules: readonly RuleDefinition[] | undefined
    persona: readonly PersonaFragment[] | undefined
    mood: MoodState | null | undefined
  } = { memory: undefined, rules: undefined, persona: undefined, mood: undefined }
  /** Project-level switches per workspace, from `.dsh/workspace.yml`. */
  const configCache = new Map<string, { readonly config: ParsedWorkspaceConfig, readonly stamp: string | undefined }>()
  /**
   * Conditional books already triggered, keyed by workspace.
   *
   * Workspace rather than session: a rule book describes the workspace, and once
   * a matching file has been touched in this workspace the book is relevant to
   * the ongoing work. Over-injecting a rule is far safer than never injecting it,
   * and this avoids depending on agent-object identity between the tool-result
   * listener and the synchronous prompt provider.
   */
  const triggered = new Map<string, Set<string>>()
  /**
   * Conditional GLOBAL rule books already triggered, keyed by workspace.
   *
   * Triggers stay per workspace even though the books are global: "this project
   * touched a matching file" is the relevance signal, and a book triggered in one
   * project must not be injected into another.
   */
  const globalTriggered = new Map<string, Set<string>>()
  const sessions = new Map<string, unknown>()
  let invalidateSkills: (() => void) | undefined

  const agentNow = (): unknown => agents.currentInitiator() as unknown

  const sessionOf = (agent: unknown): unknown =>
    (agent as { readonly session?: unknown } | undefined)?.session

  const workspaceOf = (agent: unknown): string | undefined => {
    const header = (sessionOf(agent) as { readonly header?: { readonly cwd?: unknown } } | undefined)?.header
    const cwd = header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  }

  const currentSession = (): unknown => sessionOf(agentNow()) ?? [...sessions.values()][0]

  const currentWorkspace = (): string | undefined => {
    const live = workspaceOf(agentNow())
    if (live !== undefined) return live
    return [...sessions.keys()][0]
  }

  /**
   * Resolve the sandbox policy for one session.
   *
   * Load-bearing: without the session, the sandbox falls back to the deployment
   * default workspace root and denies a write inside the session's own workspace.
   */
  const policyFor = (session: unknown): SandboxExecutionPolicy | undefined =>
    ctx.sandboxPolicy.resolve(session === undefined ? {} : { session: session as never })

  const statAt = async (target: string): Promise<{ readonly type?: string, readonly size?: number, readonly mtimeMs?: number } | undefined> => {
    try {
      const t = await fs.resolve(target)
      const info = await fs.stat(t)
      return info as { readonly type?: string, readonly size?: number, readonly mtimeMs?: number } | undefined
    } catch { return undefined }
  }

  const listAt = async (dir: string): Promise<readonly { readonly name: string, readonly type?: string }[]> => {
    try {
      const t = await fs.resolve(dir)
      return await fs.listDir(t) as readonly { readonly name: string, readonly type?: string }[]
    } catch { return [] }
  }

  const readAt = async (target: string): Promise<string | undefined> => {
    try {
      const t = await fs.resolve(target)
      if (await fs.stat(t) === undefined) return undefined
      return await fs.readText(t)
    } catch { return undefined }
  }

  const writeAt = async (
    target: string,
    content: string,
    session: unknown,
    policy?: SandboxExecutionPolicy,
  ): Promise<string> => {
    const t = await fs.resolve(target)
    await fs.writeText(t, content, undefined, undefined, policy ?? policyFor(session))
    return toPosix(t.displayPath)
  }

  /**
   * Probe one memory store directory.
   *
   * One level of subdirectories is scanned only: under the per-computer layout a
   * machine name is a direct child of the store directory, and nothing deeper
   * holds ledgers. Dot directories are skipped so version-control metadata is
   * never scanned. The same probe serves the workspace backends and the single
   * global store, so both scopes read identically.
   */
  const storeOf = async (
    dir: string,
    preferredLayout: 'auto' | 'flat' | 'host',
  ): Promise<{ readonly exists: boolean; readonly state: MemoryStoreState }> => {
    const index = join(dir, INDEX_FILE)
    const info = await statAt(dir)
    const exists = info?.type === 'directory'
    const root = exists ? await listAt(dir) : []
    const subdirs = await Promise.all(
      root
        .filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.'))
        .map(async (entry): Promise<HostDirScan> => ({ name: entry.name, entries: await listAt(join(dir, entry.name)) })),
    )
    const scan = scanLedgers(root, subdirs, host, preferredLayout)
    const indexText = exists ? await readAt(index) : undefined
    const indexInfo = indexText === undefined ? undefined : await statAt(index)
    return {
      exists,
      state: {
        dir,
        index,
        hasIndex: indexText !== undefined,
        bytes: indexInfo?.size ?? 0,
        indexText: indexText ?? '',
        host,
        ...scan,
      },
    }
  }

  /** Probe both memory backends for one workspace and resolve the active one. */
  const loadState = async (workspace: string): Promise<WorkspaceMemoryState> => {
    const probe = async (backendName: string, dir: string) => {
      const probed = await storeOf(dir, configCache.get(workspace)?.config.layers.memoryLayout ?? DEFAULT_LAYERS.memoryLayout)
      return { name: backendName, exists: probed.exists, ...probed.state }
    }

    const workbuddy = await probe('workbuddy', join(workspace, WORKBUDDY_DIR, MEMORY_SUBDIR))
    const fallback = await probe('dsh-default', join(workspace, DEFAULT_DIR, MEMORY_SUBDIR))
    // An existing WorkBuddy memory system wins; the DSH default is the fallback.
    const active = workbuddy.exists ? workbuddy : fallback

    const state: WorkspaceMemoryState = {
      name: active.name,
      compat: workbuddy.exists,
      dir: active.dir,
      index: active.index,
      hasIndex: active.hasIndex,
      bytes: active.bytes,
      indexText: active.indexText,
      host,
      layout: active.layout,
      hostDir: active.hostDir,
      ledgers: active.ledgers,
      candidates: [workbuddy, fallback].map((r) => ({
        name: r.name,
        dir: toPosix(r.dir),
        exists: r.exists,
        hasIndex: r.hasIndex,
        ledgerCount: r.ledgers.length,
        layout: r.layout,
      })),
    }
    cache.set(workspace, state)
    return state
  }

  /** Read every rule book in one workspace. */
  const loadRules = async (workspace: string): Promise<WorkspaceRulesState> => {
    const dir = join(workspace, WORKBUDDY_DIR, RULES_SUBDIR)
    const info = await statAt(dir)
    const exists = info?.type === 'directory'
    const entries: readonly DirEntry[] = exists ? await listAt(dir) : []
    const rules: RuleDefinition[] = []
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      if (entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md')) continue
      const source = await readAt(join(dir, entry.name))
      if (source === undefined) continue
      rules.push(parseRule(entry.name, source))
    }
    rules.sort((left, right) => left.file.localeCompare(right.file))
    const state: WorkspaceRulesState = { dir: toPosix(dir), dirRel: RULES_DIR_REL, exists, rules }
    rulesCache.set(workspace, state)
    return state
  }

  /** Read persona fragments from one directory, scoped for shadowing. */
  const readPersonaDir = async (
    dir: string,
    scope: LayerScope,
  ): Promise<{ readonly fragments: readonly PersonaFragment[], readonly issues: readonly string[] }> => {
    const info = await statAt(dir)
    const entries = info?.type === 'directory' ? await listAt(dir) : []
    const fragments: PersonaFragment[] = []
    const issues: string[] = []
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      if (entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md')) continue
      const raw = await readAt(join(dir, entry.name))
      if (raw === undefined) continue
      const parsed = parsePersonaFragment(scope, entry.name.slice(0, -3), raw)
      if (parsed.issue !== undefined) issues.push(parsed.issue)
      if (parsed.fragment !== undefined) fragments.push(parsed.fragment)
    }
    return { fragments: sortPersona(fragments), issues }
  }

  /** Read one workspace's persona fragments into the cache. */
  const loadPersona = async (workspace: string): Promise<WorkspacePersonaState> => {
    const read = await readPersonaDir(workspaceLayerDir(workspace, 'persona'), 'workspace')
    for (const issue of read.issues) ctx.logger.warn(issue)
    const state: WorkspacePersonaState = { fragments: read.fragments, issues: read.issues }
    personaCache.set(workspace, state)
    return state
  }

  /** Read one workspace's mood state into the cache; `null` records "absent". */
  const loadMood = async (workspace: string): Promise<MoodState | null> => {
    const dir = workspaceLayerDir(workspace, 'mood')
    const raw = await readAt(join(dir, MOOD_FILE_NAME))
    const parsed: { state?: MoodState, issue?: string } = raw === undefined ? {} : parseMoodDocument(raw)
    if (parsed.issue !== undefined) ctx.logger.warn(`${toPosix(dir)}: ${parsed.issue}`)
    const state = parsed.state ?? null
    moodCache.set(workspace, state)
    return state
  }

  /**
   * Read the global memory document into the cache.
   *
   * One file, parsed into sections and entries: absent is a normal state (a fresh
   * profile), not an error. Legacy dated ledgers from the pre-0.7 layout are not
   * read here — the read tool points at them explicitly so nothing is silently
   * lost or silently injected.
   */
  const loadGlobalMemory = async (): Promise<GlobalMemoryState> => {
    const dir = globalLayerDir(globalRoot, 'memory')
    const path = join(dir, GLOBAL_MEMORY_FILE)
    const raw = await readAt(path)
    const text = raw === undefined ? '' : normalizeText(raw)
    const document = parseGlobalMemory(text)
    const entries = flattenEntries(document)
    const state: GlobalMemoryState = {
      dir,
      path,
      exists: raw !== undefined,
      bytes: documentBytes(text),
      text,
      document,
      entries,
      sections: document.sections.filter((section) => section.entries.length > 0).length,
    }
    globalCache.memory = state
    return state
  }

  /** Read every global rule book into the cache. */
  const loadGlobalRules = async (): Promise<readonly RuleDefinition[]> => {
    const dir = globalLayerDir(globalRoot, 'rules')
    const info = await statAt(dir)
    const entries = info?.type === 'directory' ? await listAt(dir) : []
    const rules: RuleDefinition[] = []
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      if (entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md')) continue
      const source = await readAt(join(dir, entry.name))
      if (source === undefined) continue
      rules.push(parseRule(entry.name, source))
    }
    rules.sort((left, right) => left.file.localeCompare(right.file))
    globalCache.rules = rules
    return rules
  }

  /** Read the global persona fragments into the cache. */
  const loadGlobalPersona = async (): Promise<readonly PersonaFragment[]> => {
    const read = await readPersonaDir(globalLayerDir(globalRoot, 'persona'), 'global')
    for (const issue of read.issues) ctx.logger.warn(issue)
    globalCache.persona = read.fragments
    return read.fragments
  }

  /** Read the global mood state into the cache; `null` records "absent". */
  const loadGlobalMood = async (): Promise<MoodState | null> => {
    const dir = globalLayerDir(globalRoot, 'mood')
    const raw = await readAt(join(dir, MOOD_FILE_NAME))
    const parsed: { state?: MoodState, issue?: string } = raw === undefined ? {} : parseMoodDocument(raw)
    if (parsed.issue !== undefined) ctx.logger.warn(`${toPosix(dir)}: ${parsed.issue}`)
    const state = parsed.state ?? null
    globalCache.mood = state
    return state
  }

  /**
   * Reload the whole global scope.
   *
   * Global layers are process-wide, so they are read once and then only on a
   * write that could have changed them — not on every workspace probe.
   */
  const refreshGlobal = (): void => {
    void loadGlobalMemory().catch(() => undefined)
    void loadGlobalRules().catch(() => undefined)
    void loadGlobalPersona().catch(() => undefined)
    void loadGlobalMood().catch(() => undefined)
  }

  /** Load the global scope the first time any workspace is probed. */
  const ensureGlobal = (): void => {
    if (globalCache.memory === undefined) refreshGlobal()
  }

  const refresh = (workspace: string | undefined): void => {
    if (workspace === undefined) return
    void loadState(workspace).catch(() => undefined)
    void loadRules(workspace).catch(() => undefined)
    void loadPersona(workspace).catch(() => undefined)
    void loadMood(workspace).catch(() => undefined)
    ensureGlobal()
    // `configFor`, not `loadConfig`: this is the live provider path, so it is the
    // one that seeds a missing starter file and revalidates a changed one.
    void configFor(workspace).catch(() => undefined)
  }

  const stateFor = async (workspace: string): Promise<WorkspaceMemoryState> =>
    cache.get(workspace) ?? await loadState(workspace)

  const rulesFor = async (workspace: string): Promise<WorkspaceRulesState> =>
    rulesCache.get(workspace) ?? await loadRules(workspace)

  /**
   * Read `.dsh/workspace.yml` for one workspace.
   *
   * This is the only source of the three layer switches. A workspace whose file
   * is missing — or which simply has no section for this plugin — resolves to
   * every layer on, so nothing changes for a project that never opts in.
   *
   * The cached entry records the file's size and modification time, because a
   * cache that is never revalidated would freeze the answer from the moment the
   * row loaded: a config file added a second later would never take effect.
   */
  /** How the configuration file is read, for both the live path and the verifiers. */
  const configReader = {
    stat: async (path: string) => (await statAt(path))?.type === 'file',
    read: readAt,
    mkdir: async (path: string) => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(path, { recursive: true })
    },
  }

  /** Whether this process writes the starter configuration file into workspaces. */
  const seedsConfig = (): boolean => process.env['DSH_SEED_WORKSPACE_CONFIG'] !== '0'

  const loadConfig = async (workspace: string): Promise<ParsedWorkspaceConfig> => {
    const config = await readWorkspaceConfig(configReader, workspace)
    // The stamp goes on *after* the file exists, so the entry describes the file
    // that was actually read; a later edit moves the mtime and revalidates.
    configCache.set(workspace, { config, stamp: await configStamp(workspace) })
    if (config.issues.length > 0) {
      ctx.logger.warn(`${WORKSPACE_CONFIG_REL} in ${toPosix(workspace)}: ${config.issues.map((issue) => issue.message).join('; ')}`)
    }
    return config
  }

  /**
   * Seed the starter file when the workspace has none, then read the switches.
   *
   * Seeding is deliberately its own call rather than a hidden step of reading the
   * configuration: a read happens for every probe and every verifier, and those
   * must not write into a directory they are merely inspecting. Only the live
   * provider path takes this route.
   */
  /**
   * Seed the starter file when the workspace has none, then read the switches.
   *
   * Seeding is deliberately its own call rather than a hidden step of reading the
   * configuration: a read happens for every probe and every verifier, and those
   * must not write into a directory they are merely inspecting. Only the live
   * provider path takes this route, and `DSH_SEED_WORKSPACE_CONFIG=0` turns even
   * that off.
   */
  const loadConfigSeeding = async (workspace: string): Promise<ParsedWorkspaceConfig> => {
    // A filesystem that cannot write is not an error: the defaults are exactly
    // what the absent file meant.
    if (typeof (fs as { writeText?: unknown }).writeText === 'function') {
      const seeded = await ensureWorkspaceConfig(configReader, async (path, text) => {
        await writeAt(path, text, currentSession())
      }, workspace, (message) => {
        ctx.logger.warn(`could not create ${WORKSPACE_CONFIG_REL} in ${toPosix(workspace)}: ${message}`)
      })

      if (seeded.created) {
        const config = await loadConfig(workspace)
        const withFlag = { ...config, created: true }
        configCache.set(workspace, { config: withFlag, stamp: await configStamp(workspace) })
        return withFlag
      }
    }

    return await loadConfig(workspace)
  }

  /**
   * A value that changes exactly when the file's contents could have changed.
   *
   * This measures the file on disk; it must not consult the parsed config, whose
   * `exists` is exactly the stale answer being revalidated. "Absent" is a stamp of
   * its own, so a file that appears later cannot look identical to one that was
   * never there — which is precisely when a reload is needed.
   */
  const configStamp = async (workspace: string): Promise<string> => {
    const info = await statAt(join(workspace, WORKSPACE_CONFIG_REL))
    return info === undefined || info.type !== 'file' ? 'absent' : `${String(info.size)}:${String(info.mtimeMs)}`
  }

  /**
   * The switches in force for one workspace, revalidated before use.
   *
   * Tools await this, so a workspace's switches are in hand before the tool
   * decides anything. The prompt providers are synchronous and cannot wait, so
   * they read the cache through {@link cachedConfig} and treat "not probed yet"
   * as "use the defaults" — the same warm-up turn the other caches already have.
   */
  const configFor = async (workspace: string): Promise<ParsedWorkspaceConfig> => {
    const load = seedsConfig() ? loadConfigSeeding : loadConfig
    const cached = configCache.get(workspace)
    if (cached === undefined) return await load(workspace)

    if (await configStamp(workspace) !== cached.stamp) return await load(workspace)
    return cached.config
  }

  const cachedConfig = (workspace: string | undefined): ParsedWorkspaceConfig | undefined =>
    workspace === undefined ? undefined : configCache.get(workspace)?.config

  /** The verdict on one layer, from the cache only. */
  const layerOn = (workspace: string | undefined, layer: 'rules' | 'skills' | 'persona' | 'mood'): boolean => {
    const cached = cachedConfig(workspace)
    return cached === undefined ? DEFAULT_LAYERS[layer] : cached.layers[layer]
  }

  /** Whether one layer may also read the global scope, from the cache only. */
  const inheritOn = (workspace: string | undefined, layer: 'persona' | 'mood' | 'memory' | 'rules'): boolean => {
    const cached = cachedConfig(workspace)
    return cached === undefined ? true : cached.layers.inherit[layer]
  }

  /**
   * Refuse a tool call when its layer is off for this workspace.
   *
   * Tools are registered once, process-wide, and Cordis cannot unregister them
   * per workspace; the nearest honest equivalent is a refusal that names the file
   * and the switch, so the model learns why instead of reading an empty result as
   * "this workspace has nothing". A configuration file that failed to parse is
   * reported here in full, because in that state every layer is refused and the
   * prompt is empty — this message is then the only place the reason appears.
   */
  const refuseLayer = async (workspace: string, layer: 'memory' | 'rules' | 'skills' | 'persona' | 'mood'): Promise<JsonValue | undefined> => {
    const config = await configFor(workspace)
    const off = layer === 'memory' ? config.layers.memory === 'disabled' : config.layers[layer] === false
    if (!off) return undefined

    const label = layer === 'persona' ? 'persona（人格）' : layer === 'mood' ? 'mood（情绪）' : layer
    const issues = config.issues.map((issue) => (issue.line > 0 ? `line ${String(issue.line)}: ${issue.message}` : issue.message))
    return {
      ok: false,
      error: issues.length > 0
        ? `${WORKSPACE_CONFIG_REL} 有配置错误，所有层已全部停用：${issues.join('; ')}`
        : `${label} 层在本工作区已禁用（${WORKSPACE_CONFIG_REL} 的 ${CONFIG_SECTION}.${layer}）`,
      configFile: config.rel,
      configIssues: issues,
    } as unknown as JsonValue
  }

  /** Refuse a write when the memory layer is read-only or off. */
  const refuseWrite = async (workspace: string): Promise<JsonValue | undefined> => {
    const config = await configFor(workspace)
    if (config.layers.memory === 'enabled') return undefined

    if (config.layers.memory === 'read-only') {
      return {
        ok: false,
        written: false,
        error: `memory 层在本工作区为只读（${WORKSPACE_CONFIG_REL} 的 ${CONFIG_SECTION}.memory: read-only），拒绝写入`,
        configFile: config.rel,
      } as unknown as JsonValue
    }

    return refuseLayer(workspace, 'memory')
  }

  /** A short, quotable summary of the project-level switches, for the status tools. */
  const configSummary = (workspace: string): JsonValue => {
    const config = cachedConfig(workspace)
    if (config === undefined) {
      return { status: 'pending', file: WORKSPACE_CONFIG_REL, note: '尚未探测完成；本轮按默认（三层启用）运行' } as unknown as JsonValue
    }

    return {
      status: config.issues.length === 0 ? 'ok' : 'error',
      file: config.rel,
      exists: config.exists,
      layers: config.layers,
      ...config.issues.length > 0 ? { issues: config.issues.map((issue) => (issue.line > 0 ? `line ${String(issue.line)}: ${issue.message}` : issue.message)) } : {},
      note: config.created === true
        ? `工作区原本没有该文件，已写入一份**全部注释掉**的起手模板（不改变任何行为，仅供编辑）`
        : config.exists
          ? '项目级开关来自该文件；未出现的字段取默认（启用）'
          : '无项目级配置文件，三层全部启用',
    } as unknown as JsonValue
  }

  /** Render the memory prompt section from a cached snapshot. Total: it never throws. */
  const renderPrompt = (workspace: string, state: WorkspaceMemoryState): string => {
    const layoutPreference = cachedConfig(workspace)?.layers.memoryLayout ?? DEFAULT_LAYERS.memoryLayout
    const criteria = state.compat
      ? [
          '- MEMORY.md 只是索引与偏好：设计细节、模块现状、实机踩坑、环境限制一律查文档，不在索引里复述；冲突以文档为准。',
          '- 小事、小修改、一次性操作与排错过程不写记忆；只记跨会话仍有价值的内容，且优先落文档（索引只留指针）。',
          '- 日期文件是追加式流水；不重写、不重排已有内容。',
          '- 日期文件可能按计算机名分目录存放（`.workbuddy/memory/<计算机名>/YYYY-MM-DD.md`），也可能平铺在 `memory/` 下；读写与检索按目录实际形状进行。',
          '- 宁缺毋滥。',
        ]
      : [
          '- MEMORY.md 只放禁止遗忘的内容：硬约束、稳定偏好、长期约定、文档指针。',
          '- 细节、现状与排错过程写进文档或日期流水，不在索引里复述。',
          '- 小事、小修改、一次性操作不写记忆；只记跨会话仍有价值的内容。',
          '- 宁缺毋滥。',
        ]

    const lines = [      state.compat
        ? '# 工作区记忆（已检测到 WorkBuddy 体系，按原生准则兼容）'
        : '# 工作区记忆（无既有记忆体系，使用 DSH 默认规则）',
      '',
      `- 生效后端：${state.name}${state.compat ? '（兼容模式）' : '（默认模式）'}`,
      `- 记忆目录：${toPosix(state.dir)}`,
      `- 索引：${toPosix(state.index)}（${String(state.bytes)} 字节）`,
      `- 日期流水：${state.ledgers.length > 0
        ? state.ledgers.slice(0, 3).map((f) => f.rel).join(', ')
          + (state.ledgers.length > 3 ? ` 等共 ${String(state.ledgers.length)} 个` : '')
        : '无'}`,
      `- 流水布局：${state.layout === 'host' ? `按计算机名分目录（本机 ${state.host}）` : '平铺在记忆目录下'}${layoutPreference === 'auto' ? '' : '（由项目配置指定，未自动沿用目录已有布局）'}`,
      '',
      '写入准则：',
      ...criteria,
      '',
      '当前索引原文',
      '',
    ]

    if (state.hasIndex && state.indexText.length > 0) {
      const body = normalizeText(state.indexText)
      lines.push(body.length > indexPromptBytes
        ? `${body.slice(0, indexPromptBytes)}\n\n…（索引过长已截断，完整内容用 memory_read）`
        : body)
    } else {
      lines.push('（尚无记忆。本次任务若产生跨会话仍有价值的结论，用 memory_write 记录；确属禁止遗忘的硬约束再用 memory_promote 提升进索引。）')
    }
    return lines.join('\n')
  }

  /**
   * The freshest mood state this workspace may see.
   *
   * Moods are not blended: a two-minute-old project state and a week-old global
   * one are not the same kind of signal, and averaging them would invent a state
   * nobody wrote. The newest wins, and a state whose `updated` cannot be parsed
   * never wins over one that can.
   */
  const effectiveMood = (workspace: string, now: Date): MoodState | undefined => {
    const candidates: MoodState[] = []
    const local = moodCache.get(workspace)
    if (local !== undefined && local !== null) candidates.push(local)
    if (inheritOn(workspace, 'mood')) {
      const shared = globalCache.mood
      if (shared !== undefined && shared !== null) candidates.push(shared)
    }
    let best: MoodState | undefined
    let bestAge = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const view = moodView(candidate, now, { halfLifeHours: moodHalfLifeHours, maxAgeHours: moodMaxAgeHours })
      if (view.ageHours < bestAge) {
        bestAge = view.ageHours
        best = candidate
      }
    }
    return best
  }

  /** Render the global long-lived memory section from a cached snapshot. Total: it never throws. */
  const renderGlobalMemory = (state: GlobalMemoryState): string => {
    const lines = [
      '# 全局记忆（跨工作区，所有工作区共享）',
      '',
      `- 文件：${toPosix(state.path)}（${String(state.bytes)}/${String(globalMemoryBytes)} 字节，`
      + `${String(state.entries.length)} 条 / ${String(state.sections)} 个章节）`,
      '- 这里只放长期有效的用户画像：身份与背景、稳定偏好、明确要求、长期约定；项目现状、一次性发现、排错流水留在工作区记忆。',
      '- 新增单条用 memory_write(scope="global", section, kind)；整理（融合、删减、改写，防止膨胀）用 memory_revise；',
      '- 工作区里值得长期保留的条目用 memory_promote 提升；读取用 memory_read(scope="global")。',
      '',
      '当前内容',
      '',
    ]
    if (state.entries.length > 0) {
      const body = normalizeText(state.text)
      lines.push(body.length > globalIndexPromptBytes
        ? `${body.slice(0, globalIndexPromptBytes)}\n\n…（全局记忆过长已截断，完整内容用 memory_read(scope="global")）`
        : body)
    } else {
      lines.push('（暂无全局记忆。长期有效的用户信息、要求与习惯可用 memory_write(scope="global") 写入。）')
    }
    return lines.join('\n')
  }

  /** The approval service used for a per-call sandbox escalation, when composed. */
  const approvalService = (): EscalationApprover<never, never> | undefined => {
    const service = (ctx as unknown as { get?: (key: string) => unknown }).get?.('approval')
    return service === undefined ? undefined : service as EscalationApprover<never, never>
  }

  /** Whether a tool call carries a complete sandbox-escalation argument pair. */
  const hasEscalationArgs = (args: unknown): boolean => {
    if (typeof args !== 'object' || args === null) return false
    const record = args as { readonly sandbox_permissions?: unknown, readonly justification?: unknown }
    return typeof record.sandbox_permissions === 'string' && record.sandbox_permissions.length > 0
      && typeof record.justification === 'string' && record.justification.trim().length > 0
  }

  /**
   * The sandbox policy one global write runs under.
   *
   * Two independent gates decide a global write: the session's standing policy
   * decides whether `$DSH_HOME` is writable at all, and DSH's escalation seam
   * decides whether this single call may temporarily widen that policy. An
   * escalation argument pair that is not strictly wider than the standing mode is
   * left to the seam, which fails closed with a readable reason.
   */
  const writePolicyFor = async (
    toolName: string,
    args: { readonly sandbox_permissions?: string, readonly justification?: string },
    exec: ToolExecution,
  ): Promise<SandboxExecutionPolicy | undefined> => {
    validateEscalationArgs(args.sandbox_permissions, args.justification)
    const agent = exec.agent ?? agentNow()
    const standing = policyFor(sessionOf(agent))
    if (args.sandbox_permissions === undefined || args.justification === undefined) return standing
    if (standing === undefined || standing.mode === 'danger-full-access') return standing
    const approved = await approveEscalation(
      {
        requestedMode: args.sandbox_permissions,
        justification: args.justification,
        effectiveMode: standing.mode,
        subject: 'operation',
      },
      {
        approver: approvalService(),
        agent: agent as never,
        callId: exec.callId as never,
        toolName,
        ...exec.signal === undefined ? {} : { signal: exec.signal },
      },
    )
    return { ...standing, mode: approved }
  }

  /** Whether one policy can write an absolute path (`undefined` means unsandboxed). */
  const policyWritable = (policy: SandboxExecutionPolicy | undefined, target: string): boolean => {
    if (policy === undefined) return true
    if (policy.mode === 'danger-full-access') return true
    return writableRoots(policy).some((root) => {
      const rel = relative(root, target)
      return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel))
    })
  }

  /** Normalize a tool's optional `scope` argument. */
  const scopeArg = (value: unknown, fallback: 'workspace' | 'global' | 'both'): 'workspace' | 'global' | 'both' =>
    value === 'workspace' || value === 'global' || value === 'both' ? value : fallback

  /**
   * Refuse a global-scope call when this workspace blocks the global memory layer.
   *
   * Blocking is deliberately transitive: a workspace that set `inherit.memory:
   * false` does not want cross-workspace facts in its context, and letting a tool
   * call read them anyway would make the switch cosmetic.
   */
  const globalGate = async (workspace: string, write: boolean): Promise<JsonValue | undefined> => {
    const config = await configFor(workspace)
    if (config.layers.memory === 'disabled') return refuseLayer(workspace, 'memory')
    if (!config.layers.inherit.memory) {
      return {
        ok: false,
        error: `本工作区屏蔽了全局记忆（${WORKSPACE_CONFIG_REL} 的 ${CONFIG_SECTION}.inherit.memory: false）；如需跨工作区记忆请把它改为 true`,
        configFile: config.rel,
      } as unknown as JsonValue
    }
    if (write && config.layers.memory !== 'enabled') return refuseWrite(workspace)
    return undefined
  }

  const jsonOutput = {
    schema: { type: 'json' } as const,
    render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }

  ctx.tools.register(defineTool({
    name: 'memory_status',
    description:
      '报告本会话生效的记忆：工作区后端（存在 .workbuddy/memory 时优先兼容，否则 .dsh/memory）与全局作用域'
      + '（$DSH_HOME/memory/MEMORY.md，跨工作区共享的长期画像，单文件、非按天流水）。'
      + '返回两者的路径、大小、条目数、本工作区的继承开关，以及全局记忆的字节预算。',
    parameters: {},
    output: jsonOutput,
    async execute(): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const refused = await refuseLayer(workspace, 'memory')
      if (refused !== undefined) return refused
      const state = await stateFor(workspace)
      const shared = globalCache.memory ?? await loadGlobalMemory()
      const config = await configFor(workspace)
      const inherited = config.layers.inherit.memory
      return {
        ok: true,
        workspace: toPosix(workspace),
        mode: state.compat ? 'workbuddy' : 'dsh-default',
        activeBackend: state.name,
        detectedExisting: state.compat,
        memoryDir: toPosix(state.dir),
        indexPath: toPosix(state.index),
        indexExists: state.hasIndex,
        indexBytes: state.bytes,
        host: state.host,
        ledgerLayout: state.layout,
        ledgerDir: toPosix(join(state.dir, state.hostDir)),
        ledgers: state.ledgers.map((f) => f.rel),
        candidates: state.candidates,
        writable: isMemoryWritable(config.layers.memory),
        config: configSummary(workspace),
        global: {
          root: toPosix(globalRoot),
          memoryFile: toPosix(shared.path),
          exists: shared.exists,
          bytes: shared.bytes,
          budgetBytes: globalMemoryBytes,
          entries: shared.entries.length,
          sections: shared.sections,
          inherited,
          note: inherited
            ? '全局记忆是一份长期用户画像（单文件，非按天流水），会注入本会话；写它用 memory_write(scope="global")，整理用 memory_revise'
            : '本工作区屏蔽了全局记忆（inherit.memory: false）',
        },
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description:
      '读取记忆。scope=workspace（默认）：layer=index 返回索引 MEMORY.md，layer=ledger 返回某一天的流水文件（默认今天）。'
      + 'scope=global：返回跨工作区的全局长期记忆全文（单文件 MEMORY.md，按章节/条目组织，不再按天分册）。',
    parameters: {
      layer: { type: 'string' as const, enum: ['index', 'ledger'], description: 'index = 索引/全局记忆文件；ledger = 工作区的某一天日期流水（全局不支持）' },
      scope: { type: 'string' as const, enum: ['workspace', 'global'], description: 'workspace = 本工作区（默认）；global = 跨工作区共享的全局长期记忆' },
      date: { type: 'string' as const, description: 'layer=ledger 的日期 YYYY-MM-DD，默认今天' },
      limit: { type: 'number' as const, description: '读取流水时返回的最大尾部行数，默认 200' },
    },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const scope = scopeArg(args.scope, 'workspace') === 'global' ? 'global' : 'workspace'
      const refused = scope === 'global' ? await globalGate(workspace, false) : await refuseLayer(workspace, 'memory')
      if (refused !== undefined) return refused

      if (scope === 'global') {
        if (args.layer === 'ledger') {
          return {
            ok: false,
            scope,
            layer: 'ledger',
            error: '全局记忆已改为单文件长期画像（MEMORY.md），不再按天分册；用 layer="index"（或缺省）读取，整理用 memory_revise，新增用 memory_write。',
          } as unknown as JsonValue
        }
        const shared = globalCache.memory ?? await loadGlobalMemory()
        return {
          ok: true,
          scope,
          layer: 'index',
          path: toPosix(shared.path),
          exists: shared.exists,
          bytes: shared.bytes,
          budgetBytes: globalMemoryBytes,
          entries: shared.entries.length,
          sections: shared.document.sections.map((section) => ({ title: section.title, entries: section.entries.length })),
          text: shared.text,
        } as unknown as JsonValue
      }

      const state = await stateFor(workspace)
      const ledgers = state.ledgers.map((f) => f.rel)

      if (args.layer === 'ledger') {
        const date = args.date !== undefined && args.date.length > 0 ? args.date : dateStamp()
        const path = join(state.dir, ledgerForDate(state, date)?.rel ?? ledgerWritePath(state, date))
        const content = await readAt(path)
        if (content === undefined) {
          return { ok: true, scope, layer: 'ledger', date, path: toPosix(path), exists: false, text: '', ledgers } as unknown as JsonValue
        }
        const cap = args.limit !== undefined && args.limit > 0 ? Math.min(args.limit, 400) : 200
        const lines = normalizeText(content).split('\n')
        const truncated = lines.length > cap
        return {
          ok: true,
          scope,
          layer: 'ledger',
          date,
          path: toPosix(path),
          exists: true,
          truncated,
          totalLines: lines.length,
          text: truncated ? lines.slice(lines.length - cap).join('\n') : lines.join('\n'),
          ledgers,
        } as unknown as JsonValue
      }

      return {
        ok: true,
        scope,
        layer: 'index',
        path: toPosix(state.index),
        exists: state.hasIndex,
        bytes: state.bytes,
        text: state.indexText,
        ledgers,
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      '在索引与全部日期流水中做大小写不敏感的字面子串检索（含按计算机名分目录存放的流水）。'
      + 'scope 默认 both：同时搜工作区与全局记忆（全局被本工作区屏蔽时只搜工作区）。'
      + '写入新记忆前先检索，避免重复记录已有的事实。',
    parameters: {
      query: { type: 'string' as const, required: true, description: '要查找的字面文本' },
      scope: { type: 'string' as const, enum: ['workspace', 'global', 'both'], description: 'workspace = 只搜本工作区；global = 只搜全局；both = 两者（默认）' },
    },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const requested = scopeArg(args.scope, 'both')
      const config = await configFor(workspace)
      const includeWorkspace = requested !== 'global'
      const includeGlobal = requested !== 'workspace'
        && config.layers.memory !== 'disabled'
        && config.layers.inherit.memory
      if (!includeWorkspace && !includeGlobal) {
        const refused = await refuseLayer(workspace, 'memory')
        if (refused !== undefined) return refused
        return { ok: false, error: '本工作区屏蔽了全局记忆，且请求只搜索全局' } as unknown as JsonValue
      }
      if (includeWorkspace) {
        const refused = await refuseLayer(workspace, 'memory')
        if (refused !== undefined) return refused
      }
      const query = normalizeText(args.query)
      if (query.length === 0) return { ok: false, error: 'query 不能为空' } as unknown as JsonValue

      const needle = query.toLowerCase()
      const hits: { scope: 'workspace' | 'global', file: string, line: number, text: string }[] = []
      const search = async (dir: string, files: readonly string[], scope: 'workspace' | 'global'): Promise<void> => {
        for (const file of files) {
          const content = await readAt(join(dir, file))
          if (content === undefined) continue
          normalizeText(content).split('\n').forEach((line, i) => {
            if (line.toLowerCase().includes(needle)) hits.push({ scope, file, line: i + 1, text: line.trim().slice(0, 240) })
          })
        }
      }
      if (includeWorkspace) {
        const workspaceState = await stateFor(workspace)
        const ledgerFiles = workspaceState.ledgers.map((f) => f.rel)
        await search(workspaceState.dir, workspaceState.hasIndex ? [INDEX_FILE, ...ledgerFiles] : ledgerFiles, 'workspace')
      }
      if (includeGlobal) {
        const shared = globalCache.memory ?? await loadGlobalMemory()
        if (shared.exists) await search(shared.dir, [GLOBAL_MEMORY_FILE], 'global')
      }
      return {
        ok: true,
        query,
        searched: { workspace: includeWorkspace, global: includeGlobal },
        totalHits: hits.length,
        hits: hits.slice(0, 120),
      } as unknown as JsonValue
    },
  }))

  /** Entry kinds that may enter the GLOBAL ledger; project-local facts stay in the workspace. */
  const GLOBAL_ENTRY_KINDS: readonly string[] = ['preference', 'constraint', 'convention', 'decision']

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description:
      '经准入审查后写入一条跨会话仍有价值的记忆。'
      + 'scope=workspace（默认）向本工作区的日期流水追加一条：决策及其理由、稳定偏好、约定、可复现的坑、环境限制、硬约束；'
      + '绝不记录密钥、一次性改动或排错流水账（软提醒需 force=true）。'
      + 'scope=global 写入跨工作区共享的长期画像（单文件 MEMORY.md 的一个章节），只接受 preference/constraint/convention/decision 四类，'
      + '适合身份背景、稳定偏好、明确要求、长期约定；项目现状与一次性发现请留在工作区记忆。'
      + '全局画像有字节预算：接近上限时先用 memory_revise 融合、删减、改写，不要靠追加堆大。'
      + '在「工作区内修改」模式下写 $DSH_HOME 需要 sandbox_permissions="danger-full-access" 与一句 justification，用户批准后仅本次生效。',
    parameters: {
      content: { type: 'string' as const, required: true, description: '持久的事实、决策、约定或坑本身' },
      kind: { type: 'string' as const, enum: [...ENTRY_KINDS], description: '条目分类，默认 fact（全局只接受 preference/constraint/convention/decision）' },
      scope: { type: 'string' as const, enum: ['workspace', 'global'], description: 'workspace = 本工作区（默认）；global = 跨工作区共享的长期画像' },
      section: { type: 'string' as const, description: 'scope=global 时的目标章节（如「关于用户」「偏好与习惯」「要求与规则」），默认第一章节' },
      title: { type: 'string' as const, description: '内容较长时的单行标题（可选，仅工作区）' },
      tags: { type: 'array' as const, items: { type: 'string' as const }, description: '标签（可选，仅工作区）' },
      force: { type: 'boolean' as const, description: '带软性提醒仍写入；无法绕过硬性拒绝' },
      date: { type: 'string' as const, description: '覆盖目标日期 YYYY-MM-DD，默认今天（仅工作区）' },
      sandbox_permissions: { type: 'string' as const, enum: ['workspace-write', 'danger-full-access'], description: 'scope=global 且当前策略写不到 $DSH_HOME 时使用：请求一次升级，配合 justification 弹出审批' },
      justification: { type: 'string' as const, description: '与 sandbox_permissions 成对出现：一句给用户看的理由（用用户当前语言）' },
    },
    output: jsonOutput,
    async execute(args, exec): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const scope = scopeArg(args.scope, 'workspace') === 'global' ? 'global' : 'workspace'
      const refused = scope === 'global' ? await globalGate(workspace, true) : await refuseWrite(workspace)
      if (refused !== undefined) return refused
      const verdict = evaluateEntry(args.content, args.kind)

      if (scope === 'global') {
        const check = checkGlobalEntry(args.content, args.kind, evaluateEntry)
        if (!check.allowed) {
          return { ok: false, written: false, scope, kind: check.kind, reasons: check.reasons, warnings: check.warnings } as unknown as JsonValue
        }
        if (check.warnings.length > 0 && args.force !== true) {
          return {
            ok: false,
            written: false,
            scope,
            kind: check.kind,
            warnings: check.warnings,
            needsForce: true,
            hint: '全局画像只放长期有效的结论；若确属此类，用 force=true 重试，否则改写为结论后再写。',
          } as unknown as JsonValue
        }
        const shared = globalCache.memory ?? await loadGlobalMemory()
        const section = sectionTitle(args.section ?? '')
        const result = upsertGlobalEntry(shared.text, section, { text: check.text, kind: check.kind })
        const nextBytes = documentBytes(result.text)
        if (nextBytes > globalMemoryBytes) {
          return {
            ok: false,
            written: false,
            scope,
            section,
            path: toPosix(shared.path),
            bytes: shared.bytes,
            wouldBeBytes: nextBytes,
            budgetBytes: globalMemoryBytes,
            error: `写入后会超出全局记忆预算（${String(nextBytes)}/${String(globalMemoryBytes)} 字节）；请先用 memory_revise 融合、删减、改写已有内容，再新增。`,
          } as unknown as JsonValue
        }
        if (!result.changed) {
          return {
            ok: true,
            changed: false,
            written: false,
            scope,
            path: toPosix(shared.path),
            section,
            entries: shared.entries.length,
            note: '相同条目已存在，未重复写入',
          } as unknown as JsonValue
        }
        const policy = await writePolicyFor('memory_write', args, exec)
        if (!policyWritable(policy, shared.path)) {
          return {
            ok: false,
            written: false,
            scope,
            path: toPosix(shared.path),
            error: '当前权限模式写不到全局记忆文件（$DSH_HOME 在工作区之外）',
            hint: '带 sandbox_permissions: "danger-full-access" 与 justification 重试，用户批准后仅本次写入生效；或改用 scope="workspace"。',
          } as unknown as JsonValue
        }
        try {
          const written = await writeAt(shared.path, `${result.text}\n`, currentSession(), policy)
          refreshGlobal()
          refresh(workspace)
          return {
            ok: true,
            written: true,
            scope,
            path: written,
            section,
            createdSection: result.createdSection,
            entries: result.count,
            bytes: nextBytes,
            budgetBytes: globalMemoryBytes,
            kind: check.kind,
            visibleTo: '所有工作区（下一个请求即生效）',
          } as unknown as JsonValue
        } catch (error) {
          return {
            ok: false,
            written: false,
            scope,
            path: toPosix(shared.path),
            error: `写入被拒绝：${error instanceof Error ? error.message : String(error)}`,
            hint: '全局记忆在 $DSH_HOME 下；可带 sandbox_permissions 与 justification 申请一次升级，或改用 scope="workspace"。',
          } as unknown as JsonValue
        }
      }

      const state = await stateFor(workspace)
      if (!verdict.allowed) {
        return { ok: false, written: false, scope, kind: verdict.kind, reasons: verdict.reasons, warnings: verdict.warnings } as unknown as JsonValue
      }
      if (verdict.warnings.length > 0 && args.force !== true) {
        return {
          ok: false,
          written: false,
          scope,
          kind: verdict.kind,
          warnings: verdict.warnings,
          needsForce: true,
          hint: '若确属跨会话仍有价值的结论（而非流水账），用 force=true 重试；否则改写为结论后再写。',
        } as unknown as JsonValue
      }

      const date = args.date !== undefined && args.date.length > 0 ? args.date : dateStamp()
      const path = join(state.dir, ledgerWritePath(state, date))
      const existing = await readAt(path)
      const created = existing === undefined
      const block = renderEntry({
        content: verdict.body,
        kind: verdict.kind,
        scope,
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.tags !== undefined ? { tags: args.tags } : {},
      })
      const next = created || normalizeText(existing).length === 0
        ? `# ${date}\n\n${block}\n`
        : `${normalizeText(existing).replace(/\s+$/, '')}\n\n${block}\n`

      let written: string
      try {
        written = await writeAt(path, next, currentSession())
      } catch (error) {
        return {
          ok: false,
          written: false,
          scope,
          path: toPosix(path),
          error: `写入被拒绝：${error instanceof Error ? error.message : String(error)}`,
          hint: '当前策略不允许写该路径',
        } as unknown as JsonValue
      }
      refresh(workspace)
      return {
        ok: true,
        written: true,
        scope,
        backend: state.name ?? 'dsh-default',
        path: written,
        date,
        ledgerLayout: state.layout,
        created,
        kind: verdict.kind,
        warnings: verdict.warnings,
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_promote',
    description:
      '把一条条目提升进每轮注入的长期层。scope=workspace（默认）提升进本工作区索引 MEMORY.md 的指定章节；'
      + 'scope=global 提升进全局长期画像（单文件 MEMORY.md 的指定章节，只接受 preference/constraint/convention/decision 四类）。'
      + '这一层只留给硬约束、稳定偏好、长期约定与文档指针，不放细节、现状或流水账；重复条目幂等。'
      + '在「工作区内修改」模式下写全局需要 sandbox_permissions="danger-full-access" 与一句 justification。',
    parameters: {
      entry: { type: 'string' as const, required: true, description: '要加入长期层的单行条目' },
      section: { type: 'string' as const, description: '目标章节标题；scope=global 默认第一章节' },
      kind: { type: 'string' as const, enum: [...ENTRY_KINDS], description: '用于准入审查的分类' },
      scope: { type: 'string' as const, enum: ['workspace', 'global'], description: 'workspace = 本工作区索引（默认）；global = 跨工作区全局画像' },
      sandbox_permissions: { type: 'string' as const, enum: ['workspace-write', 'danger-full-access'], description: 'scope=global 且当前策略写不到 $DSH_HOME 时使用：请求一次升级' },
      justification: { type: 'string' as const, description: '与 sandbox_permissions 成对出现：一句给用户看的理由（用用户当前语言）' },
    },
    output: jsonOutput,
    async execute(args, exec): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const scope = scopeArg(args.scope, 'workspace') === 'global' ? 'global' : 'workspace'
      const refused = scope === 'global' ? await globalGate(workspace, true) : await refuseWrite(workspace)
      if (refused !== undefined) return refused
      const entry = normalizeText(args.entry)
      if (entry.length === 0) return { ok: false, changed: false, error: '提升内容不能为空' } as unknown as JsonValue

      if (scope === 'global') {
        const check = checkGlobalEntry(entry, args.kind, evaluateEntry)
        if (!check.allowed) return { ok: false, changed: false, scope, reasons: check.reasons, warnings: check.warnings } as unknown as JsonValue
        const shared = globalCache.memory ?? await loadGlobalMemory()
        const section = sectionTitle(args.section ?? '')
        const result = upsertGlobalEntry(shared.text, section, { text: check.text, kind: check.kind })
        const nextBytes = documentBytes(result.text)
        if (nextBytes > globalMemoryBytes) {
          return {
            ok: false,
            changed: false,
            scope,
            section,
            path: toPosix(shared.path),
            bytes: shared.bytes,
            wouldBeBytes: nextBytes,
            budgetBytes: globalMemoryBytes,
            error: `提升后会超出全局记忆预算（${String(nextBytes)}/${String(globalMemoryBytes)} 字节）；请先用 memory_revise 精简已有内容。`,
          } as unknown as JsonValue
        }
        if (!result.changed) {
          return { ok: true, changed: false, scope, path: toPosix(shared.path), section, entries: shared.entries.length } as unknown as JsonValue
        }
        const policy = await writePolicyFor('memory_promote', args, exec)
        if (!policyWritable(policy, shared.path)) {
          return {
            ok: false,
            changed: false,
            scope,
            path: toPosix(shared.path),
            error: '当前权限模式写不到全局记忆文件（$DSH_HOME 在工作区之外）',
            hint: '带 sandbox_permissions: "danger-full-access" 与 justification 重试，用户批准后仅本次写入生效。',
          } as unknown as JsonValue
        }
        try {
          const written = await writeAt(shared.path, `${result.text}\n`, currentSession(), policy)
          refreshGlobal()
          refresh(workspace)
          return {
            ok: true,
            changed: true,
            scope,
            path: written,
            section,
            createdSection: result.createdSection,
            entries: result.count,
            bytes: nextBytes,
            visibleTo: '所有工作区（下一个请求即生效）',
          } as unknown as JsonValue
        } catch (error) {
          return {
            ok: false,
            changed: false,
            scope,
            path: toPosix(shared.path),
            error: `写入被拒绝：${error instanceof Error ? error.message : String(error)}`,
            hint: '可带 sandbox_permissions 与 justification 申请一次升级。',
          } as unknown as JsonValue
        }
      }

      const state = await stateFor(workspace)
      const verdict = evaluateEntry(entry, args.kind)
      if (!verdict.allowed) return { ok: false, changed: false, scope, reasons: verdict.reasons } as unknown as JsonValue

      const section = normalizeText(args.section) || '未分类'
      const base = state.hasIndex && state.indexText.length > 0 ? state.indexText : `# ${section}\n\n`
      const result = upsertIndexEntry(base, section, entry)
      if (!result.changed) {
        return { ok: true, changed: false, scope, path: toPosix(state.index), section } as unknown as JsonValue
      }
      const written = await writeAt(state.index, result.text, currentSession())
      refresh(workspace)
      return {
        ok: true,
        changed: true,
        scope,
        backend: state.name ?? 'dsh-default',
        path: written,
        section,
        createdSection: result.createdSection,
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_revise',
    description:
      '重写全局长期画像（scope 仅 global）。先 memory_read(scope="global") 读取现文，把新事实融合进已有条目、删除过时或重复内容、改写措辞，'
      + '然后提交完整的新文本 —— 这是防止记忆膨胀的常规做法：不必每次追加，也可以合并、精简、重写。'
      + '提交内容会被重新规范化、逐条准入审查（全局只接受 preference/constraint/convention/decision）并检查字节预算；'
      + '工作区记忆是日期流水，不支持整篇重写（用 memory_write 追加，或用 memory_promote 提升）。'
      + '在「工作区内修改」模式下写全局需要 sandbox_permissions="danger-full-access" 与一句 justification。',
    parameters: {
      content: { type: 'string' as const, required: true, description: '完整的全局画像文档：`# 全局记忆` + `## 章节` + `- [kind] 条目`' },
      force: { type: 'boolean' as const, description: '带软性提醒仍写入；无法绕过硬性拒绝' },
      sandbox_permissions: { type: 'string' as const, enum: ['workspace-write', 'danger-full-access'], description: '当前策略写不到 $DSH_HOME 时使用：请求一次升级' },
      justification: { type: 'string' as const, description: '与 sandbox_permissions 成对出现：一句给用户看的理由（用用户当前语言）' },
    },
    output: jsonOutput,
    async execute(args, exec): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const refused = await globalGate(workspace, true)
      if (refused !== undefined) return refused
      const submitted = normalizeText(args.content)
      if (submitted.length === 0) return { ok: false, written: false, error: '提交内容不能为空' } as unknown as JsonValue

      const document = parseGlobalMemory(submitted)
      const entries = flattenEntries(document)
      if (entries.length === 0) {
        return {
          ok: false,
          written: false,
          error: '提交内容里没有任何条目；期望 `## 章节` 下的 `- [preference] …` 形式行。',
        } as unknown as JsonValue
      }
      const reasons: string[] = []
      const warnings: string[] = []
      for (const entry of entries) {
        const check = checkGlobalEntry(entry.text, entry.kind, evaluateEntry)
        reasons.push(...check.reasons.map((reason) => `「${entry.section}」${reason}`))
        warnings.push(...check.warnings)
      }
      if (reasons.length > 0) return { ok: false, written: false, scope: 'global', reasons } as unknown as JsonValue
      if (warnings.length > 0 && args.force !== true) {
        return { ok: false, written: false, scope: 'global', warnings, needsForce: true, hint: '若确属长期有效的画像内容，用 force=true 重试。' } as unknown as JsonValue
      }
      const canonical = reviseGlobalMemory(submitted, GLOBAL_MEMORY_TITLE)
      const bytes = documentBytes(canonical)
      if (bytes > globalMemoryBytes) {
        return {
          ok: false,
          written: false,
          scope: 'global',
          bytes,
          budgetBytes: globalMemoryBytes,
          error: `提交内容超出全局记忆预算（${String(bytes)}/${String(globalMemoryBytes)} 字节）；请先精简条目再提交。`,
        } as unknown as JsonValue
      }
      const shared = globalCache.memory ?? await loadGlobalMemory()
      if (normalizeText(canonical) === normalizeText(shared.text)) {
        return { ok: true, changed: false, written: false, scope: 'global', path: toPosix(shared.path), bytes, entries: entries.length } as unknown as JsonValue
      }
      const policy = await writePolicyFor('memory_revise', args, exec)
      if (!policyWritable(policy, shared.path)) {
        return {
          ok: false,
          written: false,
          scope: 'global',
          path: toPosix(shared.path),
          error: '当前权限模式写不到全局记忆文件（$DSH_HOME 在工作区之外）',
          hint: '带 sandbox_permissions: "danger-full-access" 与 justification 重试，用户批准后仅本次写入生效。',
        } as unknown as JsonValue
      }
      try {
        const written = await writeAt(shared.path, `${canonical}\n`, currentSession(), policy)
        refreshGlobal()
        refresh(workspace)
        return {
          ok: true,
          changed: true,
          written: true,
          scope: 'global',
          path: written,
          bytes,
          budgetBytes: globalMemoryBytes,
          entries: entries.length,
          sections: document.sections.filter((section) => section.entries.length > 0).length,
          visibleTo: '所有工作区（下一个请求即生效）',
        } as unknown as JsonValue
      } catch (error) {
        return {
          ok: false,
          written: false,
          scope: 'global',
          path: toPosix(shared.path),
          error: `写入被拒绝：${error instanceof Error ? error.message : String(error)}`,
          hint: '可带 sandbox_permissions 与 justification 申请一次升级。',
        } as unknown as JsonValue
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_help',
    description:
      '说明本工作区当前生效的记忆规则：生效后端、它的原生写入准则、日期流水的存放布局，'
      + '以及准入策略（硬性拒绝与软性提醒）。',
    parameters: {},
    output: jsonOutput,
    async execute(): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const refused = await refuseLayer(workspace, 'memory')
      if (refused !== undefined) return refused
      const state = await stateFor(workspace)
      return {
        ok: true,
        backend: state.name,
        mode: state.compat ? 'workbuddy' : 'dsh-default',
        memoryDir: toPosix(state.dir),
        global: {
          root: toPosix(globalRoot),
          memoryFile: toPosix(globalCache.memory?.path ?? join(globalLayerDir(globalRoot, 'memory'), GLOBAL_MEMORY_FILE)),
          budgetBytes: globalMemoryBytes,
          inherited: (await configFor(workspace)).layers.inherit.memory,
          writeKinds: GLOBAL_ENTRY_KINDS,
          note: '全局记忆是跨工作区共享的长期用户画像：单文件 MEMORY.md，按章节组织，不按天分册；每轮注入，'
            + '只记身份背景、稳定偏好、明确要求、长期约定（preference/constraint/convention/decision 四类）。'
            + '新增单条用 memory_write(scope="global", section=…)，融合/删减/改写用 memory_revise（防膨胀），工作区条目提升用 memory_promote。'
            + '预算默认与 globalMemoryBytes 一致，超出时先 memory_revise 精简。'
            + '在「工作区内修改」模式下需要 sandbox_permissions="danger-full-access" + justification 才能写 $DSH_HOME。',
        },
        host: state.host,
        ledgerLayout: state.layout,
        ledgerDir: toPosix(join(state.dir, state.hostDir)),
        ledgerNote: state.layout === 'host'
          ? `日期流水按计算机名分目录存放；本机（${state.host}）的流水写入 ${toPosix(join(state.dir, state.hostDir))}，检索覆盖全部机器的目录。`
          : '日期流水平铺在记忆目录下（YYYY-MM-DD.md）；一旦目录里出现装着日期文件的计算机名子目录，读写会自动改为按本机目录进行。',
        rules: state.compat
          ? [
              '本工作区已存在 WorkBuddy 记忆体系，读写遵循其原生准则：',
              '- MEMORY.md 只是索引与偏好：设计细节、模块现状、实机踩坑、环境限制一律查文档，不在索引里复述；冲突以文档为准。',
              '- 小事、小修改、一次性操作与排错过程不写记忆；只记跨会话仍有价值的内容，且优先落文档（索引只留指针）。',
              '- 日期文件是追加式流水；不重写、不重排已有内容。',
              '- 日期文件可能按计算机名分目录存放（`.workbuddy/memory/<计算机名>/YYYY-MM-DD.md`），也可能平铺在 `memory/` 下；读写与检索按目录实际形状进行。',
              '- 宁缺毋滥。',
            ]
          : [
              '本工作区使用 DSH 默认记忆规则，当前仅有工作区记忆，暂无全局长期记忆：',
              '- MEMORY.md 只放禁止遗忘的内容：硬约束、稳定偏好、长期约定、文档指针。',
              '- 细节、现状与排错过程写进文档或日期流水，不在索引里复述。',
              '- 小事、小修改、一次性操作不写记忆；只记跨会话仍有价值的内容。',
              '- 宁缺毋滥。',
            ],
        hardReject: HARD_RULES.map((r) => r.why),
        softWarn: ['疑似一次性执行流水账', '单条记忆偏长'],
        note: '硬性拒绝无法用 force 绕过；软提醒需 force=true 才写入。',
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rule_status',
    description:
      '报告工作区规则体系（WorkBuddy 的 .workbuddy/rules/）：目录是否存在、每册的分类（alwaysApply 常驻册 / paths 条件册 / 按需规则）、'
      + '触发 glob，以及本会话已触发的条件册。常驻册每轮自动注入；条件册在被读写匹配文件后自动注入。',
    parameters: {},
    output: jsonOutput,
    async execute(): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const refused = await refuseLayer(workspace, 'rules')
      if (refused !== undefined) return refused
      const state = await rulesFor(workspace)
      const active = triggered.get(workspace) ?? EMPTY_RULES
      const shared = globalCache.rules ?? await loadGlobalRules()
      const sharedActive = globalTriggered.get(workspace) ?? EMPTY_RULES
      const config = await configFor(workspace)
      const describeBook = (rule: RuleDefinition, hit: ReadonlySet<string>) => ({
        file: rule.file,
        title: rule.title,
        kind: rule.alwaysApply ? 'always' : rule.paths.length > 0 ? 'conditional' : 'on-demand',
        paths: rule.paths,
        bytes: rule.bytes,
        triggered: hit.has(rule.rel),
        issue: rule.issue,
      })
      return {
        ok: true,
        workspace: toPosix(workspace),
        rulesDir: state.dirRel,
        absoluteDir: state.dir,
        exists: state.exists,
        budgets: { rulesPromptBytes, ruleFileBytes },
        config: configSummary(workspace),
        total: state.rules.length,
        books: state.rules.map((rule) => describeBook(rule, active)),
        global: {
          dir: toPosix(globalLayerDir(globalRoot, 'rules')),
          inherited: config.layers.inherit.rules,
          budgets: { rulesPromptBytes: globalRulesPromptBytes, ruleFileBytes },
          total: shared.length,
          books: shared.map((rule) => describeBook(rule, sharedActive)),
          note: '全局规则对每个工作区都生效；条件册只按本工作区的文件触碰触发。',
        },
        note: '条件册只按「读/写/编辑匹配文件」触发；用 shell 改文件不会触发（DSH 的触碰追踪只认这三个工具的 file_path 参数）。',
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rule_read',
    description:
      '读取一册规则的完整正文（绕过 16 KB 注入上限）。用于按需规则、未被预算注入的条件册，'
      + '以及新建文件前的兜底——新建文件不一定触发条件册注入。scope=global 读跨工作区的全局规则。',
    parameters: {
      file: { type: 'string' as const, required: true, description: '册文件名或工作区相对路径，例如 01-协作红线.md' },
      scope: { type: 'string' as const, enum: ['workspace', 'global'], description: 'workspace = 本工作区（默认）；global = 跨工作区的全局规则' },
    },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const scope = scopeArg(args.scope, 'workspace') === 'global' ? 'global' : 'workspace'
      let dirRel: string
      let rules: readonly RuleDefinition[]
      if (scope === 'global') {
        const config = await configFor(workspace)
        if (!config.layers.inherit.rules) {
          return {
            ok: false,
            error: `本工作区屏蔽了全局规则（${WORKSPACE_CONFIG_REL} 的 ${CONFIG_SECTION}.inherit.rules: false）`,
            configFile: config.rel,
          } as unknown as JsonValue
        }
        dirRel = toPosix(globalLayerDir(globalRoot, 'rules'))
        rules = globalCache.rules ?? await loadGlobalRules()
      } else {
        const refused = await refuseLayer(workspace, 'rules')
        if (refused !== undefined) return refused
        const state = await rulesFor(workspace)
        dirRel = state.dirRel
        rules = state.rules
      }
      const query = normalizeText(args.file).replace(/^\.\//, '')
      const byRel = rules.find((rule) => rule.rel === query || rule.rel === `${dirRel}/${query}`)
      const byName = rules.find((rule) => rule.file === query)
      const rule = byRel ?? byName
      if (rule === undefined) {
        return {
          ok: false,
          scope,
          error: `未找到规则册：${query}`,
          available: rules.map((r) => r.file),
        } as unknown as JsonValue
      }
      return {
        ok: true,
        scope,
        file: rule.file,
        path: rule.rel,
        title: rule.title,
        kind: rule.alwaysApply ? 'always' : rule.paths.length > 0 ? 'conditional' : 'on-demand',
        paths: rule.paths,
        bytes: rule.bytes,
        truncatedInPrompt: rule.bytes > ruleFileBytes,
        text: rule.body,
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'self_status',
    description:
      '报告「自我层」全景：persona（人格）、mood（情绪）、rules（规则）、memory（记忆）四层在两个作用域（工作区 / 全局）下的目录、文件数、字节、'
      + '注入预算、继承开关、情绪衰减结果与阻塞原因。排查「为什么某层没生效」先看这里。',
    parameters: {},
    output: jsonOutput,
    async execute(): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const config = await configFor(workspace)
      const localPersona = await loadPersona(workspace)
      const sharedPersona = globalCache.persona ?? await loadGlobalPersona()
      const localMood = moodCache.get(workspace) ?? await loadMood(workspace)
      const sharedMood = globalCache.mood === undefined ? await loadGlobalMood() : globalCache.mood
      const localRules = await rulesFor(workspace)
      const sharedRules = globalCache.rules ?? await loadGlobalRules()
      const localMemory = await stateFor(workspace)
      const sharedMemory = globalCache.memory ?? await loadGlobalMemory()
      const now = new Date()
      const decay = { halfLifeHours: moodHalfLifeHours, maxAgeHours: moodMaxAgeHours }
      const describeMood = (state: MoodState | null): JsonValue => {
        if (state === null) return { present: false } as unknown as JsonValue
        const view = moodView(state, now, decay)
        return {
          present: true,
          label: state.label,
          updated: state.updated ?? null,
          ageHours: Number.isFinite(view.ageHours) ? Math.round(view.ageHours * 10) / 10 : null,
          weight: Math.round(view.weight * 100) / 100,
          fresh: view.fresh,
          text: view.text,
        } as unknown as JsonValue
      }
      const effective = effectiveMood(workspace, now)
      return {
        ok: true,
        workspace: toPosix(workspace),
        globalRoot: toPosix(globalRoot),
        config: configSummary(workspace),
        layers: {
          persona: {
            enabled: config.layers.persona,
            inherited: config.layers.inherit.persona,
            budgetBytes: personaPromptBytes,
            fileBytes: personaFileBytes,
            workspace: {
              dir: toPosix(workspaceLayerDir(workspace, 'persona')),
              fragments: localPersona.fragments.map((f) => ({ name: f.name, title: f.title, bytes: f.bytes, order: f.order })),
              issues: localPersona.issues,
            },
            global: {
              dir: toPosix(globalLayerDir(globalRoot, 'persona')),
              fragments: sharedPersona.map((f) => ({ name: f.name, title: f.title, bytes: f.bytes, order: f.order })),
              shadowedByWorkspace: mergePersona(sharedPersona, localPersona.fragments).shadowed.map((f) => f.name),
            },
          },
          mood: {
            enabled: config.layers.mood,
            inherited: config.layers.inherit.mood,
            budgetBytes: moodPromptBytes,
            halfLifeHours: moodHalfLifeHours,
            maxAgeHours: moodMaxAgeHours,
            workspace: { dir: toPosix(workspaceLayerDir(workspace, 'mood')), ...describeMood(localMood) as object },
            global: { dir: toPosix(globalLayerDir(globalRoot, 'mood')), ...describeMood(sharedMood) as object },
            effective: effective === undefined ? null : { label: effective.label, updated: effective.updated ?? null },
          },
          rules: {
            enabled: config.layers.rules,
            inherited: config.layers.inherit.rules,
            budgets: { workspace: rulesPromptBytes, global: globalRulesPromptBytes, file: ruleFileBytes },
            workspace: { dir: localRules.dirRel, exists: localRules.exists, total: localRules.rules.length },
            global: { dir: toPosix(globalLayerDir(globalRoot, 'rules')), total: sharedRules.length },
          },
          memory: {
            mode: config.layers.memory,
            inherited: config.layers.inherit.memory,
            budgets: { workspace: indexPromptBytes, global: globalIndexPromptBytes },
            workspace: {
              backend: localMemory.name,
              dir: toPosix(localMemory.dir),
              indexBytes: localMemory.bytes,
              ledgers: localMemory.ledgers.length,
            },
            global: {
              file: toPosix(sharedMemory.path),
              bytes: sharedMemory.bytes,
              budgetBytes: globalMemoryBytes,
              entries: sharedMemory.entries.length,
              sections: sharedMemory.sections,
              configured: sharedMemory.exists && sharedMemory.entries.length > 0,
            },
          },
          skills: { enabled: config.layers.skills, note: '技能只有工作区来源（.workbuddy/skills）；全局技能由 DSH 原生的 $DSH_HOME/skills 提供，本插件不接管。' },
        },
        notes: [
          '全局层位于 $DSH_HOME/{persona,mood,memory,rules}；可用行配置 globalRoot 整体搬家。',
          '工作区同名 persona 片段会整体遮蔽全局那一份；情绪取「最新一份」而不混合。',
          '每个工作区可用 .dsh/workspace.yml 的 inherit.{persona,mood,memory,rules} 屏蔽对应全局层。',
        ],
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'persona_read',
    description:
      '读取人格片段。省略 name 时返回两个作用域的片段清单；给出 name 时返回正文（工作区同名遮蔽全局，返回的就是生效的那一份）。',
    parameters: {
      name: { type: 'string' as const, description: '片段名（不含 .md）；省略则只列清单' },
      scope: { type: 'string' as const, enum: ['workspace', 'global', 'both'], description: 'workspace / global / both（默认 both）' },
    },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const scope = scopeArg(args.scope, 'both')
      const config = await configFor(workspace)
      const local = config.layers.persona ? await loadPersona(workspace) : { fragments: [], issues: [] }
      const shared = scope !== 'workspace' && config.layers.inherit.persona
        ? globalCache.persona ?? await loadGlobalPersona()
        : []
      const merged = mergePersona(scope === 'global' ? [] : local.fragments, scope === 'global' ? shared : [])
      const list = scope === 'global'
        ? shared
        : scope === 'workspace'
          ? local.fragments
          : mergePersona(shared, local.fragments).fragments
      const name = args.name === undefined || args.name.trim().length === 0 ? undefined : args.name.trim().replace(/\.md$/i, '')
      if (name === undefined) {
        return {
          ok: true,
          scope,
          total: list.length,
          fragments: list.map((f) => ({ scope: f.scope, name: f.name, title: f.title, order: f.order, bytes: f.bytes })),
          shadowed: scope === 'both' ? mergePersona(shared, local.fragments).shadowed.map((f) => f.name) : [],
          issues: local.issues,
          mergedEffective: merged.fragments.length,
        } as unknown as JsonValue
      }
      const found = list.find((f) => f.name.toLowerCase() === name.toLowerCase())
      if (found === undefined) {
        return { ok: false, scope, error: `未找到人格片段：${name}`, available: list.map((f) => f.name) } as unknown as JsonValue
      }
      return { ok: true, scope, name: found.name, title: found.title, bytes: found.bytes, body: found.body } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'persona_write',
    description:
      '写入人格片段（<scope>/.dsh 或 $DSH_HOME 下的 persona/<name>.md）。人格写身份、语气、价值观与禁忌；'
      + '项目事实属于记忆，不要写进人格。scope=global 的写入对所有工作区生效；'
      + '在「工作区内修改」模式下写全局需要 sandbox_permissions="danger-full-access" 与一句 justification。',
    parameters: {
      name: { type: 'string' as const, required: true, description: '片段名（不含 .md，如 02-voice）' },
      content: { type: 'string' as const, required: true, description: '片段正文；可自带 frontmatter（title/order）' },
      scope: { type: 'string' as const, enum: ['workspace', 'global'], description: 'workspace（默认）或 global' },
      mode: { type: 'string' as const, enum: ['replace', 'append'], description: 'replace（默认）整体替换；append 追加为新的段落' },
      sandbox_permissions: { type: 'string' as const, enum: ['workspace-write', 'danger-full-access'], description: 'scope=global 且当前策略写不到 $DSH_HOME 时使用：请求一次升级' },
      justification: { type: 'string' as const, description: '与 sandbox_permissions 成对出现：一句给用户看的理由（用用户当前语言）' },
    },
    output: jsonOutput,
    async execute(args, exec): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const scope = scopeArg(args.scope, 'workspace') === 'global' ? 'global' : 'workspace'
      const refused = scope === 'global'
        ? await (async () => {
            const config = await configFor(workspace)
            if (!config.layers.persona) return refuseLayer(workspace, 'persona')
            if (!config.layers.inherit.persona) {
              return {
                ok: false,
                error: `本工作区屏蔽了全局人格（${WORKSPACE_CONFIG_REL} 的 ${CONFIG_SECTION}.inherit.persona: false）`,
                configFile: config.rel,
              } as unknown as JsonValue
            }
            return undefined
          })()
        : await refuseLayer(workspace, 'persona')
      if (refused !== undefined) return refused

      const raw = args.name.trim().replace(/^.*[\\/]/, '').replace(/\.md$/i, '')
      if (raw.length === 0 || raw.startsWith('.')) {
        return { ok: false, written: false, error: '片段名不能为空、不能以点开头' } as unknown as JsonValue
      }
      const body = normalizeText(args.content)
      if (body.length === 0) return { ok: false, written: false, error: '内容不能为空' } as unknown as JsonValue
      if (Buffer.byteLength(body, 'utf8') > personaFileBytes) {
        return {
          ok: false,
          written: false,
          error: `片段超过 ${String(personaFileBytes)} 字节上限，请拆分到多个片段（每个片段有自己的标题与预算）`,
          bytes: Buffer.byteLength(body, 'utf8'),
        } as unknown as JsonValue
      }
      const verdict = evaluateEntry(body, 'fact')
      if (!verdict.allowed) return { ok: false, written: false, reasons: verdict.reasons } as unknown as JsonValue

      const dir = scope === 'global' ? globalLayerDir(globalRoot, 'persona') : workspaceLayerDir(workspace, 'persona')
      const path = join(dir, `${raw}.md`)
      const existing = args.mode === 'append' ? await readAt(path) : undefined
      const next = existing === undefined || normalizeText(existing).length === 0
        ? `${body}\n`
        : `${normalizeText(existing).replace(/\s+$/, '')}\n\n${body}\n`
      const policy = scope === 'global' ? await writePolicyFor('persona_write', args, exec) : undefined
      if (scope === 'global' && !policyWritable(policy, path)) {
        return {
          ok: false,
          written: false,
          scope,
          error: '当前权限模式写不到全局人格文件（$DSH_HOME 在工作区之外）',
          hint: '带 sandbox_permissions: "danger-full-access" 与 justification 重试，用户批准后仅本次写入生效。',
        } as unknown as JsonValue
      }
      let written: string
      try {
        written = await writeAt(path, next, currentSession(), policy)
      } catch (error) {
        return {
          ok: false,
          written: false,
          scope,
          error: `写入被拒绝：${error instanceof Error ? error.message : String(error)}`,
          hint: scope === 'global'
            ? '全局人格在 $DSH_HOME 下；可带 sandbox_permissions 与 justification 申请一次升级，或改用 scope="workspace"。'
            : '当前策略不允许写该路径',
        } as unknown as JsonValue
      }
      if (scope === 'global') await loadGlobalPersona()
      else await loadPersona(workspace)
      return { ok: true, written: true, scope, name: raw, path: written, mode: args.mode ?? 'replace', bytes: Buffer.byteLength(next, 'utf8') } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mood_get',
    description:
      '读取当前情绪状态（工作区与全局各一份，含衰减后的强度、年龄与是否已平复）。情绪是一个有时效的小状态，不写历史流水。',
    parameters: { scope: { type: 'string' as const, enum: ['workspace', 'global', 'both'], description: '默认 both' } },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const scope = scopeArg(args.scope, 'both')
      const config = await configFor(workspace)
      const now = new Date()
      const decay = { halfLifeHours: moodHalfLifeHours, maxAgeHours: moodMaxAgeHours }
      const describe = (state: MoodState | null): JsonValue => {
        if (state === null) return { present: false } as unknown as JsonValue
        const view = moodView(state, now, decay)
        return {
          present: true,
          label: state.label,
          valence: state.valence ?? null,
          arousal: state.arousal ?? null,
          updated: state.updated ?? null,
          body: state.body,
          ageHours: Number.isFinite(view.ageHours) ? Math.round(view.ageHours * 10) / 10 : null,
          weight: Math.round(view.weight * 100) / 100,
          fresh: view.fresh,
          text: view.text,
        } as unknown as JsonValue
      }
      const local = scope === 'global' ? null : moodCache.get(workspace) ?? await loadMood(workspace)
      const shared = scope === 'workspace' ? null : globalCache.mood === undefined ? await loadGlobalMood() : globalCache.mood
      const effective = effectiveMood(workspace, now)
      return {
        ok: true,
        scope,
        decay,
        effective: effective === undefined ? null : { label: effective.label, updated: effective.updated ?? null },
        workspace: describe(local),
        global: { inherited: config.layers.inherit.mood, ...describe(shared) as object },
        note: '取「最新一份」而不是混合；超过 maxAgeHours 或权重低于 0.05 会被视为已平复。',
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mood_set',
    description:
      '写入当前情绪状态（覆盖 current.md，自动记 updated）。情绪只描述此刻的倾向与唤醒度，不是记忆：需要留档的结论请用 memory_write。',
    parameters: {
      label: { type: 'string' as const, required: true, description: '情绪名，如 专注、烦躁、轻松' },
      scope: { type: 'string' as const, enum: ['workspace', 'global'], description: 'workspace（默认，本项目）/ global（跨工作区整体状态）' },
      valence: { type: 'number' as const, description: '-1 消极 … +1 积极（可选）' },
      arousal: { type: 'number' as const, description: '0 平静 … 1 亢奋（可选）' },
      note: { type: 'string' as const, description: '一两句备注（可选，最多 1024 字节）' },
      sandbox_permissions: { type: 'string' as const, enum: ['workspace-write', 'danger-full-access'], description: 'scope=global 且当前策略写不到 $DSH_HOME 时使用：请求一次升级' },
      justification: { type: 'string' as const, description: '与 sandbox_permissions 成对出现：一句给用户看的理由（用用户当前语言）' },
    },
    output: jsonOutput,
    async execute(args, exec): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const scope = scopeArg(args.scope, 'workspace') === 'global' ? 'global' : 'workspace'
      const config = await configFor(workspace)
      if (!config.layers.mood) {
        const refused = await refuseLayer(workspace, 'mood')
        if (refused !== undefined) return refused
      }
      if (scope === 'global' && !config.layers.inherit.mood) {
        return {
          ok: false,
          error: `本工作区屏蔽了全局情绪（${WORKSPACE_CONFIG_REL} 的 ${CONFIG_SECTION}.inherit.mood: false）`,
          configFile: config.rel,
        } as unknown as JsonValue
      }
      const now = new Date()
      let document: string
      try {
        document = buildMoodDocument({
          label: args.label,
          ...args.valence !== undefined ? { valence: args.valence } : {},
          ...args.arousal !== undefined ? { arousal: args.arousal } : {},
          ...args.note !== undefined ? { note: args.note } : {},
        }, now)
      } catch (error) {
        return { ok: false, error: `情绪参数无效：${error instanceof Error ? error.message : String(error)}` } as unknown as JsonValue
      }
      const dir = scope === 'global' ? globalLayerDir(globalRoot, 'mood') : workspaceLayerDir(workspace, 'mood')
      const path = join(dir, MOOD_FILE_NAME)
      const policy = scope === 'global' ? await writePolicyFor('mood_set', args, exec) : undefined
      if (scope === 'global' && !policyWritable(policy, path)) {
        return {
          ok: false,
          scope,
          error: '当前权限模式写不到全局情绪文件（$DSH_HOME 在工作区之外）',
          hint: '带 sandbox_permissions: "danger-full-access" 与 justification 重试，用户批准后仅本次写入生效。',
        } as unknown as JsonValue
      }
      let written: string
      try {
        written = await writeAt(path, document, currentSession(), policy)
      } catch (error) {
        return {
          ok: false,
          scope,
          error: `写入被拒绝：${error instanceof Error ? error.message : String(error)}`,
          hint: scope === 'global' ? '全局情绪在 $DSH_HOME 下，workspace-write 策略不允许写工作区之外' : '当前策略不允许写该路径',
        } as unknown as JsonValue
      }
      const parsed = parseMoodDocument(document)
      if (scope === 'global') globalCache.mood = parsed.state ?? null
      else moodCache.set(workspace, parsed.state ?? null)
      return {
        ok: true,
        written: true,
        scope,
        ...scope === 'global' ? { visibleTo: '所有工作区（下一个请求即生效）' } : {},
        path: written,
        state: parsed.state === undefined
          ? { label: args.label }
          : {
              label: parsed.state.label,
              valence: parsed.state.valence ?? null,
              arousal: parsed.state.arousal ?? null,
              updated: parsed.state.updated ?? null,
            },
      } as unknown as JsonValue
    },
  }))

  ctx.effect(() => prompt.context({
    name: 'workspace-persona',
    order: 50,
    text: (assembly: { readonly agent?: unknown }) => {
      try {
        const agent = assembly.agent
        const workspace = workspaceOf(agent)
        if (workspace === undefined) return ''
        const session = sessionOf(agent)
        if (session !== undefined) sessions.set(workspace, session)
        if (!layerOn(workspace, 'persona')) return ''
        const local = personaCache.get(workspace)
        if (local === undefined) {
          refresh(workspace)
          return ''
        }
        const global = inheritOn(workspace, 'persona') ? globalCache.persona ?? [] : []
        const merged = mergePersona(global, local.fragments)
        return renderPersonaSection(merged.fragments, { maxBytes: personaPromptBytes, fileBytes: personaFileBytes }).text
      } catch { return '' }
    },
  }), 'workspace-conventions.persona')

  ctx.effect(() => prompt.context({
    name: 'workspace-mood',
    order: 52,
    text: (assembly: { readonly agent?: unknown }) => {
      try {
        const agent = assembly.agent
        const workspace = workspaceOf(agent)
        if (workspace === undefined) return ''
        const session = sessionOf(agent)
        if (session !== undefined) sessions.set(workspace, session)
        if (!layerOn(workspace, 'mood')) return ''
        if (moodCache.get(workspace) === undefined) {
          refresh(workspace)
          return ''
        }
        const now = new Date()
        return renderMoodSection(effectiveMood(workspace, now), now, {
          halfLifeHours: moodHalfLifeHours,
          maxAgeHours: moodMaxAgeHours,
          maxBytes: moodPromptBytes,
          renderQuiet: true,
        })
      } catch { return '' }
    },
  }), 'workspace-conventions.mood')

  // The mood layer is only a tool: nothing is written unless the model decides
  // to call `mood_set`. This section is the one thing the plugin can do about
  // that — name the moments worth recording, and say explicitly that a quiet
  // turn is not worth a write. It renders switches and caches only, so it stays
  // synchronous like every provider here and costs 0 tokens when off.
  ctx.effect(() => prompt.context({
    name: 'workspace-mood-maintenance',
    order: 53,
    text: (assembly: { readonly agent?: unknown }) => {
      try {
        const agent = assembly.agent
        const workspace = workspaceOf(agent)
        if (workspace === undefined) return ''
        const session = sessionOf(agent)
        if (session !== undefined) sessions.set(workspace, session)
        if (!moodProactive || !layerOn(workspace, 'mood')) return ''
        // "No record yet" may only be claimed after both scopes were probed and
        // both came back empty. An unprobed store stays silent rather than
        // inviting a duplicate first write on the warm-up turn.
        const local = moodCache.get(workspace)
        const shared = globalCache.mood
        const missingRecord = local === null
          && (inheritOn(workspace, 'mood')
            ? shared !== undefined && shared === null
            : true)
        return renderMoodMaintenanceSection({ missingRecord })
      } catch { return '' }
    },
  }), 'workspace-conventions.mood-maintenance')

  ctx.effect(() => prompt.context({
    name: 'global-rules',
    order: 54,
    text: (assembly: { readonly agent?: unknown }) => {
      try {
        const agent = assembly.agent
        const workspace = workspaceOf(agent)
        if (workspace === undefined) return ''
        const session = sessionOf(agent)
        if (session !== undefined) sessions.set(workspace, session)
        if (!layerOn(workspace, 'rules') || !inheritOn(workspace, 'rules')) return ''
        const rules = globalCache.rules
        if (rules === undefined) {
          refresh(workspace)
          return ''
        }
        if (rules.length === 0) return ''
        return renderRulesSection({
          dir: toPosix(globalLayerDir(globalRoot, 'rules')),
          rules,
          active: globalTriggered.get(workspace) ?? EMPTY_RULES,
          ruleFileBytes,
          maxBytes: globalRulesPromptBytes,
          title: '# 全局规则（跨工作区；每个工作区都生效）',
        })
      } catch { return '' }
    },
  }), 'workspace-conventions.global-rules')

  // The prompt providers are SYNCHRONOUS by contract: `assemble()` calls them
  // without awaiting. Their asynchronous probes feed the caches; these only
  // render those caches.
  ctx.effect(() => prompt.context({
    name: 'workspace-rules',
    order: 55,
    text: (assembly: { readonly agent?: unknown }) => {
      try {
        const agent = assembly.agent
        const workspace = workspaceOf(agent)
        if (workspace === undefined) return ''
        const session = sessionOf(agent)
        if (session !== undefined) sessions.set(workspace, session)
        // A workspace switch decides whether this layer is injected at all.
        if (!layerOn(workspace, 'rules')) return ''
        const state = rulesCache.get(workspace)
        if (state === undefined) {
          refresh(workspace)
          return ''
        }
        return renderRulesSection({
          dir: state.dirRel,
          rules: state.rules,
          active: triggered.get(workspace) ?? EMPTY_RULES,
          ruleFileBytes,
          maxBytes: rulesPromptBytes,
        })
      } catch { return '' }
    },
  }), 'workspace-conventions.rules')

  ctx.effect(() => prompt.context({
    name: 'global-memory',
    order: 58,
    text: (assembly: { readonly agent?: unknown }) => {
      try {
        const agent = assembly.agent
        const workspace = workspaceOf(agent)
        if (workspace === undefined) return ''
        const session = sessionOf(agent)
        if (session !== undefined) sessions.set(workspace, session)
        const cached = cachedConfig(workspace)
        if (cached !== undefined && !isMemoryWritable(cached.layers.memory)) return ''
        if (!inheritOn(workspace, 'memory')) return ''
        const state = globalCache.memory
        if (state === undefined) {
          refresh(workspace)
          return ''
        }
        // An untouched global profile must stay invisible: a section that only
        // ever says "nothing here yet" is pure per-turn token cost.
        if (!state.exists || state.entries.length === 0) return ''
        return renderGlobalMemory(state)
      } catch { return '' }
    },
  }), 'workspace-conventions.global-memory')

  ctx.effect(() => prompt.context({
    name: 'workspace-memory',
    order: 60,
    text: (assembly: { readonly agent?: unknown }) => {
      try {
        const agent = assembly.agent
        const workspace = workspaceOf(agent)
        if (workspace === undefined) return ''
        const session = sessionOf(agent)
        if (session !== undefined) sessions.set(workspace, session)
        // `disabled` drops the section. `read-only` drops it too: what this
        // section carries is the index text itself, and a read-only workspace
        // still reaches that content through the read tools, so injecting it
        // every turn would only duplicate what the tools can fetch on demand.
        const cached = cachedConfig(workspace)
        if (cached !== undefined && !isMemoryWritable(cached.layers.memory)) return ''
        const state = cache.get(workspace)
        if (state === undefined) {
          refresh(workspace)
          return '# 工作区记忆\n\n正在探测工作区记忆体系（下一轮生效）；可用 memory_status 查看当前状态。'
        }
        return renderPrompt(workspace, state)
      } catch { return '' }
    },
  }), 'workspace-conventions.context')

  // Publish `.workbuddy/skills` through the ordinary skill registry, so the
  // stock `skill` tool loads those bundles with their relative resources.
  const skillReader: SkillStoreReader = {
    list: async (dir) => listAt(dir),
    read: async (path) => readAt(path),
  }
  ctx.effect(() => ctx.skills.registerProvider((control) => {
    invalidateSkills = control.invalidate
    return createWorkbuddySkillProvider(skillReader, 'workspace-workbuddy-skills', (message) => {
      ctx.logger.warn(message)
    }, (workspace) => layerOn(workspace, 'skills'))
  }), 'workspace-conventions.skills')

  /**
   * Write-approval gate for the two stores whose mistakes travel.
   *
   * The decision is pure (`approvalRequestFor`); this listener only resolves the
   * workspace switches and routes the answer through DSH's approval seam. It
   * calls `next()` first and turns only a plain allow into an ask, so a stricter
   * downstream decision — a deny, a cancel, or another plugin's own ask — is
   * preserved instead of being overridden.
   *
   * Only the three gated names are probed: every other tool call is forwarded
   * without an await, so the gate costs nothing on unrelated work. With approval
   * policy `never` (or no answerer) DSH deterministically denies the ask and the
   * tool body never runs, which is the intended fail-closed behaviour.
   */
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== 'memory_write' && exec.name !== 'memory_promote' && exec.name !== 'memory_revise' && exec.name !== 'persona_write') return next()
    // A workspace whose layer is off — or whose global scope is blocked —
    // refuses the call in its own body with a message naming the switch, so the
    // gate stays silent instead of asking the user to approve a doomed write.
    const workspace = exec.agent === undefined ? undefined : workspaceOf(exec.agent)
    const layers = workspace === undefined ? DEFAULT_LAYERS : (await configFor(workspace)).layers
    const request = approvalRequestFor(
      { name: exec.name, arguments: exec.arguments },
      {
        globalMemory: approveGlobalMemory,
        persona: approvePersonaWrite,
        escalation: hasEscalationArgs(exec.arguments),
        memoryWritable: layers.memory === 'enabled',
        inheritMemory: layers.inherit.memory,
        personaEnabled: layers.persona,
        inheritPersona: layers.inherit.persona,
      },
    )
    if (request === undefined) return next()
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    return {
      kind: 'ask',
      reason: request.reason,
      displayReason: { en: request.displayReason.en, zh: request.displayReason.zh },
    }
  })

  /**
   * The workspace-relative path a file-touching tool call reached, or
   * `undefined` when the call is not one of DSH's structured filesystem tools.
   *
   * Shell navigation is deliberately excluded: parsing arbitrary shell syntax is
   * not a reliable filesystem seam, which is the same boundary the shipped
   * workspace-instruction loader draws.
   */
  const touchedPath = (exec: ToolExecution, workspace: string): string | undefined => {
    if (exec.name !== 'read' && exec.name !== 'write' && exec.name !== 'edit') return undefined
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return undefined
    const raw = 'file_path' in args ? (args as { readonly file_path?: unknown }).file_path : undefined
    if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
    const absolute = isAbsolute(raw.trim()) ? resolve(raw.trim()) : resolve(workspace, raw.trim())
    const rel = relative(resolve(workspace), absolute)
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return undefined
    return toPosix(rel)
  }

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult): undefined => {
    if (result.isError) return undefined
    const agent = exec.agent
    if (agent === undefined || exec.signal.aborted) return undefined
    const workspace = workspaceOf(agent)
    if (workspace === undefined) return undefined
    // With the layer off no book may be injected, so recording a trigger would
    // only accumulate state that nothing reads.
    if (!layerOn(workspace, 'rules')) return undefined
    const rel = touchedPath(exec, workspace)
    if (rel === undefined) return undefined

    // A skill bundle the model just wrote must reach the next catalog without a
    // restart; the registry has no watcher of its own for this provider.
    if (rel === SKILLS_DIR_REL || rel.startsWith(`${SKILLS_DIR_REL}/`)) invalidateSkills?.()

    void (async () => {
      const [state, shared] = await Promise.all([rulesFor(workspace), globalCache.rules ?? loadGlobalRules()])
      const record = (hits: readonly RuleDefinition[], target: Map<string, Set<string>>): void => {
        if (hits.length === 0) return
        let active = target.get(workspace)
        if (active === undefined) {
          active = new Set()
          target.set(workspace, active)
        }
        for (const rule of hits) active.add(rule.rel)
      }
      record(matchingRules(state.rules, rel), triggered)
      // Global conditional books trigger on the same workspace-relative touch, but
      // their activation stays per workspace so one project cannot force another's.
      record(matchingRules(shared, rel), globalTriggered)
    })().catch(() => undefined)
    return undefined
  })

  // Warm the caches for every session this scope serves, so the synchronous
  // providers have content on the session's first turn. The global layers are
  // re-read here too: they are process-wide and nobody watches their files, so a
  // new session is the moment an edit made outside this process becomes visible.
  const prewarm = (agent: unknown): void => {
    const workspace = workspaceOf(agent)
    const session = sessionOf(agent)
    if (workspace !== undefined && session !== undefined) sessions.set(workspace, session)
    refresh(workspace)
    refreshGlobal()
  }
  ctx.on('agent/created', (payload: { readonly agent?: unknown }): undefined => { prewarm(payload.agent) })
  prewarm(agentNow())
}
