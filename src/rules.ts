/**
 * WorkBuddy rule books: discovery, classification, triggers and rendering.
 *
 * WorkBuddy keeps its behavioural rules as Markdown files under
 * `.workbuddy/rules/`, each with a two-key frontmatter contract this module
 * reproduces exactly:
 *
 * | frontmatter | book | when it applies |
 * |---|---|---|
 * | `alwaysApply: true` | 常驻册 | injected on every turn |
 * | `alwaysApply: false` + `paths: [...]` | 条件册 | injected once a matching file is read or changed |
 * | neither | 按需规则 | listed only; the model reads it on demand |
 *
 * A rule book is capped at 16 KB per file, which is WorkBuddy's own stated
 * contract — beyond that its own loader truncates silently, so this layer
 * truncates visibly and names the tool that reads the rest.
 *
 * @module @jinngoo/dsh-workspace-conventions/rules
 */

import { frontmatterList, parseFrontmatter, readFrontmatterBoolean } from './frontmatter.js'
import { firstMatchingGlob } from './glob.js'
import { RULES_SUBDIR, WORKBUDDY_DIR } from './layout.js'
import { byteLength, clipBytes, normalizeText, toPosix } from './text.js'

/** Default per-book byte cap, matching WorkBuddy's own contract. */
export const RULE_FILE_BYTES = 16 * 1024

/** Workspace-relative directory holding rule books, with `/` separators. */
export const RULES_DIR_REL = `${WORKBUDDY_DIR}/${RULES_SUBDIR}`

/** One discovered rule book. */
export interface RuleDefinition {
  /** File name, for example `01-协作红线.md`. */
  readonly file: string
  /** Workspace-relative path with `/` separators. */
  readonly rel: string
  /** First Markdown heading in the body, or the file name when it has none. */
  readonly title: string
  /** Whether the book declares `alwaysApply: true`. */
  readonly alwaysApply: boolean
  /** Authored trigger globs, relative to the workspace root. */
  readonly paths: readonly string[]
  /** Body with the frontmatter block removed. */
  readonly body: string
  /** Body size in UTF-8 bytes. */
  readonly bytes: number
  /** Non-empty when a frontmatter key could not be read; reported, never acted on silently. */
  readonly issue: string
}

/**
 * Parse one rule book.
 * @param file - the file name.
 * @param source - the raw file text.
 * @param dirRel - workspace-relative directory, for the rule's display path.
 * @returns the parsed definition.
 */
export function parseRule(file: string, source: string, dirRel: string = RULES_DIR_REL): RuleDefinition {
  const frontmatter = parseFrontmatter(source)
  const body = normalizeText(frontmatter.body)
  const declared = readFrontmatterBoolean(frontmatter, 'alwaysApply')
  const paths = frontmatterList(frontmatter, 'paths').map((path) => toPosix(path.trim()))
  const issues: string[] = []
  if (declared.kind === 'invalid') issues.push(`alwaysApply 取值无法识别（${declared.raw || '空'}）`)
  return {
    file,
    rel: `${dirRel}/${file}`,
    title: ruleTitle(body, file),
    alwaysApply: declared.kind === 'value' && declared.value,
    paths,
    body,
    bytes: byteLength(body),
    issue: issues.join('；'),
  }
}

/**
 * Classify a book as a 常驻册.
 * @param rule - the rule to classify.
 * @returns whether it is injected on every turn.
 */
export function isAlwaysRule(rule: RuleDefinition): boolean {
  return rule.alwaysApply
}

/**
 * Classify a book as a 条件册.
 * @param rule - the rule to classify.
 * @returns whether it is triggered by its `paths` globs.
 */
export function isConditionalRule(rule: RuleDefinition): boolean {
  return !rule.alwaysApply && rule.paths.length > 0
}

/**
 * Classify a book as an 按需规则.
 * @param rule - the rule to classify.
 * @returns whether it has neither an always flag nor triggers.
 */
export function isOnDemandRule(rule: RuleDefinition): boolean {
  return !rule.alwaysApply && rule.paths.length === 0
}

/**
 * Find the conditional books a touched file triggers.
 * @param rules - every discovered book.
 * @param relPath - the touched path, workspace-relative with `/` separators.
 * @returns the matching conditional books, in discovery order.
 */
export function matchingRules(rules: readonly RuleDefinition[], relPath: string): readonly RuleDefinition[] {
  return rules.filter((rule) => (
    isConditionalRule(rule) && firstMatchingGlob(rule.paths, relPath) !== undefined
  ))
}

