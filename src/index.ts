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
 * @module @jinngoo/dsh-workspace-memory
 */

import { hostname } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

import { DEFAULT_DIR, INDEX_FILE, MEMORY_SUBDIR, RULES_SUBDIR, WORKBUDDY_DIR } from './layout.js'
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
  SKILLS_DIR_REL,
  createWorkbuddySkillProvider,
  type SkillStoreReader,
} from './skills.js'
import { dateStamp, normalizeText, toPosix } from './text.js'

export const name = 'workspace-memory'

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
}

/** Runtime schema for the row. */
export const Config: z<Config> = z.object({
  indexPromptBytes: z.number().default(7000),
  rulesPromptBytes: z.number().default(48 * 1024),
  ruleFileBytes: z.number().default(RULE_FILE_BYTES),
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

const EMPTY_RULES: ReadonlySet<string> = new Set()

/**
 * Register the memory tools, the rules tools, the two prompt sections and the
 * skill provider for the mounting scope.
 * @param ctx - an agent-scope context supplying `fs`, `agents`, `systemPrompt`, `sandboxPolicy`, `tools` and `skills`.
 * @param config - the injected-index cap, the rules cap and the per-book cap.
 */
export function apply(ctx: Context, config: Config): void {
  const indexPromptBytes = config.indexPromptBytes
  const rulesPromptBytes = config.rulesPromptBytes
  const ruleFileBytes = config.ruleFileBytes
  const fs = ctx.fs
  const agents = ctx.agents
  const prompt = ctx.systemPrompt
  const host = hostname()

  const cache = new Map<string, WorkspaceMemoryState>()
  const rulesCache = new Map<string, WorkspaceRulesState>()
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

  const statAt = async (target: string): Promise<{ readonly type?: string, readonly size?: number } | undefined> => {
    try {
      const t = await fs.resolve(target)
      const info = await fs.stat(t)
      return info as { readonly type?: string, readonly size?: number } | undefined
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

  const writeAt = async (target: string, content: string, session: unknown): Promise<string> => {
    const t = await fs.resolve(target)
    await fs.writeText(t, content, undefined, undefined, policyFor(session))
    return toPosix(t.displayPath)
  }

  /** Probe both memory backends for one workspace and resolve the active one. */
  const loadState = async (workspace: string): Promise<WorkspaceMemoryState> => {
    const probe = async (backendName: string, dir: string) => {
      const index = join(dir, INDEX_FILE)
      const info = await statAt(dir)
      const exists = info?.type === 'directory'
      const root = exists ? await listAt(dir) : []
      // One level only: under the per-computer layout a machine name is a direct
      // child of the store directory, and nothing deeper holds ledgers. Dot
      // directories are skipped so version-control metadata is never scanned.
      const subdirs = await Promise.all(
        root
          .filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.'))
          .map(async (entry): Promise<HostDirScan> => ({ name: entry.name, entries: await listAt(join(dir, entry.name)) })),
      )
      const scan = scanLedgers(root, subdirs, host)
      const indexText = exists ? await readAt(index) : undefined
      const indexInfo = indexText === undefined ? undefined : await statAt(index)
      return {
        name: backendName,
        dir,
        index,
        exists,
        hasIndex: indexText !== undefined,
        bytes: indexInfo?.size ?? 0,
        indexText: indexText ?? '',
        ...scan,
      }
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

  const refresh = (workspace: string | undefined): void => {
    if (workspace === undefined) return
    void loadState(workspace).catch(() => undefined)
    void loadRules(workspace).catch(() => undefined)
  }

  const stateFor = async (workspace: string): Promise<WorkspaceMemoryState> =>
    cache.get(workspace) ?? await loadState(workspace)

  const rulesFor = async (workspace: string): Promise<WorkspaceRulesState> =>
    rulesCache.get(workspace) ?? await loadRules(workspace)

  /** Render the memory prompt section from a cached snapshot. Total: it never throws. */
  const renderPrompt = (workspace: string, state: WorkspaceMemoryState): string => {
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

    const lines = [
      state.compat
        ? '# 工作区记忆（已检测到 WorkBuddy 体系，按原生准则兼容）'
        : '# 工作区记忆（无既有记忆体系，使用 DSH 默认规则）',
      '',
      `- 工作区：${toPosix(workspace)}`,
      `- 生效后端：${state.name}${state.compat ? '（兼容模式）' : '（默认模式）'}`,
      `- 记忆目录：${toPosix(state.dir)}`,
      `- 索引：${toPosix(state.index)}（${String(state.bytes)} 字节）`,
      `- 日期流水：${state.ledgers.length > 0
        ? state.ledgers.slice(0, 3).map((f) => f.rel).join(', ')
          + (state.ledgers.length > 3 ? ` 等共 ${String(state.ledgers.length)} 个` : '')
        : '无'}`,
      `- 流水布局：${state.layout === 'host' ? `按计算机名分目录（本机 ${state.host}）` : '平铺在记忆目录下'}`,
      '- 工具：memory_status / memory_read / memory_search / memory_write / memory_promote / memory_help',
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

  const jsonOutput = {
    schema: { type: 'json' } as const,
    render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }

  ctx.tools.register(defineTool({
    name: 'memory_status',
    description:
      '报告本会话生效的工作区记忆后端：工作区存在 .workbuddy/memory 时优先兼容该体系，否则使用 DSH 默认的 .dsh/memory。'
      + '返回解析出的路径、索引大小，以及日期流水的存放布局与本机计算机名。',
    parameters: {},
    output: jsonOutput,
    async execute(): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const state = await stateFor(workspace)
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
        globalScope: '未实现（接口已预留）',
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description:
      '读取工作区记忆。layer=index 返回索引 MEMORY.md —— 硬约束、稳定偏好与文档指针；'
      + 'layer=ledger 返回某一天的流水文件，默认今天。日期文件可能平铺在记忆目录下，也可能按计算机名放在子目录里，本工具会按目录实际形状定位。',
    parameters: {
      layer: { type: 'string' as const, enum: ['index', 'ledger'], description: 'index = 索引 MEMORY.md；ledger = 某一天的日期流水' },
      date: { type: 'string' as const, description: 'layer=ledger 的日期 YYYY-MM-DD，默认今天' },
      limit: { type: 'number' as const, description: '读取流水时返回的最大尾部行数，默认 200' },
    },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const state = await stateFor(workspace)
      const ledgers = state.ledgers.map((f) => f.rel)

      if (args.layer === 'ledger') {
        const date = args.date !== undefined && args.date.length > 0 ? args.date : dateStamp()
        const path = join(state.dir, ledgerForDate(state, date)?.rel ?? ledgerWritePath(state, date))
        const content = await readAt(path)
        if (content === undefined) {
          return { ok: true, layer: 'ledger', date, path: toPosix(path), exists: false, text: '', ledgers } as unknown as JsonValue
        }
        const cap = args.limit !== undefined && args.limit > 0 ? Math.min(args.limit, 400) : 200
        const lines = normalizeText(content).split('\n')
        const truncated = lines.length > cap
        return {
          ok: true,
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
      + '写入新记忆前先检索，避免重复记录已有的事实。',
    parameters: { query: { type: 'string' as const, required: true, description: '要查找的字面文本' } },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const state = await stateFor(workspace)
      const query = normalizeText(args.query)
      if (query.length === 0) return { ok: false, error: 'query 不能为空' } as unknown as JsonValue

      const needle = query.toLowerCase()
      const ledgerFiles = state.ledgers.map((f) => f.rel)
      const files = state.hasIndex ? [INDEX_FILE, ...ledgerFiles] : ledgerFiles
      const hits: { file: string, line: number, text: string }[] = []
      for (const file of files) {
        const content = await readAt(join(state.dir, file))
        if (content === undefined) continue
        normalizeText(content).split('\n').forEach((line, i) => {
          if (line.toLowerCase().includes(needle)) hits.push({ file, line: i + 1, text: line.trim().slice(0, 240) })
        })
      }
      return { ok: true, query, backend: state.name, totalHits: hits.length, hits: hits.slice(0, 120) } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description:
      '经准入审查后，向日期流水追加一条跨会话仍有价值的记忆：决策及其理由、稳定偏好、约定、可复现的坑、环境限制、硬约束。'
      + '绝不记录密钥、一次性改动或排错流水账；读起来像流水账的条目会被拒绝，除非 force=true。'
      + '写入位置遵循记忆目录的实际布局：平铺时写 memory/YYYY-MM-DD.md，按计算机名分目录时写 memory/<本机计算机名>/YYYY-MM-DD.md。',
    parameters: {
      content: { type: 'string' as const, required: true, description: '持久的事实、决策、约定或坑本身' },
      kind: { type: 'string' as const, enum: [...ENTRY_KINDS], description: '条目分类，默认 fact' },
      title: { type: 'string' as const, description: '内容较长时的单行标题（可选）' },
      tags: { type: 'array' as const, items: { type: 'string' as const }, description: '标签（可选）' },
      force: { type: 'boolean' as const, description: '带软性提醒仍写入；无法绕过硬性拒绝' },
      date: { type: 'string' as const, description: '覆盖目标日期 YYYY-MM-DD，默认今天' },
    },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const state = await stateFor(workspace)
      const verdict = evaluateEntry(args.content, args.kind)

      if (!verdict.allowed) {
        return { ok: false, written: false, kind: verdict.kind, reasons: verdict.reasons, warnings: verdict.warnings } as unknown as JsonValue
      }
      if (verdict.warnings.length > 0 && args.force !== true) {
        return {
          ok: false,
          written: false,
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
        scope: 'workspace',
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.tags !== undefined ? { tags: args.tags } : {},
      })
      const next = created || normalizeText(existing).length === 0
        ? `# ${date}\n\n${block}\n`
        : `${normalizeText(existing).replace(/\s+$/, '')}\n\n${block}\n`

      const written = await writeAt(path, next, currentSession())
      refresh(workspace)
      return {
        ok: true,
        written: true,
        backend: state.name,
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
      '把一行提升进索引 MEMORY.md 的指定章节，使其每轮都注入上下文。此层只留给硬约束、稳定偏好、长期约定与文档指针，'
      + '不放细节、现状或流水账。已有章节原样保留；重复条目幂等。',
    parameters: {
      entry: { type: 'string' as const, required: true, description: '要加入索引的单行条目' },
      section: { type: 'string' as const, description: '目标章节标题；同名章节保持原位，缺失则新建' },
      kind: { type: 'string' as const, enum: [...ENTRY_KINDS], description: '用于准入审查的分类' },
    },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const state = await stateFor(workspace)
      const entry = normalizeText(args.entry)
      if (entry.length === 0) return { ok: false, changed: false, error: '提升内容不能为空' } as unknown as JsonValue

      const verdict = evaluateEntry(entry, args.kind)
      if (!verdict.allowed) return { ok: false, changed: false, reasons: verdict.reasons } as unknown as JsonValue

      const section = normalizeText(args.section) || '未分类'
      const base = state.hasIndex && state.indexText.length > 0 ? state.indexText : `# ${section}\n\n`
      const result = upsertIndexEntry(base, section, entry)
      if (!result.changed) {
        return { ok: true, changed: false, path: toPosix(state.index), section } as unknown as JsonValue
      }
      const written = await writeAt(state.index, result.text, currentSession())
      refresh(workspace)
      return { ok: true, changed: true, backend: state.name, path: written, section, createdSection: result.createdSection } as unknown as JsonValue
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
      const state = await stateFor(workspace)
      return {
        ok: true,
        backend: state.name,
        mode: state.compat ? 'workbuddy' : 'dsh-default',
        memoryDir: toPosix(state.dir),
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
      const state = await rulesFor(workspace)
      const active = triggered.get(workspace) ?? EMPTY_RULES
      return {
        ok: true,
        workspace: toPosix(workspace),
        rulesDir: state.dirRel,
        absoluteDir: state.dir,
        exists: state.exists,
        budgets: { rulesPromptBytes, ruleFileBytes },
        total: state.rules.length,
        books: state.rules.map((rule) => ({
          file: rule.file,
          title: rule.title,
          kind: rule.alwaysApply ? 'always' : rule.paths.length > 0 ? 'conditional' : 'on-demand',
          paths: rule.paths,
          bytes: rule.bytes,
          triggered: active.has(rule.rel),
          issue: rule.issue,
        })),
        note: '条件册只按「读/写/编辑匹配文件」触发；用 shell 改文件不会触发（DSH 的触碰追踪只认这三个工具的 file_path 参数）。',
      } as unknown as JsonValue
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rule_read',
    description:
      '读取一册工作区规则的完整正文（绕过 16 KB 注入上限）。用于按需规则、未被预算注入的条件册，'
      + '以及新建文件前的兜底——新建文件不一定触发条件册注入。',
    parameters: { file: { type: 'string' as const, required: true, description: '册文件名或工作区相对路径，例如 01-协作红线.md' } },
    output: jsonOutput,
    async execute(args): Promise<JsonValue> {
      const workspace = currentWorkspace()
      if (workspace === undefined) return { ok: false, error: '无法确定当前会话的工作区' } as unknown as JsonValue
      const state = await rulesFor(workspace)
      const query = normalizeText(args.file).replace(/^\.\//, '')
      const byRel = state.rules.find((rule) => rule.rel === query || rule.rel === `${state.dirRel}/${query}`)
      const byName = state.rules.find((rule) => rule.file === query)
      const rule = byRel ?? byName
      if (rule === undefined) {
        return {
          ok: false,
          error: `未找到规则册：${query}`,
          available: state.rules.map((r) => r.file),
        } as unknown as JsonValue
      }
      return {
        ok: true,
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
  }), 'workspace-memory.rules')

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
        const state = cache.get(workspace)
        if (state === undefined) {
          refresh(workspace)
          return '# 工作区记忆\n\n正在探测工作区记忆体系（下一轮生效）；可用 memory_status 查看当前状态。'
        }
        return renderPrompt(workspace, state)
      } catch { return '' }
    },
  }), 'workspace-memory.context')

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
    })
  }), 'workspace-memory.skills')

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
    const rel = touchedPath(exec, workspace)
    if (rel === undefined) return undefined

    // A skill bundle the model just wrote must reach the next catalog without a
    // restart; the registry has no watcher of its own for this provider.
    if (rel === SKILLS_DIR_REL || rel.startsWith(`${SKILLS_DIR_REL}/`)) invalidateSkills?.()

    void (async () => {
      const state = await rulesFor(workspace)
      const hits = matchingRules(state.rules, rel)
      if (hits.length === 0) return
      let active = triggered.get(workspace)
      if (active === undefined) {
        active = new Set()
        triggered.set(workspace, active)
      }
      for (const rule of hits) active.add(rule.rel)
    })().catch(() => undefined)
    return undefined
  })

  // Warm the caches for every session this scope serves, so the synchronous
  // providers have content on the session's first turn.
  const prewarm = (agent: unknown): void => {
    const workspace = workspaceOf(agent)
    const session = sessionOf(agent)
    if (workspace !== undefined && session !== undefined) sessions.set(workspace, session)
    refresh(workspace)
  }
  ctx.on('agent/created', (payload: { readonly agent?: unknown }): undefined => { prewarm(payload.agent) })
  prewarm(agentNow())
}
