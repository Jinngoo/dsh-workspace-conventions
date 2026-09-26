import { describe, expect, it } from 'vitest'

import { RULES_DIR_REL, isAlwaysRule, isConditionalRule, isOnDemandRule, matchingRules, parseRule, renderRulesSection } from '../src/rules.ts'

const ALWAYS = '---\nalwaysApply: true\n---\n\n# 协作红线\n\n禁止无证据猜测根因。\n'
const SERVER = '---\nalwaysApply: false\npaths:\n  - "server/**/*.cs"\n---\n\n# 服务端铁律\n\n改动任何 .cs 前必读。\n'
const CODES = '---\nalwaysApply: false\npaths:\n  - "**/*ErrCode*.{cs,ts}"\n---\n\n# 错误码约定\n\n错误码核心判据。\n'

describe('classification', () => {
  it('reads an always book', () => {
    const rule = parseRule('01-协作红线.md', ALWAYS)
    expect(isAlwaysRule(rule)).toBe(true)
    expect(isConditionalRule(rule)).toBe(false)
    expect(rule.title).toBe('协作红线')
  })

  it('reads a conditional book and its triggers', () => {
    const rule = parseRule('10-服务端铁律.md', SERVER)
    expect(isConditionalRule(rule)).toBe(true)
    expect(rule.paths).toEqual(['server/**/*.cs'])
    expect(rule.rel).toBe(`${RULES_DIR_REL}/10-服务端铁律.md`)
  })

  it('treats a book with neither key as on-demand', () => {
    const rule = parseRule('99-x.md', '---\nnote: x\n---\n\n# X\n')
    expect(isOnDemandRule(rule)).toBe(true)
  })

  it('reports an unreadable alwaysApply instead of silently dropping the book', () => {
    const rule = parseRule('01-协作红线.md', '---\nalwaysApply: maybe\n---\n\n# 协作红线\n')
    expect(isAlwaysRule(rule)).toBe(false)
    expect(rule.issue).toContain('alwaysApply')
    expect(rule.body).toContain('协作红线')
  })

  it('falls back to the file name when the body has no heading', () => {
    expect(parseRule('77-plain.md', '只讲一句话，没有任何标题。').title).toBe('77-plain')
  })
})

describe('trigger matching', () => {
  const rules = [parseRule('01-协作红线.md', ALWAYS), parseRule('10-服务端铁律.md', SERVER), parseRule('12-错误码约定.md', CODES)]

  it('never triggers an always book', () => {
    expect(matchingRules(rules, 'server/A.cs').map((r) => r.file)).toEqual(['10-服务端铁律.md'])
  })

  it('triggers every book whose own glob matches, in discovery order', () => {
    expect(matchingRules(rules, 'server/BagErrCode.cs').map((r) => r.file))
      .toEqual(['10-服务端铁律.md', '12-错误码约定.md'])
  })

  it('triggers the error-code book from a deep path', () => {
    expect(matchingRules(rules, 'client/X/Y/BagErrCode.ts').map((r) => r.file)).toEqual(['12-错误码约定.md'])
  })

  it('triggers nothing for an unrelated file', () => {
    expect(matchingRules(rules, 'docs/readme.md')).toEqual([])
  })
})