/** Everything the rules prompt section needs to render. */
export interface RulesSectionInput {
  /** Workspace-relative rules directory, with `/` separators. */
  readonly dir: string
  /** Every discovered book, sorted by file name. */
  readonly rules: readonly RuleDefinition[]
  /** Paths of the conditional books already triggered in this session. */
  readonly active: ReadonlySet<string>
  /** Per-book byte cap. */
  readonly ruleFileBytes: number
  /** Total byte cap for the whole injected section. */
  readonly maxBytes: number
  /**
   * Banner line for the section. Defaults to the workspace heading; the global
   * rules section passes its own so the model can tell the two scopes apart.
   */
  readonly title?: string
}

/**
 * Render the injected rules section.
 *
 * An empty rules directory renders nothing at all, so a workspace without rule
 * books pays no tokens. Admission is decided against the length of the really
 * assembled string rather than an estimate, because the section is also joined
 * with separators and headed with section banners: an estimated budget that
 * forgot either would let a book be admitted only to be clipped off the end of
 * the section it was admitted to.
 *
 * 常驻册 are all-or-nothing and rank first, so a standing rule is never pushed
 * out by a conditional one. A triggered 条件册 is different: the model just
 * touched a matching file, so it is the most relevant content in the workspace
 * at that moment, and it never vanishes — if it cannot fit whole it degrades to
 * its heading, its trigger, a `rule_read` pointer, and as much of the body as
 * still fits. Every triggered book that cannot even hold a pointer is named in
 * the closing notice instead, so no triggered book is ever left unmentioned.
 * @param input - the books, trigger state and budgets.
 * @returns the model-facing section text, or an empty string.
 */
export function renderRulesSection(input: RulesSectionInput): string {
  const { dir, rules, active, ruleFileBytes, maxBytes, title } = input
  if (rules.length === 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) return ''

  const always = rules.filter(isAlwaysRule)
  const conditional = rules.filter(isConditionalRule)
  const onDemand = rules.filter(isOnDemandRule)
  const fired = conditional.filter((rule) => active.has(rule.rel))
  const pending = conditional.filter((rule) => !active.has(rule.rel))
  /** Books that wanted to be injected, in injection priority order. */
  const wanted = [...always, ...fired]

  const admitted = new Map<string, string>()

  const assemble = (): string => {
    const pick = (list: readonly RuleDefinition[]): string[] =>
      list.map((rule) => admitted.get(rule.rel)).filter((block): block is string => block !== undefined)
    const omitted = wanted.filter((rule) => !admitted.has(rule.rel)).map((rule) => rule.file)
    const parts = [renderHeader(dir, title)]
    const alwaysBlocks = pick(always)
    if (alwaysBlocks.length > 0) parts.push('## 常驻册\n', ...alwaysBlocks)
    const firedBlocks = pick(fired)
    if (firedBlocks.length > 0) parts.push('## 已触发的条件册\n', ...firedBlocks)
    parts.push(renderListings(pending, onDemand))
    if (omitted.length > 0) parts.push(renderOmissionNotice(omitted, maxBytes))
    return parts.join('\n').trimEnd()
  }

  const fits = (reserved = 0): boolean => byteLength(assemble()) + reserved <= maxBytes
  const tryAdmit = (rule: RuleDefinition, block: string): boolean => {
    admitted.set(rule.rel, block)
    if (fits()) return true
    admitted.delete(rule.rel)
    return false
  }

  // Pass one: whole books, in priority order, so a small book is never pushed
  // aside to make room for a fragment of a large one.
  for (const rule of always) tryAdmit(rule, renderRuleBlock(rule, ruleFileBytes))
  for (const rule of fired) tryAdmit(rule, renderRuleBlock(rule, ruleFileBytes, rule.paths.join('、')))

  // Pass two: a triggered book that did not fit whole still gets the largest
  // pointer-fragment it can hold. Each one is measured against the room its
  // later siblings still need for their own bare pointers, so an early large
  // book cannot consume the budget that would let a later one be named at all.
  const unfitted = fired.filter((rule) => !admitted.has(rule.rel))
  const pointerOf = (rule: RuleDefinition): string => renderDegradedRuleBlock(rule, rule.paths.join('、'), 0)
  for (let index = 0; index < unfitted.length; index += 1) {
    const rule = unfitted[index]
    if (rule === undefined) continue
    // `+ 1` per sibling is the join separator its pointer will add.
    const reserved = unfitted.slice(index + 1).reduce((total, later) => total + byteLength(pointerOf(later)) + 1, 0)
    const trigger = rule.paths.join('、')
    admitted.set(rule.rel, pointerOf(rule))
    if (!fits(reserved)) { admitted.delete(rule.rel); continue }
    let low = 0
    let high = ruleFileBytes
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      admitted.set(rule.rel, renderDegradedRuleBlock(rule, trigger, mid))
      if (fits(reserved)) low = mid
      else high = mid - 1
    }
    admitted.set(rule.rel, renderDegradedRuleBlock(rule, trigger, low))
  }

  // The hard cap stays as a last-resort guarantee even though admission is now
  // measured: a header alone can exceed a pathologically small budget.
  return clipBytes(assemble(), maxBytes).text
}

