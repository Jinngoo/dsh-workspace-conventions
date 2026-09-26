/**
 * A deliberately small YAML frontmatter reader.
 *
 * Both compatibility layers read frontmatter that another tool wrote, so this
 * only needs the subset that tool actually emits: flat `key: scalar` pairs,
 * block lists (`key:` followed by `- item` lines), and inline lists
 * (`key: [a, b]`). Nested maps, anchors, tags and multi-line scalars are not
 * interpreted; a nested map's indented children are skipped instead of guessed
 * at, because silently mis-reading somebody else's rule is worse than ignoring
 * a key this reader does not model.
 *
 * @module @jinngoo/dsh-workspace-conventions/frontmatter
 */

/** One parsed frontmatter value: a scalar or a list of scalars. */
export type FrontmatterValue = string | readonly string[]

/** A parsed frontmatter block plus the body that follows it. */
export interface Frontmatter {
  /** Keys in document order; an empty value means the key was present but blank. */
  readonly data: ReadonlyMap<string, FrontmatterValue>
  /** Everything after the closing delimiter, with LF line endings. */
  readonly body: string
  /** Whether a delimited frontmatter block was present at all. */
  readonly present: boolean
}

const DELIMITER_RE = /^---[ \t]*$/
const KEY_RE = /^([A-Za-z0-9_.-]+)[ \t]*:([\s\S]*)$/
const LIST_ITEM_RE = /^[ \t]+-[ \t]+(.*)$/

/**
 * Split one frontmatter block out of a Markdown document.
 *
 * A document without a leading `---` line, or with an unterminated one, is
 * returned whole as the body: the caller still gets usable content, and a file
 * that a rule author forgot to close does not vanish from discovery.
 * @param source - the raw file text.
 * @returns the parsed keys and the remaining body.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const normalized = String(source ?? '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (!DELIMITER_RE.test((lines[0] ?? '').trim())) {
    return { data: new Map(), body: normalized, present: false }
  }
  let closing = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (DELIMITER_RE.test((lines[i] ?? '').trim())) { closing = i; break }
  }
  if (closing === -1) return { data: new Map(), body: normalized, present: false }

  const data = new Map<string, FrontmatterValue>()
  let pendingListKey: string | undefined
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const item = LIST_ITEM_RE.exec(line)
    if (item !== null) {
      if (pendingListKey === undefined) continue
      const current = data.get(pendingListKey)
      data.set(pendingListKey, Array.isArray(current) ? [...current, unquote(item[1] ?? '')] : [unquote(item[1] ?? '')])
      continue
    }
    // Any other indented line is a nested structure this reader does not model.
    if (/^[ \t]/.test(line)) continue
    const match = KEY_RE.exec(line)
    if (match === null) continue
    const key = match[1] ?? ''
    const raw = (match[2] ?? '').trim()
    if (raw === '') {
      // `key:` may open a block list; a scalar accessor still sees an empty value.
      data.set(key, [])
      pendingListKey = key
      continue
    }
    pendingListKey = undefined
    data.set(key, raw.startsWith('[') && raw.endsWith(']') ? splitInline(raw.slice(1, -1)) : unquote(raw))
  }
  return { data, body: lines.slice(closing + 1).join('\n'), present: true }
}

/**
 * Read one key as a scalar.
 * @param frontmatter - the parsed block.
 * @param key - the exact key.
 * @returns the scalar text, or `undefined` when the key is absent or a list.
 */
export function frontmatterScalar(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter.data.get(key)
  return typeof value === 'string' ? value : undefined
}

/**
 * Read one key as a list of scalars.
 * @param frontmatter - the parsed block.
 * @param key - the exact key.
 * @returns the list, empty when the key is absent, or a one-element list for a scalar.
 */
export function frontmatterList(frontmatter: Frontmatter, key: string): readonly string[] {
  const value = frontmatter.data.get(key)
  if (value === undefined) return []
  if (typeof value === 'string') return value.trim().length > 0 ? [value] : []
  return value.filter((entry) => entry.trim().length > 0)
}

/** The outcome of reading one boolean-valued key. */
export type BooleanRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'value', readonly value: boolean }
  | { readonly kind: 'invalid', readonly raw: string }

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

/**
 * Read one key through the strict boolean grammar shared with the skill format.
 *
 * Absence and a rejected spelling stay distinguishable on purpose. A skill must
 * be dropped when its invocation flag is unreadable rather than quietly keeping
 * a surface; a rule wants the opposite treatment and reports the malformed key
 * instead of disappearing.
 * @param frontmatter - the parsed block.
 * @param key - the exact key.
 * @returns which of the three outcomes applies.
 */
export function readFrontmatterBoolean(frontmatter: Frontmatter, key: string): BooleanRead {
  if (!frontmatter.data.has(key)) return { kind: 'absent' }
  const raw = frontmatterScalar(frontmatter, key)
  if (raw === undefined) return { kind: 'invalid', raw: '' }
  const word = raw.trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return { kind: 'value', value: true }
  if (FALSE_WORDS.has(word)) return { kind: 'value', value: false }
  return { kind: 'invalid', raw }
}

function unquote(raw: string): string {
  const text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith('\'') && text.endsWith('\'')) {
    return text.slice(1, -1).replace(/''/g, '\'')
  }
  return text
}

function splitInline(raw: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  for (const ch of raw) {
    if (quote !== undefined) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === '\'') { quote = ch; current += ch; continue }
    if (ch === ',') { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts.map(unquote).filter((part) => part.length > 0)
}
