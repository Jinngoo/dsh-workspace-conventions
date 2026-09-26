/**
 * A restricted reader for Cordis patch files, used by the offline verifiers.
 *
 * This is **not** a YAML implementation. It reads the narrow slice of YAML that
 * a Cordis patch can contain — block maps, block sequences, comments, and quoted
 * or plain scalars — and refuses anything outside that slice with a message
 * naming the line. Refusing is the point: this module exists so a verifier can
 * compare the row's *effective* configuration against what the profile intends,
 * and a reader that silently mangled an unfamiliar construct would report a
 * false pass, which is exactly the failure it is meant to catch.
 *
 * Three details of the real dialect shape the reader:
 *
 * - A patch file is itself a list of patch rows. `insert` is a *field* on such a
 *   row — written `- insert:` in this repository's own patch — so the rows to
 *   resolve sit one level down.
 * - Indentation is read from the content rather than assumed: each block starts
 *   at the indentation of its own first line, which is why this repository's
 *   four-space `insert` block and the profile's two-space row bodies both read.
 * - A sequence item may be a scalar (`- a/*.ts`), a mapping (`-` then indented
 *   keys), or a key with its mapping nested below (`- id: row`).
 *
 * Only the verifiers use this. The plugin itself never reads a patch file: DSH
 * resolves the layer stack and hands the row its resolved `config`.
 *
 * @module @jinngoo/dsh-workspace-conventions/patch
 */

import { join } from 'node:path'

/** A scalar a patch file can carry. `null` is how a bare `key:` reads. */
export type PatchScalar = string | number | boolean | null

/** A parsed patch value: a scalar, an ordered list, or a block map. */
export type PatchValue = PatchScalar | readonly PatchValue[] | PatchMap

/** A block map, keyed in file order. */
export interface PatchMap {
  readonly [key: string]: PatchValue
}

/** One patch row: the `id` that addresses it, plus every key it carries. */
export interface PatchRow {
  /** The row's addressing key, or `undefined` when it has none. */
  readonly id: string | undefined
  /** The row's module specifier, when it declares one. */
  readonly name: string | undefined
  /** The row's own configuration block, when it declares one. */
  readonly config: PatchMap | undefined
  /** Every key of the row, including the three above. */
  readonly keys: PatchMap
}

/** A parsed patch file: the rows it contributes and where it was read from. */
export interface PatchDocument {
  /** Rows the file inserts, with any `insert` wrapper unwrapped, in file order. */
  readonly insert: readonly PatchRow[]
  /** Rows stated directly at the file's top level, in file order. */
  readonly topLevel: readonly PatchRow[]
  /** The file path used in diagnostics. */
  readonly source: string
}

/** Raised when a patch file leaves the reader's supported YAML slice. */
export class PatchFormatError extends Error {
  /** The 1-based line that broke the reader. */
  readonly line: number

  /**
   * @param line - the 1-based offending line.
   * @param detail - what the reader could not handle.
   */
  constructor(line: number, detail: string) {
    super(`line ${line}: ${detail}`)
    this.line = line
    this.name = 'PatchFormatError'
  }
}

interface Line {
  readonly number: number
  readonly indent: number
  readonly content: string
}

interface Block<T> {
  readonly value: T
  readonly next: number
}

/**
 * Read a patch file's contents into the rows it contributes.
 * @param text - the patch file contents.
 * @param source - the path reported in diagnostics.
 * @returns the inserted rows, unwrapped, and any rows stated at the top level.
 */
export function parsePatch(text: string, source: string): PatchDocument {
  const lines = toLines(text, source)
  const insert: PatchRow[] = []
  const topLevel: PatchRow[] = []

  for (const entry of parseRows(lines, 0, lines.length)) {
    const wrapped = entry.row.keys['insert']
    if (wrapped !== undefined && entry.row.id === undefined) {
      for (const parsed of asRows(wrapped, 'insert')) insert.push(parsed)
      continue
    }

    // A top-level row must carry something the loader can act on: an `id` to
    // address an existing row, or an `insert` to contribute new ones. A row with
    // neither is warned about and skipped at load time, so reading past it would
    // let a typo such as `inject:` pass the verifier unnoticed.
    if (entry.row.id === undefined) {
      throw new PatchFormatError(entry.line, 'a top-level row must declare an `id` or an `insert`')
    }
    topLevel.push(entry.row)
  }

  return { insert, topLevel, source }
}

