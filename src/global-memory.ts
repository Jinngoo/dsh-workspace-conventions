/**
 * The GLOBAL memory model: one long-lived profile, not a dated ledger.
 *
 * A workspace ledger answers "what happened here", so it is append-only and
 * dated. The global scope answers "who is this user and how should I treat
 * them", so it is a single curated document: a handful of sections holding
 * durable entries, rewritten in place when it needs to change. That difference is
 * the reason this module exists next to `memory.ts` instead of reusing its
 * ledger scan.
 *
 * Anti-bloat is structural, not advisory. The document has a byte budget, every
 * write is checked against it, and `revise` is the intended way to merge, prune
 * and re-word entries instead of appending forever.
 *
 * @module @jinngoo/dsh-workspace-conventions/global-memory
 */

import { normalizeText, oneLine } from './text.js'

/** File name of the single global memory document inside the global memory dir. */
export const GLOBAL_MEMORY_FILE = 'MEMORY.md'

/** The document's fixed title; `revise` keeps it so the file stays recognisable. */
export const GLOBAL_MEMORY_TITLE = '全局记忆'

/** Entry kinds the global profile accepts: durable conclusions, not project facts. */
export const GLOBAL_ENTRY_KINDS = ['preference', 'constraint', 'convention', 'decision'] as const

/** One accepted global entry kind. */
export type GlobalEntryKind = (typeof GLOBAL_ENTRY_KINDS)[number]

/** The sections a fresh document starts with, in display order. */
export const DEFAULT_GLOBAL_SECTIONS = ['关于用户', '偏好与习惯', '要求与规则', '长期约定'] as const

/** One entry line inside a section. */
export interface GlobalEntry {
  /** Classification carried in the `[kind]` marker. */
  readonly kind: GlobalEntryKind
  /** The durable content, one paragraph or a few lines. */
  readonly text: string
}

/** One section of the document. */
export interface GlobalSection {
  /** Section heading text. */
  readonly title: string
  /** Entries in document order. */
  readonly entries: readonly GlobalEntry[]
}

/** A parsed global memory document. */
export interface GlobalMemoryDocument {
  /** Everything before the first section heading (title and notes). */
  readonly preamble: string
  /** Sections in document order. */
  readonly sections: readonly GlobalSection[]
}

/** One entry candidate, as a write tool hands it over. */
export interface GlobalEntryInput {
  /** Content to store. */
  readonly text: string
  /** Classification; must be one of {@link GLOBAL_ENTRY_KINDS}. */
  readonly kind: string
  /** Target section; empty means the first default section. */
  readonly section?: string
}

const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/
const ENTRY_RE = /^\s*[-*]\s+(.*)$/
const KIND_RE = /^\[([a-z]+)\]\s*(.*)$/s

/**
 * Decide whether a raw kind is one the global profile accepts.
 * @param kind - the caller's classification.
 * @returns whether it is a global kind.
 */
export function isGlobalEntryKind(kind: unknown): kind is GlobalEntryKind {
  return typeof kind === 'string' && (GLOBAL_ENTRY_KINDS as readonly string[]).includes(kind)
}

/**
 * Parse a global memory document.
 *
 * Tolerant by design: a hand-edited file keeps its prose, unknown kinds fall back
 * to `fact` (so they render unchanged), and entries before the first section land
 * in a synthetic default section instead of being dropped.
 * @param source - the document text.
 * @returns the parsed document.
 */
export function parseGlobalMemory(source: unknown): GlobalMemoryDocument {
  const lines = normalizeText(source).split('\n')
  const heads: { at: number, level: number, title: string }[] = []
  lines.forEach((line, at) => {
    const m = HEADING_RE.exec(line)
    if (m !== null) heads.push({ at, level: (m[1] ?? '').length, title: (m[2] ?? '').trim() })
  })
  // The shallowest heading that repeats (or any heading deeper than a lone title)
  // carries sections; a document carrying only its title has no sections yet.
  const level = sectionsLevel(heads)
  const tops = heads.filter((h) => h.level === level)

  const sections: GlobalSection[] = []
  let preamble: string
  if (tops.length === 0) {
    // Title-only document: prose up to the first entry stays the preamble, and the
    // loose entries are adopted into the default section rather than dropped.
    const firstEntry = lines.findIndex((line) => ENTRY_RE.test(line))
    const cut = firstEntry === -1 ? lines.length : firstEntry
    preamble = lines.slice(0, cut).join('\n').trim()
    const loose = collectEntries(lines)
    if (loose.length > 0) sections.push({ title: DEFAULT_GLOBAL_SECTIONS[0], entries: loose })
  } else {
    preamble = lines.slice(0, tops[0]?.at ?? 0).join('\n').trim()
    tops.forEach((head, i) => {
      const end = tops[i + 1]?.at ?? lines.length
      sections.push({ title: head.title, entries: collectEntries(lines.slice(head.at + 1, end)) })
    })
  }
  return { preamble, sections }
}

