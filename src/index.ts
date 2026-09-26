/**
 * DSH workspace memory as a composable row.
 *
 * One agent preset mounts this row once; each session joining that scope reads
 * and writes memory inside **its own working directory**. Two backends are
 * supported and the choice is automatic:
 *
 * - **WorkBuddy-compatible** (`.workbuddy/memory/`) when that directory already
 *   exists. The row then mirrors that system's own writing criteria: its
 *   `MEMORY.md` is an index and preference file only (details, current state and
 *   troubleshooting belong in documents), dated files are append-only, and
 *   "小事、小修改、一次性操作与排错过程不写记忆" is enforced in code. Its dated
 *   ledgers are found in either layout that system really uses — flat in the
 *   store root, or one subdirectory per computer — and a new ledger follows
 *   whichever layout the store already has.
 * - **DSH default** (`.dsh/memory/`) otherwise, with the same index-plus-dated-ledger
 *   shape, so switching between the two changes nothing about how a model uses it.
 *
 * Memory is workspace-scoped. Every resolved entry carries a `scope`, and the
 * resolution is a list of scopes, which is the reserved seam for a future global
 * memory scope: registering one is additive, and the read/write orchestration
 * does not change.
 *
 * Three layers, identical in meaning across both backends:
 *
 * | layer | lifetime | contents |
 * |---|---|---|
 * | index (`MEMORY.md`) | injected every turn | hard constraints, stable preferences, long-lived conventions, document pointers |
 * | ledger (`YYYY-MM-DD.md`) | append-only, read on demand | durable facts that need a record but not permanent context |
 * | evidence | wherever it already lives | documents and code; the index keeps pointers rather than copies |
 *
 * The dominant failure mode of a memory system is not "too little stored" but
 * "too much stored": an index that grows without bound poisons the context every
 * turn. Admission is therefore a first-class step here, and hard rejections
 * (secrets, empty or over-long entries) cannot be forced.
 *
 * Two constraints are load-bearing and easy to get wrong:
 *
 * 1. `systemPrompt.context()` is **synchronous** — `assemble()` does not await a
 *    provider, so an `async` provider returns a Promise instead of a string and
 *    fails every turn. The probe therefore runs asynchronously into a cache and
 *    the provider renders that cache synchronously.
 * 2. `fs.writeText()` must be given the **session** sandbox policy. Without a
 *    session, the sandbox falls back to the deployment's default workspace root
 *    and denies writes inside this session's own workspace.
 *
 * @module @jinngoo/dsh-workspace-memory
 */

import { hostname } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Cordis plugin name. */
export const name = 'workspace-memory'

/**
 * Every service this row reaches. All five are host-plane and are only consumed;
 * the row publishes nothing, so it needs no `isolate` realm. `tools` is required
 * because registration goes through `ctx.tools.register`.
 */
export const inject = ['fs', 'agents', 'systemPrompt', 'sandboxPolicy', 'tools']

/** Entry classifications shared by both backends. */
export const ENTRY_KINDS = [
  'decision',
  'preference',
  'convention',
  'pitfall',
  'environment',
  'constraint',
  'fact',
] as const

/** One entry classification. */
export type EntryKind = (typeof ENTRY_KINDS)[number]

/** Activity verbs that mark a line as play-by-play rather than a durable fact. */
const ACTIVITY_VERBS: readonly string[] = [
  '修复了', '修改了', '更新了', '完成了', '新建了', '删除了', '重构了', '实现了',
  '检查了', '排查了', '运行了', '编译了', '提交了', '调整了',
  'fixed', 'updated', 'implemented', 'completed', 'refactored',
]

/** Rejections that `force` cannot bypass. */
const HARD_RULES: readonly { readonly re: RegExp, readonly why: string }[] = [
  { re: /(api[-_]?key|secret|password|passwd|token|credential)\s*[:=]\s*\S{8,}/i, why: '疑似密钥或凭据，记忆文件不得存放秘密' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '疑似私钥内容' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, why: '疑似个人邮箱等 PII，未经确认不得写入' },
]