/**
 * Read a patch file from disk.
 * @param path - the patch file path.
 * @returns the parsed document.
 */
export async function readPatchFile(path: string): Promise<PatchDocument> {
  const { readFile } = await import('node:fs/promises')
  return parsePatch(await readFile(path, 'utf8'), path)
}

/**
 * Collect every row of a document that carries one `id`, in file order.
 * @param document - the parsed patch.
 * @param id - the row id to collect.
 * @returns one row per match, in the order the file states them.
 */
export function findRows(document: PatchDocument, id: string): PatchRow[] {
  return [...document.insert, ...document.topLevel].filter((row) => row.id === id)
}

/**
 * The outcome of layering a profile's patches over a bundle's defaults.
 *
 * An id-targeted patch replaces the whole `config` block rather than merging
 * into it, so every field the row still wants must be restated by the patch.
 */
export interface EffectiveRow {
  /** The row id that was resolved. */
  readonly id: string
  /** The bundle's baseline config, or `undefined` when it states none. */
  readonly baseline: PatchMap | undefined
  /** Every profile patch that addressed this row, in the order it was applied. */
  readonly applied: readonly { readonly source: string; readonly config: PatchMap | undefined }[]
  /** The config DSH would hand the row: the last applied patch, else the baseline. */
  readonly effective: PatchMap | undefined
  /** Whether any profile patch addressed this row at all. */
  readonly overridden: boolean
}

/**
 * Resolve the config a row ends up with once a profile's patches are applied.
 *
 * This mirrors the loader's two steps — take the bundle's inserted row as the
 * baseline, then let an id-targeted patch replace its `config` wholesale — and
 * it exists to detect the case where the two *fail* to line up: a profile patch
 * whose `id` no longer matches silently leaves the baseline in place.
 * @param bundle - the bundle's own patch.
 * @param profilePatches - the profile's patches, in layer order.
 * @param id - the row id to resolve.
 * @returns the baseline, the patches that applied, and the effective config.
 */
export function resolveRow(
  bundle: PatchDocument,
  profilePatches: readonly PatchDocument[],
  id: string,
): EffectiveRow {
  const baselines = findRows(bundle, id)
  if (baselines.length === 0) {
    throw new Error(`${bundle.source} inserts no row with id \`${id}\``)
  }
  if (baselines.length > 1) {
    throw new Error(`${bundle.source} inserts ${baselines.length} rows with id \`${id}\`; an id must address exactly one row`)
  }

  const baseline = baselines[0] as PatchRow
  const applied: { source: string; config: PatchMap | undefined }[] = []
  for (const document of profilePatches) {
    for (const row of findRows(document, id)) applied.push({ source: document.source, config: row.config })
  }

  const last = applied[applied.length - 1]
  return {
    id,
    baseline: baseline.config,
    applied,
    effective: last === undefined ? baseline.config : last.config,
    overridden: applied.length > 0,
  }
}

/**
 * The directory a DSH profile lives in, from the environment DSH exports.
 * @param env - the environment to read; defaults to `process.env`.
 * @returns the profile directory, or `undefined` when it cannot be determined.
 */
export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env['DSH_PROFILE_DIR']
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()

  const home = env['DSH_HOME']
  if (home === undefined || home.trim() === '') return undefined

  const profile = env['DSH_PROFILE']
  const name = profile === undefined || profile.trim() === '' ? 'web' : profile.trim()
  return join(home.trim(), 'profiles', name)
}

