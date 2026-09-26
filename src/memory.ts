/**
 * The memory model shared by both backends.
 *
 * Pure logic only: admission, rendering, index editing and ledger inventory.
 * Every filesystem probe and every tool lives in the plugin entry, so this
 * module stays a set of functions a test can call directly.
 *
 * The dominant failure mode of a memory system is not "too little stored" but
 * "too much stored": an index that grows without bound poisons the context every
 * turn. Admission is therefore a first-class step, and hard rejections (secrets,
 * empty or over-long entries) cannot be forced.
 *
 * @module @jinngoo/dsh-workspace-memory/memory
 */

import { clockStamp, normalizeText, oneLine } from './text.js'

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
export const HARD_RULES: readonly { readonly re: RegExp, readonly why: string }[] = [
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