/**
 * Render a triggered book that does not fit as a pointer instead of dropping it.
 *
 * The heading and its trigger survive with as much of the body as the caller
 * allows — possibly none — plus an explicit note that the body is incomplete. A
 * model that sees "this book exists, it fired because you touched a
 * `server/**\/*.cs` file, read it with `rule_read`" can recover the rule; a book
 * that vanished into a one-line summary cannot.
 * @param rule - the triggered book.
 * @param trigger - the glob that fired it.
 * @param bodyRoom - byte allowance for the body; zero yields the bare pointer.
 * @returns the degraded block.
 */
function renderDegradedRuleBlock(rule: RuleDefinition, trigger: string, bodyRoom: number): string {
  const head = `### ${rule.file}（触发：${trigger}）\n\n`
    + `> 本册正文超出本轮注入预算；以下为截断内容，完整正文用 rule_read 读 ${rule.file}。\n\n`
  const tail = '\n\n…（已截断）\n'
  return `${head}${clipBytes(rule.body, bodyRoom).text}${tail}`
}

function renderOmissionNotice(files: readonly string[], maxBytes: number): string {
  if (files.length === 0) return ''
  return `> 注入预算（${String(maxBytes)} 字节）已满，以下册本轮未注入正文，需要时用 rule_read 直接读：${files.join('、')}\n`
}

/**
 * Read the first Markdown heading as a book's display title.
 * @param body - the book body without frontmatter.
 * @param fallback - the file name to fall back to.
 * @returns the title text.
 */
export function ruleTitle(body: string, fallback: string): string {
  for (const line of body.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match !== null) return (match[1] ?? '').trim()
    if (line.trim() !== '') break
  }
  return fallback.replace(/\.md$/i, '')
}

function renderHeader(dir: string, title: string | undefined): string {
  return [
    title ?? `# 工作区规则（${toPosix(dir)}/）`,
    '',
    '这些册子由本插件按 WorkBuddy 原生语义自动注入：常驻册每轮都在；条件册在你读或改匹配文件后自动生效。',
    '会话中修改 rules 文件不会重载，下一次会话才生效。',
    '',
  ].join('\n')
}

function renderRuleBlock(rule: RuleDefinition, ruleFileBytes: number, trigger?: string): string {
  const clipped = clipBytes(rule.body, ruleFileBytes)
  const heading = trigger === undefined ? `### ${rule.file}` : `### ${rule.file}（触发：${trigger}）`
  const lines = [heading, '']
  if (rule.title.length > 0 && rule.title !== rule.file) lines.push(`> ${rule.title}`, '')
  lines.push(clipped.truncated
    ? `${clipped.text}\n\n…（单册超过 ${String(ruleFileBytes)} 字节上限，已截断；完整内容用 rule_read 读 ${rule.file}）`
    : clipped.text)
  return `${lines.join('\n')}\n`
}

function renderListings(pending: readonly RuleDefinition[], onDemand: readonly RuleDefinition[]): string {
  const parts: string[] = []
  if (pending.length > 0) {
    // Named for the complement of `已触发的条件册` above: this lists what has NOT
    // fired, so a bare "条件册" heading would read as the whole set.
    parts.push('## 尚未触发的条件册（读写匹配文件后自动注入）\n')
    for (const rule of pending) parts.push(`- \`${rule.file}\` ← ${rule.paths.join('、')}`)
    parts.push('')
  }
  if (onDemand.length > 0) {
    parts.push('## 按需规则（无 alwaysApply / paths，需要时用 rule_read 读）\n')
    for (const rule of onDemand) parts.push(`- \`${rule.file}\``)
    parts.push('')
  }
  const issues = [...pending, ...onDemand].filter((rule) => rule.issue.length > 0)
  if (issues.length > 0) {
    parts.push('> frontmatter 存在无法识别的取值：')
    for (const rule of issues) parts.push(`> - \`${rule.file}\`：${rule.issue}`)
    parts.push('')
  }
  return parts.join('\n')
}