/** Read the patch rows of the file: `- ` items, or bare `key:` mappings. */
function parseRows(lines: readonly Line[], start: number, end: number): { row: PatchRow; line: number }[] {
  const rows: { row: PatchRow; line: number }[] = []
  let at = start
  let useItems = true

  while (at < end) {
    const line = lines[at] as Line

    if (!isSequenceItem(line)) {
      useItems = false
      const pair = parsePair(line, lines, 0)
      const child = pair.childIndent

      if (child === undefined) {
        rows.push({ row: bare(pair.key, pair.value ?? null), line: line.number })
        at += 1
        continue
      }

      const run = parseNested(lines, at + 1, end, child, lines[at + 1] as Line)
      rows.push({ row: bare(pair.key, run.value), line: line.number })
      at = run.next
      continue
    }

    if (!useItems) throw new PatchFormatError(line.number, 'a `- ` item cannot follow a mapping entry at the same level')
    const item = parseItem(lines, at, end)
    if (!isMap(item.value)) throw new PatchFormatError(line.number, 'a patch row must be a mapping')
    rows.push({ row: toRow(item.value, line.number), line: line.number })
    at = item.next
  }

  return rows
}

/** Read a nested block, choosing the shape the first line itself declares. */
function parseNested(lines: readonly Line[], start: number, end: number, indent: number, first: Line): Block<PatchValue> {
  if (first.indent !== indent) {
    throw new PatchFormatError(first.number, `expected indentation ${indent} but found ${first.indent}`)
  }

  return isSequenceItem(first) ? parseSequence(lines, start, end, indent) : parseMap(lines, start, end, indent)
}

/**
 * Read one `- ` item and whatever is written beneath its marker.
 *
 * An item is either a scalar (`- a/*.ts`), a mapping written under a bare marker
 * (`-`, then indented keys), or a key written on the marker line with the rest
 * of its mapping nested below (`- id: row`, then indented keys).
 */
function parseItem(lines: readonly Line[], index: number, end: number): { value: PatchValue; next: number } {
  const line = lines[index] as Line
  const inline = line.content === '-' ? '' : line.content.slice(2)
  const at = index + 1

  if (inline === '') {
    const block = lines[at]
    if (block === undefined || block.indent <= line.indent || at >= end) {
      throw new PatchFormatError(line.number, 'a sequence item has no block map')
    }

    const run = parseNested(lines, at, end, block.indent, block)
    return { value: run.value, next: run.next }
  }

  if (findSeparator(inline) === -1) return { value: parseScalar(inline, line.number), next: at }

  // A key written on the marker line belongs to the item body, which is indented
  // past the marker; that body indent is what distinguishes its child from its
  // next sibling key.
  const body = lines[at]
  const bodyIndent = body !== undefined && body.indent > line.indent ? body.indent : line.indent
  return parseItemBody(lines, at, end, line, inline, bodyIndent)
}

/**
 * Read everything belonging to one `- key: ...` item.
 *
 * A key written on the marker line with no value of its own is ambiguous from
 * its indentation alone: a deeper `- ` line is *that key's* block sequence
 * (`- insert:` is the real spelling in this repository's patch), while a deeper
 * `key:` line is simply the item's next key. The next line's shape decides.
 */
function parseItemBody(
  lines: readonly Line[],
  start: number,
  end: number,
  marker: Line,
  inline: string,
  bodyIndent: number,
): Block<{ [key: string]: PatchValue }> {
  const keys: { [key: string]: PatchValue } = {}
  const first = parsePair({ number: marker.number, indent: bodyIndent, content: inline }, lines, bodyIndent)
  let at = start

  if (first.childIndent !== undefined) {
    const run = parseNested(lines, at, end, first.childIndent, lines[at] as Line)
    Reflect.set(keys, first.key, run.value)
    at = run.next
  } else if (first.value !== undefined) {
    Reflect.set(keys, first.key, first.value)
  } else {
    const block = lines[at]
    if (block !== undefined && block.indent > marker.indent && isSequenceItem(block)) {
      const run = parseNested(lines, at, end, block.indent, block)
      Reflect.set(keys, first.key, run.value)
      at = run.next
    } else {
      Reflect.set(keys, first.key, null)
    }
  }

  // The item's remaining keys sit deeper than its marker, but never as deep as
  // the content of a child block: a `- ` line here belongs to that child.
  while (at < end) {
    const current = lines[at] as Line
    if (current.indent <= marker.indent || isSequenceItem(current)) break

    const entry = parsePair(current, lines, bodyIndent)
    if (Object.hasOwn(keys, entry.key)) throw new PatchFormatError(current.number, `duplicate key \`${entry.key}\``)
    Reflect.set(keys, entry.key, entry.value === undefined ? null : entry.value)

    if (entry.childIndent !== undefined) {
      const run = parseNested(lines, at + 1, end, entry.childIndent, lines[at + 1] as Line)
      Reflect.set(keys, entry.key, run.value)
      at = run.next
      continue
    }
    at += 1
  }

  return { value: keys, next: at }
}