/** A backend's verdict on one candidate entry. */
export interface EntryVerdict {
  /** Whether the entry may be written at all. */
  readonly allowed: boolean
  /** Unconditional refusals; `force` cannot override them. */
  readonly reasons: readonly string[]
  /** Advisories that require an explicit `force` at the call site. */
  readonly warnings: readonly string[]
  /** The resolved classification. */
  readonly kind: EntryKind
  /** The normalized entry body. */
  readonly body: string
}

/** Normalize any value to a primitive, trimmed string. */
export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * Decide whether one candidate entry may be written at all.
 *
 * Hard rejections are unconditional. Soft warnings mean "this looks like the
 * content the criteria exclude" and require an explicit `force`, which is the
 * call site's opportunity to rewrite the line as a conclusion instead.
 * @param content - the candidate line.
 * @param kind - the caller's classification; anything unknown falls back to `fact`.
 * @returns the verdict, including the normalized body and classification.
 */
export function evaluateEntry(content: unknown, kind: unknown): EntryVerdict {
  const body = normalizeText(content)
  const chosen: EntryKind = typeof kind === 'string' && (ENTRY_KINDS as readonly string[]).includes(kind)
    ? kind as EntryKind
    : 'fact'
  const reasons: string[] = []
  const warnings: string[] = []

  if (body.length === 0) reasons.push('内容为空')
  else if (body.length < 8) reasons.push('内容过短，无法形成可复用的记忆条目')
  for (const rule of HARD_RULES) if (rule.re.test(body)) reasons.push(rule.why)

  if (ACTIVITY_VERBS.some((v) => body.includes(v))) {
    warnings.push('疑似一次性执行流水账（会话日志已覆盖），只有跨会话仍有价值才应记录')
  }
  if (body.length > 1200) warnings.push('单条记忆偏长，建议精简或下沉到文档')

  return { allowed: reasons.length === 0, reasons, warnings, kind: chosen, body }
}

/** Collapse a value to a single line, capped for use as a heading. */
function oneLine(value: unknown, max = 120): string {
  const s = normalizeText(value).replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD` in local time. */
export function dateStamp(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/** `HH:MM` in local time. */
function clockStamp(at: Date = new Date()): string {
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/** One entry to render into a ledger. */
export interface LedgerEntry {
  /** The durable content. */
  readonly content: string
  /** Classification written into the heading. */
  readonly kind: EntryKind
  /** Memory scope label; defaults to `workspace`. */
  readonly scope?: string
  /** Optional one-line title when the content is long. */
  readonly title?: string
  /** Optional tags. */
  readonly tags?: readonly string[]
  /** Timestamp to record; defaults to now. */
  readonly at?: Date
}

/**
 * Render one ledger entry block.
 * @param entry - the entry to render.
 * @returns the markdown block, without a trailing newline.
 */
export function renderEntry(entry: LedgerEntry): string {
  const body = normalizeText(entry.content)
  const title = oneLine(entry.title ?? body, 120)
  const tags = (entry.tags ?? []).map((t) => oneLine(t, 40)).filter(Boolean)
  const at = entry.at ?? new Date()
  const lines = [`## ${clockStamp(at)} · ${entry.kind}`, `- scope: ${entry.scope ?? 'workspace'}`]
  if (tags.length > 0) lines.push(`- tags: ${tags.join(', ')}`)
  const rendered = title === body ? body : `${title}\n\n${body}`
  return `${lines.join('\n')}\n\n${rendered}`
}

/** A heading line inside an index document. */
export interface IndexSection {
  /** Heading depth. */
  readonly level: number
  /** Heading text. */
  readonly title: string
  /** Line index of the heading. */
  readonly start: number
  /** Line index one past the section's last line. */
  readonly end: number
}