describe('section rendering', () => {
  const rules = [parseRule('01-协作红线.md', ALWAYS), parseRule('10-服务端铁律.md', SERVER), parseRule('12-错误码约定.md', CODES)]

  const render = (active: readonly string[], extra: Partial<Parameters<typeof renderRulesSection>[0]> = {}): string =>
    renderRulesSection({
      dir: RULES_DIR_REL,
      rules,
      active: new Set(active),
      ruleFileBytes: 16 * 1024,
      maxBytes: 32 * 1024,
      ...extra,
    })

  it('renders nothing at all when the workspace has no rule books', () => {
    expect(renderRulesSection({
      dir: RULES_DIR_REL,
      rules: [],
      active: new Set(),
      ruleFileBytes: 16 * 1024,
      maxBytes: 32 * 1024,
    })).toBe('')
  })

  it('injects every always book and lists the conditional ones', () => {
    const text = render([])
    expect(text).toContain('禁止无证据猜测根因。')
    expect(text).toContain('## 尚未触发的条件册（读写匹配文件后自动注入）')
    expect(text).toContain('`10-服务端铁律.md` ← server/**/*.cs')
    expect(text).not.toContain('改动任何 .cs 前必读。')
  })

  it('adds a book once it is triggered, with the trigger that fired it', () => {
    const text = render([`${RULES_DIR_REL}/10-服务端铁律.md`])
    expect(text).toContain('## 已触发的条件册')
    expect(text).toContain('### 10-服务端铁律.md（触发：server/**/*.cs）')
    expect(text).toContain('改动任何 .cs 前必读。')
    expect(text).not.toContain('`10-服务端铁律.md` ←')
  })

  it('truncates one oversized book and names the tool that reads the rest', () => {
    const huge = parseRule('01-x.md', `---\nalwaysApply: true\n---\n\n# X\n\n${'A'.repeat(5000)}`)
    const text = renderRulesSection({
      dir: RULES_DIR_REL,
      rules: [huge],
      active: new Set(),
      ruleFileBytes: 1000,
      maxBytes: 32 * 1024,
    })
    expect(text).toContain('单册超过 1000 字节上限')
    expect(text).toContain('rule_read 读 01-x.md')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(32 * 1024)
  })

  it('keeps the trigger listings and says what it dropped when books do not fit', () => {
    const huge = parseRule('01-x.md', `---\nalwaysApply: true\n---\n\n# X\n\n${'A'.repeat(4000)}`)
    const text = renderRulesSection({
      dir: RULES_DIR_REL,
      rules: [huge, ...rules],
      active: new Set(),
      ruleFileBytes: 16 * 1024,
      maxBytes: 1200,
    })
    expect(text).toContain('注入预算（1200 字节）已满')
    expect(text).toContain('rule_read 直接读：01-x.md')
    expect(text).toContain('`12-错误码约定.md` ←')
    expect(text).toContain('禁止无证据猜测根因。')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1200)
  })

  it('never exceeds the whole-section budget', () => {
    const huge = parseRule('01-x.md', `---\nalwaysApply: true\n---\n\n# X\n\n${'A'.repeat(50_000)}`)
    const text = renderRulesSection({
      dir: RULES_DIR_REL,
      rules: [huge, ...rules],
      active: new Set([`${RULES_DIR_REL}/10-服务端铁律.md`]),
      ruleFileBytes: 16 * 1024,
      maxBytes: 4096,
    })
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096)
  })

  it('stays within a budget too small even for its own header', () => {
    const text = render([], { maxBytes: 120 })
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(120)
  })
})

// Regression: a triggered 条件册 that did not fit used to vanish entirely — it
// left the pending listing, gained no heading, and survived only as a name in a
// one-line summary. The model then had no in-context reason to call rule_read.
describe('a triggered book that does not fit is never dropped', () => {
  const bigServer = parseRule('10-x.md', `---\nalwaysApply: false\npaths:\n  - "server/**/*.cs"\n---\n\n# 大册\n\n${'B'.repeat(20_000)}`)
  const bigClient = parseRule('11-x.md', `---\nalwaysApply: false\npaths:\n  - "client/**/*.ts"\n---\n\n# 另一大册\n\n${'C'.repeat(20_000)}`)

  const render = (active: readonly string[], maxBytes: number): string =>
    renderRulesSection({
      dir: RULES_DIR_REL,
      rules: [bigServer, bigClient],
      active: new Set(active),
      ruleFileBytes: 16 * 1024,
      maxBytes,
    })

  it('keeps the heading, the trigger and a rule_read pointer', () => {
    const text = render([bigServer.rel, bigClient.rel], 4096)
    expect(text).toContain('## 已触发的条件册')
    expect(text).toContain('### 10-x.md（触发：server/**/*.cs）')
    expect(text).toContain('### 11-x.md（触发：client/**/*.ts）')
    expect(text).toContain('本册正文超出本轮注入预算')
    expect(text).toContain('完整正文用 rule_read 读')
    expect(text).toContain('…（已截断）')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096)
  })

  it('names every triggered book somewhere, at any budget', () => {
    for (const maxBytes of [700, 1000, 1500, 3000, 4096, 9000, 40_000]) {
      const text = render([bigServer.rel, bigClient.rel], maxBytes)
      for (const rule of [bigServer, bigClient]) {
        expect(text.includes(rule.file), `budget ${maxBytes} lost ${rule.file}`).toBe(true)
      }
      expect(Buffer.byteLength(text, 'utf8'), `budget ${maxBytes}`).toBeLessThanOrEqual(maxBytes)
    }
  })

  it('admits every fitting book whole before fragmenting any of them', () => {
    const small = parseRule('12-x.md', '---\nalwaysApply: false\npaths:\n  - "**/*ErrCode*.cs"\n---\n\n# 小册\n\n很短的一册正文。\n')
    const text = renderRulesSection({
      dir: RULES_DIR_REL,
      rules: [bigServer, small],
      active: new Set([bigServer.rel, small.rel]),
      ruleFileBytes: 16 * 1024,
      maxBytes: 3000,
    })
    // The small book survives whole instead of being squeezed out by the large one.
    expect(text).toContain('### 12-x.md（触发：**/*ErrCode*.cs）')
    const afterSmall = text.slice(text.indexOf('### 12-x.md'))
    expect(afterSmall).toContain('很短的一册正文。')
    expect(afterSmall).not.toContain('已截断')
    // The large one degrades to a pointer rather than disappearing.
    expect(text).toContain('### 10-x.md（触发：server/**/*.cs）')
    expect(text).toContain('本册正文超出本轮注入预算')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(3000)
  })
})