function parseMap(lines: readonly Line[], start: number, end: number, indent: number): Block<PatchMap> {
  const value: { [key: string]: PatchValue } = {}
  let at = start

  while (at < end) {
    const line = lines[at] as Line
    if (line.indent < indent) break
    if (line.indent > indent) throw new PatchFormatError(line.number, `unexpected indentation of ${line.indent} inside a map`)
    if (isSequenceItem(line)) break

    const pair = parsePair(line, lines, indent)
    if (Object.hasOwn(value, pair.key)) throw new PatchFormatError(line.number, `duplicate key \`${pair.key}\``)
    Reflect.set(value, pair.key, pair.value === undefined ? null : pair.value)

    if (pair.childIndent === undefined) {
      at += 1
      continue
    }

    const run = parseNested(lines, at + 1, end, pair.childIndent, lines[at + 1] as Line)
    Reflect.set(value, pair.key, run.value)
    at = run.next
  }

  return { value, next: at }
}

function parseSequence(lines: readonly Line[], start: number, end: number, indent: number): Block<PatchValue[]> {
  const value: PatchValue[] = []
  let at = start

  while (at < end) {
    const line = lines[at] as Line
    if (line.indent < indent) break
    if (line.indent > indent) throw new PatchFormatError(line.number, `unexpected indentation of ${line.indent} inside a sequence`)
    if (!isSequenceItem(line)) throw new PatchFormatError(line.number, 'expected a sequence item starting with `- `')

    const item = parseItem(lines, at, end)
    value.push(item.value)
    at = item.next
  }

  return { value, next: at }
}

interface Pair {
  readonly line: number
  readonly key: string
  readonly value: PatchScalar | undefined
  /** Indentation of this key's nested block, or `undefined` when it has none. */
  readonly childIndent: number | undefined
}

/**
 * Split one `key: value` line and decide whether a nested block follows it.
 *
 * A key takes a nested block when the next line is deeper than the key itself:
 * for a key in a mapping that is the mapping's own indent, and for a key on a
 * `- ` marker line it is the item body's indent. With an inline value there is
 * nothing left to nest, so a deeper `- ` line belongs to another item.
 */
function parsePair(line: Line, lines: readonly Line[], indent: number | undefined): Pair {
  assertSupported(line.content, line.number)

  const at = findSeparator(line.content)
  const rawKey = at === -1 ? line.content.trim() : line.content.slice(0, at).trim()
  if (rawKey === '') throw new PatchFormatError(line.number, `expected \`key: value\` but found \`${line.content}\``)
  const key = unquote(rawKey, line.number)

  const rest = at === -1 ? '' : line.content.slice(at + 1).trim()
  const next = lines[nextIndex(lines, line.number)]
  const bodyIndent = indent ?? line.indent
  const deeper = next !== undefined && next.indent > bodyIndent

  if (rest !== '') {
    const nested = deeper && !isSequenceItem(next as Line)
    return { line: line.number, key, value: parseScalar(rest, line.number), childIndent: nested ? (next as Line).indent : undefined }
  }

  return { line: line.number, key, value: undefined, childIndent: deeper ? (next as Line).indent : undefined }
}

/** The index in `lines` of the line that follows the one numbered `number`. */
function nextIndex(lines: readonly Line[], number: number): number {
  let low = 0
  let high = lines.length

  while (low < high) {
    const mid = (low + high) >> 1
    if ((lines[mid] as Line).number <= number) low = mid + 1
    else high = mid
  }

  return low
}