/** Pick the heading depth that carries sections. */
function sectionsLevel(heads: readonly { readonly level: number, readonly title: string }[]): number {
  if (heads.length === 0) return 0
  // A document that carries only one level-1 heading carries its title, not a section.
  if (heads.length === 1 && heads[0]?.level === 1) return 0
  const min = Math.min(...heads.map((h) => h.level))
  const atMin = heads.filter((h) => h.level === min)
  if (atMin.length <= 1) {
    const deeper = heads.filter((h) => h.level > min)
    if (deeper.length > 0) return Math.min(...deeper.map((h) => h.level))
  }
  return min
}

/** Collect entry bullets from a section body. */
function collectEntries(lines: readonly string[]): GlobalEntry[] {
  const entries: GlobalEntry[] = []
  for (const line of lines) {
    const m = ENTRY_RE.exec(line)
    if (m === null) continue
    const raw = normalizeText(m[1] ?? '')
    if (raw.length === 0) continue
    const kindMatch = KIND_RE.exec(raw)
    const kind = kindMatch !== null && isGlobalEntryKind(kindMatch[1]) ? kindMatch[1] : 'fact'
    const text = normalizeText(kindMatch !== null ? kindMatch[2] ?? '' : raw)
    if (text.length === 0) continue
    entries.push({ kind: kind as GlobalEntryKind, text })
  }
  return entries
}

/**
 * Render a document back to its canonical text.
 *
 * The preamble is preserved verbatim; sections and entries are re-emitted in
 * their current order with one blank line between blocks.
 * @param document - the parsed document.
 * @param title - optional title override for a fresh document.
 * @returns canonical markdown, without a trailing newline.
 */
export function renderGlobalMemory(document: GlobalMemoryDocument, title: string = GLOBAL_MEMORY_TITLE): string {
  const preamble = normalizeText(document.preamble).trim()
  const head = preamble.length > 0 ? preamble : `# ${title}`
  const blocks = document.sections
    .filter((section) => section.entries.length > 0)
    .map((section) => [`## ${section.title}`, '', ...section.entries.map((entry) => `- [${entry.kind}] ${entry.text.replace(/\n/g, '\n  ')}`)].join('\n'))
  return blocks.length > 0 ? `${head}\n\n${blocks.join('\n\n')}` : head
}

/**
 * Create a fresh one-entry document.
 * @param entry - the first entry.
 * @param section - its section title.
 * @returns the canonical document text.
 */
export function createGlobalMemory(entry: GlobalEntryInput, section?: string): string {
  const title = normalizeText(section ?? '').trim() || DEFAULT_GLOBAL_SECTIONS[0]
  return renderGlobalMemory({
    preamble: `# ${GLOBAL_MEMORY_TITLE}`,
    sections: [{ title, entries: [{ kind: entry.kind as GlobalEntryKind, text: normalizeText(entry.text) }] }],
  })
}

/** The result of upserting one entry. */
export interface GlobalUpsert {
  /** The next document text. */
  readonly text: string
  /** Whether the text differs from the input. */
  readonly changed: boolean
  /** Whether the target section had to be created. */
  readonly createdSection: boolean
  /** Entries in the resulting document. */
  readonly count: number
}

/**
 * Insert one entry into a named section.
 *
 * Idempotent for an identical entry (same kind and text) already present in that
 * section, which keeps a repeated `memory_write` from duplicating a line. A
 * missing section is created at the end.
 * @param source - the current document text.
 * @param section - target section title.
 * @param entry - the entry to insert.
 * @returns the next text plus what changed.
 */