const SECTION_RE = /^(#{1,3})\s+(.+?)\s*$/

/**
 * Decide which heading level carries the index's sections.
 *
 * Two real layouts must both work: WorkBuddy's native `# 项目记忆` followed by
 * `## 一、…` sections (the lone level-1 heading is the document title), and a
 * document that starts straight at `## 一、…` (the shallowest heading IS the
 * section level).
 * @param headings - every heading's depth, in document order.
 * @returns the heading level whose headings are sections.
 */
export function detectSectionLevel(headings: readonly { readonly level: number }[]): number {
  if (headings.length === 0) return 1
  const min = Math.min(...headings.map((h) => h.level))
  const atMin = headings.filter((h) => h.level === min).length
  if (atMin === 1) {
    const deeper = headings.filter((h) => h.level > min)
    if (deeper.length > 0) return Math.min(...deeper.map((h) => h.level))
  }
  return min
}

/** One parsed index document. */
export interface ParsedIndex {
  /** Everything before the first section heading. */
  readonly preamble: string
  /** The document's lines. */
  readonly lines: readonly string[]
  /** The section headings, in document order. */
  readonly sections: readonly IndexSection[]
}

/**
 * Split an index document into its preamble and section offsets.
 * @param source - the index text.
 * @returns the preamble, every line, and the section spans.
 */
export function parseIndexDocument(source: unknown): ParsedIndex {
  const lines = normalizeText(source).split('\n')
  const heads: { at: number, level: number, title: string }[] = []
  lines.forEach((line, at) => {
    const m = SECTION_RE.exec(line)
    if (m !== null) heads.push({ at, level: (m[1] ?? '').length, title: m[2] ?? '' })
  })
  if (heads.length === 0) return { preamble: lines.join('\n'), lines, sections: [] }

  const level = detectSectionLevel(heads)
  const tops = heads.filter((h) => h.level === level)
  const sections: IndexSection[] = tops.map((head, i) => {
    const next = tops[i + 1]
    return {
      level: head.level,
      title: head.title,
      start: head.at,
      end: next === undefined ? lines.length : next.at,
    }
  })
  const first = tops[0]
  return { preamble: lines.slice(0, first === undefined ? 0 : first.at).join('\n'), lines, sections }
}

/** The result of inserting one bullet into an index. */
export interface IndexUpsert {
  /** The next index text. */
  readonly text: string
  /** Whether the text differs from the input. */
  readonly changed: boolean
  /** Whether the target section had to be created. */
  readonly createdSection: boolean
}

/**
 * Insert one bullet into a named index section.
 *
 * The operation is additive and idempotent: existing prose, other sections and
 * the preamble are preserved byte for byte, and a repeated entry reports
 * `changed: false` rather than duplicating. A missing section is created.
 * @param source - the current index text.
 * @param section - the target section title.
 * @param item - the bullet content.
 * @returns the next index text plus what changed.
 */
export function upsertIndexEntry(source: unknown, section: string, item: string): IndexUpsert {
  const body = normalizeText(source)
  const entry = normalizeText(item)
  if (entry.length === 0) throw new Error('memory index entry must not be empty')

  const bullet = `- ${entry.split('\n').join('\n  ')}`
  if (body.includes(entry)) return { text: body, changed: false, createdSection: false }

  const doc = parseIndexDocument(body)
  const target = doc.sections.find((s) => s.title === section)
  if (target === undefined) {
    const appended = body.length > 0 ? `${body}\n\n## ${section}\n${bullet}` : `## ${section}\n${bullet}`
    return { text: appended, changed: true, createdSection: true }
  }

  let at = target.end
  for (let i = target.start + 1; i < target.end; i += 1) {
    const m = SECTION_RE.exec(doc.lines[i] ?? '')
    if (m !== null && (m[1] ?? '').length <= target.level) { at = i; break }
  }
  // Trim trailing blank lines inside the section so bullets do not stack gaps.
  while (at - 1 > target.start && (doc.lines[at - 1] ?? '').trim() === '') at -= 1

  const next = [...doc.lines.slice(0, at), bullet, ...doc.lines.slice(at)]
  return { text: next.join('\n'), changed: true, createdSection: false }
}

/**
 * Present a path with forward slashes so prompt text is platform-neutral.
 * @param p - the path to present.
 * @returns the path with `/` separators.
 */
export function toPosix(p: string): string {
  return p.split('\\').join('/')
}

/**
 * How a store lays out its dated ledgers: flat in the store root, or one
 * subdirectory per computer.
 */
export type LedgerLayout = 'flat' | 'host'

/** One direct child of a store directory, reduced to what discovery needs. */
export interface DirEntry {
  /** Basename of the child. */
  readonly name: string
  /** Kind reported by the filesystem backend, when it reports one. */
  readonly type?: string
}

/** One subdirectory of a store directory and its direct children. */
export interface HostDirScan {
  /** The subdirectory name — a computer name under the per-computer layout. */
  readonly name: string
  /** Its direct children. */
  readonly entries: readonly DirEntry[]
}

/** One dated ledger file found inside a store. */
export interface LedgerFile {
  /** The `YYYY-MM-DD` date encoded in the file name. */
  readonly date: string
  /** Store-relative path with `/` separators: `YYYY-MM-DD.md` or `<host>/YYYY-MM-DD.md`. */
  readonly rel: string
  /** The computer-name subdirectory holding the file; `''` in the flat layout. */
  readonly host: string
}

/** A store's dated-ledger inventory plus where new ledgers belong. */
export interface LedgerScan {
  /** Every dated ledger found, newest first. */
  readonly ledgers: readonly LedgerFile[]
  /** The layout discovered on disk. */
  readonly layout: LedgerLayout
  /** Computer-name subdirectory receiving new ledgers; `''` in the flat layout. */
  readonly hostDir: string
}

const LEDGER_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/

/**
 * Inventory one store's dated ledgers and decide where new ones belong.
 *
 * WorkBuddy writes dated ledgers either flat (`memory/YYYY-MM-DD.md`) or one
 * subdirectory per computer (`memory/<host>/YYYY-MM-DD.md`). Nothing declares
 * which one a workspace uses, so the directory's own shape is the only evidence
 * and this stays a probe rather than a setting. A dated file inside a
 * subdirectory marks the store as per-computer, and so does a subdirectory
 * already named for this machine — the first write on a fresh machine must land
 * beside its siblings instead of in the store root. An exact name match beats a
 * case-insensitive one, because on a case-sensitive filesystem two spellings of
 * one name are two different machines.
 * @param root - the store directory's own children.
 * @param subdirs - one scan per subdirectory of the store directory.
 * @param host - this computer's name, as the OS reports it.
 * @returns the inventory plus the write-target decision.
 */
export function scanLedgers(root: readonly DirEntry[], subdirs: readonly HostDirScan[], host: string): LedgerScan {
  const ledgers: LedgerFile[] = []
  for (const entry of root) {
    if (entry.type === 'file' && LEDGER_FILE_RE.test(entry.name)) {
      ledgers.push({ date: entry.name.slice(0, -3), rel: entry.name, host: '' })
    }
  }
  for (const subdir of subdirs) {
    for (const entry of subdir.entries) {
      if (entry.type !== 'file' || !LEDGER_FILE_RE.test(entry.name)) continue
      ledgers.push({ date: entry.name.slice(0, -3), rel: `${subdir.name}/${entry.name}`, host: subdir.name })
    }
  }
  const named = subdirs.find((d) => d.name === host)
    ?? subdirs.find((d) => d.name.toLowerCase() === host.toLowerCase())
  const perComputer = ledgers.some((f) => f.host !== '') || named !== undefined
  ledgers.sort((a, b) => b.date.localeCompare(a.date) || a.rel.localeCompare(b.rel))
  return {
    ledgers,
    layout: perComputer ? 'host' : 'flat',
    hostDir: named?.name ?? (perComputer ? host : ''),
  }
}

/**
 * The store-relative path one date's ledger is written to.
 * @param scan - the store's inventory.
 * @param date - `YYYY-MM-DD`.
 * @returns a `/`-separated relative path.
 */
export function ledgerWritePath(scan: LedgerScan, date: string): string {
  return scan.layout === 'host' ? `${scan.hostDir}/${date}.md` : `${date}.md`
}

/**
 * The ledger to read for one date.
 *
 * Preference is this computer's own file, then the store root, then — only when
 * it is the single ledger for that date — another computer's, so a day recorded
 * elsewhere stays readable while an ambiguous date never silently resolves to
 * the wrong machine.
 * @param scan - the store's inventory.
 * @param date - `YYYY-MM-DD`.
 * @returns the chosen ledger, or `undefined` when that date has none.
 */
export function ledgerForDate(scan: LedgerScan, date: string): LedgerFile | undefined {
  const sameDate = scan.ledgers.filter((f) => f.date === date)
  return sameDate.find((f) => f.host === scan.hostDir)
    ?? sameDate.find((f) => f.host === '')
    ?? (sameDate.length === 1 ? sameDate[0] : undefined)
}

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

/** Directory name of the WorkBuddy-compatible store. */
export const WORKBUDDY_DIR = '.workbuddy'

/** Directory name of the DSH default store. */
export const DEFAULT_DIR = '.dsh'

/** Index file name used by both backends. */
export const INDEX_FILE = 'MEMORY.md'

/** Plugin config: how much of the index is injected each turn. */
export interface Config {
  /**
   * Byte cap on the index text injected into the prompt every turn. The
   * remainder stays reachable through `memory_read`. Keeps a large WorkBuddy
   * index from crowding out the conversation.
   */
  indexPromptBytes: number
}

/** Runtime schema for the row. */
export const Config: z<Config> = z.object({
  indexPromptBytes: z.number().default(7000),
})

/**
 * Register the memory tools and the prompt section for the mounting scope.
 * @param ctx - an agent-scope context supplying `fs`, `agents`, `systemPrompt` and `sandboxPolicy`.
 * @param config - the injected-index byte cap.
 */
export function apply(ctx: Context, config: Config): void {
  const indexPromptBytes = config.indexPromptBytes
  const fs = ctx.fs
  const agents = ctx.agents
  const prompt = ctx.systemPrompt
  const host = hostname()

  const cache = new Map<string, WorkspaceMemoryState>()
  const sessions = new Map<string, unknown>()

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

  /** Probe both backends for one workspace and resolve the active one. */
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

    const workbuddy = await probe('workbuddy', join(workspace, WORKBUDDY_DIR, 'memory'))
    const fallback = await probe('dsh-default', join(workspace, DEFAULT_DIR, 'memory'))
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

  const refresh = (workspace: string | undefined): void => {
    if (workspace === undefined) return
    void loadState(workspace).catch(() => undefined)
  }

  const stateFor = async (workspace: string): Promise<WorkspaceMemoryState> =>
    cache.get(workspace) ?? await loadState(workspace)

  /** Render the prompt section from a cached snapshot. Total: it never throws. */
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

  // The prompt provider is SYNCHRONOUS by contract: `assemble()` calls it without
  // awaiting. The asynchronous probe feeds the cache; this only renders it, and
  // reports the one-turn warm-up state until the cache is populated.
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

  // Warm the cache for every session this scope serves, so the synchronous
  // provider has content on the session's first turn.
  const prewarm = (agent: unknown): void => {
    const workspace = workspaceOf(agent)
    const session = sessionOf(agent)
    if (workspace !== undefined && session !== undefined) sessions.set(workspace, session)
    refresh(workspace)
  }
  ctx.on('agent/created', (payload: { readonly agent?: unknown }): undefined => { prewarm(payload.agent) })
  prewarm(agentNow())
}