/** Confirm a nested value took the shape a row field must have. */
function asRows(value: PatchValue, key: string): PatchRow[] {
  if (!Array.isArray(value)) throw new Error(`\`${key}\` must be a sequence of rows`)

  return value.map((entry) => {
    if (!isMap(entry)) throw new Error(`\`${key}\` holds an entry that is not a row`)

    const id = entry['id']
    const name = entry['name']
    const config = entry['config']
    if (id !== undefined && typeof id !== 'string') throw new Error(`\`${key}\` holds a row whose id is not a string`)
    if (name !== undefined && typeof name !== 'string') throw new Error(`\`${key}\` holds a row whose name is not a string`)
    if (config !== undefined && !isMap(config)) throw new Error(`\`${key}\` holds a row whose config is not a map`)

    return { id: id as string | undefined, name: name as string | undefined, config: config as PatchMap | undefined, keys: entry }
  })
}

function toRow(keys: PatchMap, line: number): PatchRow {
  const id = keys['id']
  const name = keys['name']
  const config = keys['config']

  if (id !== undefined && typeof id !== 'string') throw new PatchFormatError(line, 'row `id` must be a string')
  if (name !== undefined && typeof name !== 'string') throw new PatchFormatError(line, 'row `name` must be a string')
  if (config !== undefined && !isMap(config)) throw new PatchFormatError(line, 'row `config` must be a block map')

  return {
    id: id as string | undefined,
    name: name as string | undefined,
    config: config as PatchMap | undefined,
    keys,
  }
}

/** A row that states no `id`, `name`, or `config` of its own. */
function bare(key: string, value: PatchValue): PatchRow {
  return { id: undefined, name: undefined, config: undefined, keys: mapOf(key, value) }
}

function mapOf(key: string, value: PatchValue): { [key: string]: PatchValue } {
  const map: { [key: string]: PatchValue } = {}
  Reflect.set(map, key, value)
  return map
}

function toLines(text: string, source: string): Line[] {
  const lines: Line[] = []
  const raw = text.split(/\r?\n/)

  for (let i = 0; i < raw.length; i += 1) {
    const stripped = (raw[i] ?? '').replace(/\s+$/, '')
    const content = stripped.trimStart()
    if (content === '' || content.startsWith('#')) continue

    if (stripped.includes('\t')) {
      throw new PatchFormatError(i + 1, `tabs are not supported as indentation (${source}: ${JSON.stringify(stripped)})`)
    }
    lines.push({ number: i + 1, indent: stripped.length - content.length, content })
  }

  return lines
}

/** Split on the first `:` that sits outside quotes, so a URL in a value survives. */
function findSeparator(content: string): number {
  let quote: string | undefined

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i] as string
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ':') return i
  }

  return -1
}

function parseScalar(raw: string, line: number): PatchScalar {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const first = trimmed[0] as string
  if (first === '|' || first === '>') throw new PatchFormatError(line, 'block scalars (`|`, `>`) are not supported')
  if (first === '&' || first === '*') throw new PatchFormatError(line, `anchors and aliases are not supported (\`${trimmed}\`)`)
  if (trimmed.startsWith('!!')) throw new PatchFormatError(line, 'tags are not supported')
  if (first === '{' || first === '[') {
    throw new PatchFormatError(line, `flow-style collections are not supported (\`${trimmed}\`)`)
  }

  const unquoted = unquote(trimmed, line)
  if (unquoted !== trimmed) return unquoted

  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return trimmed
}

function unquote(value: string, line: number): string {
  const first = value[0]
  if (first !== '"' && first !== "'") return value

  if (value.length < 2 || value[value.length - 1] !== first) {
    throw new PatchFormatError(line, `unterminated ${first === "'" ? 'single' : 'double'}-quoted scalar`)
  }

  const inner = value.slice(1, -1)
  return first === "'" ? inner.split("''").join("'") : inner.split('\\"').join('"')
}

function assertSupported(content: string, line: number): void {
  if (content.startsWith('|') || content.startsWith('>')) throw new PatchFormatError(line, 'block scalars (`|`, `>`) are not supported')
  if (content.startsWith('&') || content.startsWith('*')) throw new PatchFormatError(line, 'anchors and aliases are not supported')
  if (content.startsWith('!!')) throw new PatchFormatError(line, 'tags are not supported')
}

function isSequenceItem(line: Line): boolean {
  return line.content === '-' || line.content.startsWith('- ')
}

function isMap(value: PatchValue): value is PatchMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}