export function upsertGlobalEntry(source: unknown, section: string, entry: GlobalEntryInput): GlobalUpsert {
  const text = normalizeText(entry.text)
  if (text.length === 0) throw new Error('global memory entry must not be empty')
  if (!isGlobalEntryKind(entry.kind)) throw new Error(`global memory entry kind must be one of ${GLOBAL_ENTRY_KINDS.join('/')}`)
  const title = normalizeText(section).trim() || DEFAULT_GLOBAL_SECTIONS[0]

  const document = parseGlobalMemory(source)
  const existing = document.sections
    .flatMap((s) => s.entries.map((e) => ({ section: s.title, entry: e })))
    .find((candidate) => candidate.section === title && candidate.entry.kind === entry.kind && candidate.entry.text === text)
  const count = countEntries(document)
  if (existing !== undefined) return { text: normalizeText(source), changed: false, createdSection: false, count }

  const target = document.sections.find((s) => s.title === title)
  const sections = target === undefined
    ? [...document.sections, { title, entries: [{ kind: entry.kind as GlobalEntryKind, text }] }]
    : document.sections.map((s) => (s.title !== title ? s : { ...s, entries: [...s.entries, { kind: entry.kind as GlobalEntryKind, text }] }))
  return {
    text: renderGlobalMemory({ preamble: document.preamble, sections }),
    changed: true,
    createdSection: target === undefined,
    count: count + 1,
  }
}

/**
 * Replace the whole document with a revised version.
 *
 * The caller (a model) owns the merge: read, prune, reword, then submit the
 * complete text. This function only validates the shape and re-emits it
 * canonically, so whitespace churn never rewrites a curation into a diff.
 * @param source - the submitted document text.
 * @param title - optional title override when the submission has no heading.
 * @returns the canonical text.
 */
export function reviseGlobalMemory(source: unknown, title: string = GLOBAL_MEMORY_TITLE): string {
  const document = parseGlobalMemory(source)
  return renderGlobalMemory(document, title)
}

/** Count every entry in a document. */
export function countEntries(document: GlobalMemoryDocument): number {
  return document.sections.reduce((total, section) => total + section.entries.length, 0)
}

/** Flatten a document into `{ section, kind, text }` records. */
export function flattenEntries(document: GlobalMemoryDocument): { readonly section: string, readonly kind: GlobalEntryKind, readonly text: string }[] {
  return document.sections.flatMap((section) => section.entries.map((entry) => ({ section: section.title, kind: entry.kind, text: entry.text })))
}

/** A document's byte size as written (UTF-8, the unit every budget uses). */
export function globalMemoryBytes(text: string): number {
  return Buffer.byteLength(normalizeText(text), 'utf8')
}

/** Validate one entry's text with the shared admission rules and global kind set. */
export interface GlobalEntryCheck {
  /** Whether the entry may be written. */
  readonly allowed: boolean
  /** Hard refusals. */
  readonly reasons: readonly string[]
  /** Advisories the caller may force through. */
  readonly warnings: readonly string[]
  /** The normalized text. */
  readonly text: string
  /** The resolved kind. */
  readonly kind: GlobalEntryKind
}

/**
 * Check one candidate entry for the global profile.
 * @param text - candidate content.
 * @param kind - requested classification.
 * @param evaluate - the shared admission reviewer from `memory.ts`.
 * @returns the check result.
 */
export function checkGlobalEntry(
  text: unknown,
  kind: unknown,
  evaluate: (content: unknown, kind: unknown) => { readonly allowed: boolean, readonly reasons: readonly string[], readonly warnings: readonly string[], readonly body: string },
): GlobalEntryCheck {
  const verdict = evaluate(text, kind)
  const reasons = [...verdict.reasons]
  if (!isGlobalEntryKind(kind)) {
    reasons.push(`全局记忆只接受 ${GLOBAL_ENTRY_KINDS.join('/')} 四类结论；请改用这些分类，或把项目级事实写进工作区记忆`)
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    warnings: verdict.warnings,
    text: verdict.body,
    kind: (isGlobalEntryKind(kind) ? kind : 'preference') as GlobalEntryKind,
  }
}

/** One-line display of a section title, bounded. */
export function sectionTitle(title: string): string {
  return oneLine(normalizeText(title), 40) || DEFAULT_GLOBAL_SECTIONS[0]
}
