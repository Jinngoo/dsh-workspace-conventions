/**
 * The global long-lived memory model.
 *
 * The global scope is one curated document (sections + entries), not a dated
 * ledger. These tests pin the two properties that matter: a write is idempotent
 * and lands in a named section, and `revise` re-emits a curated submission
 * canonically so merging/pruning does not churn whitespace.
 */

import { describe, expect, it } from 'vitest'

import { evaluateEntry } from '../src/memory.ts'
import {
  DEFAULT_GLOBAL_SECTIONS,
  GLOBAL_MEMORY_FILE,
  GLOBAL_MEMORY_TITLE,
  checkGlobalEntry,
  countEntries,
  flattenEntries,
  globalMemoryBytes,
  isGlobalEntryKind,
  parseGlobalMemory,
  renderGlobalMemory,
  reviseGlobalMemory,
  sectionTitle,
  upsertGlobalEntry,
} from '../src/global-memory.ts'

const SAMPLE = `# 全局记忆

## 关于用户

- [preference] 用户偏好中文交流。
- [constraint] 不要用英文缩写解释中文概念。

## 偏好与习惯

- [preference] 回答先给结论，再给依据。
`

describe('parseGlobalMemory', () => {
  it('parses sections and kinds from a canonical document', () => {
    const doc = parseGlobalMemory(SAMPLE)
    expect(doc.preamble).toBe(`# ${GLOBAL_MEMORY_TITLE}`)
    expect(doc.sections.map((s) => s.title)).toEqual(['关于用户', '偏好与习惯'])
    expect(doc.sections[0]?.entries).toEqual([
      { kind: 'preference', text: '用户偏好中文交流。' },
      { kind: 'constraint', text: '不要用英文缩写解释中文概念。' },
    ])
    expect(countEntries(doc)).toBe(3)
    expect(flattenEntries(doc).map((e) => e.kind)).toContain('constraint')
  })

  it('keeps an unknown kind readable instead of dropping the entry', () => {
    const doc = parseGlobalMemory('## 关于用户\n\n- [fact] 用户住在杭州。\n')
    expect(doc.sections[0]?.entries[0]).toEqual({ kind: 'fact', text: '用户住在杭州。' })
  })

  it('adopts loose entries of a title-only document into the default section', () => {
    const doc = parseGlobalMemory('# 全局记忆\n\n- [preference] 用中文。\n')
    expect(doc.preamble).toBe(`# ${GLOBAL_MEMORY_TITLE}`)
    expect(doc.sections[0]?.title).toBe(DEFAULT_GLOBAL_SECTIONS[0])
    expect(doc.sections[0]?.entries[0]?.text).toBe('用中文。')
  })

  it('treats an empty document as absent content, not an error', () => {
    const doc = parseGlobalMemory('')
    expect(doc.sections).toEqual([])
    expect(countEntries(doc)).toBe(0)
  })
})

describe('renderGlobalMemory', () => {
  it('re-emits sections in order with one blank line between blocks', () => {
    const text = renderGlobalMemory(parseGlobalMemory(SAMPLE))
    expect(text.startsWith(`# ${GLOBAL_MEMORY_TITLE}`)).toBe(true)
    expect(text).toContain('## 关于用户\n\n- [preference] 用户偏好中文交流。')
    expect(text).not.toContain('\n\n\n')
  })

  it('drops sections that lost their last entry', () => {
    const text = renderGlobalMemory(parseGlobalMemory('# 全局记忆\n\n## 空章节\n\n## 有内容\n\n- [preference] 留着。\n'))
    expect(text).not.toContain('空章节')
    expect(text).toContain('有内容')
  })
})

describe('upsertGlobalEntry', () => {
  it('creates a missing section at the end and reports it', () => {
    const result = upsertGlobalEntry(SAMPLE, '要求与规则', { text: '先读代码再动手。', kind: 'constraint' })
    expect(result.changed).toBe(true)
    expect(result.createdSection).toBe(true)
    expect(result.count).toBe(4)
    expect(result.text).toContain('## 要求与规则')
    expect(result.text).toContain('- [constraint] 先读代码再动手。')
  })

  it('is idempotent for the same kind and text in the same section', () => {
    const first = upsertGlobalEntry(SAMPLE, '关于用户', { text: '用户偏好中文交流。', kind: 'preference' })
    expect(first.changed).toBe(false)
    expect(first.text).toBe(SAMPLE.trimEnd())
  })

  it('rejects an empty entry and an unsupported kind', () => {
    expect(() => upsertGlobalEntry(SAMPLE, '关于用户', { text: '  ', kind: 'preference' })).toThrow()
    expect(() => upsertGlobalEntry(SAMPLE, '关于用户', { text: '项目事实', kind: 'fact' })).toThrow()
  })

  it('starts a document when none exists', () => {
    const result = upsertGlobalEntry('', DEFAULT_GLOBAL_SECTIONS[0], { text: '用中文交流。', kind: 'preference' })
    expect(result.changed).toBe(true)
    expect(result.text).toContain(`# ${GLOBAL_MEMORY_TITLE}`)
    expect(result.text).toContain('## 关于用户')
  })
})

describe('reviseGlobalMemory', () => {
  it('canonicalises a merge/prune submission without changing its content', () => {
    const submitted = `# 全局记忆（我重写了标题）

## 偏好与习惯
- [preference] 用中文。
- [preference] 回答先给结论。

## 关于用户
- [preference] 用中文。
`
    const text = reviseGlobalMemory(submitted)
    expect(text).toContain('## 偏好与习惯')
    expect(text).toContain('## 关于用户')
    const doc = parseGlobalMemory(text)
    expect(countEntries(doc)).toBe(3)
    expect(renderGlobalMemory(doc)).toBe(text)
  })
})

describe('checkGlobalEntry', () => {
  it('accepts a global kind and returns the normalized text', () => {
    const check = checkGlobalEntry('  用户偏好用中文交流，回复也保持中文。  ', 'preference', evaluateEntry)
    expect(check.allowed).toBe(true)
    expect(check.text).toBe('用户偏好用中文交流，回复也保持中文。')
    expect(check.kind).toBe('preference')
  })

  it('refuses a project-local kind in the global scope', () => {
    const check = checkGlobalEntry('某个项目的一次性发现', 'fact', evaluateEntry)
    expect(check.allowed).toBe(false)
    expect(check.reasons.join(' ')).toContain('全局记忆只接受')
  })

  it('inherits the shared hard rejections', () => {
    const check = checkGlobalEntry('api_key = sk-abcdef1234567890', 'constraint', evaluateEntry)
    expect(check.allowed).toBe(false)
    expect(check.reasons.join(' ')).toContain('密钥')
  })
})

describe('helpers', () => {
  it('counts UTF-8 bytes, not code units', () => {
    expect(globalMemoryBytes('中文')).toBe(6)
    expect(globalMemoryBytes('ab')).toBe(2)
  })

  it('normalizes a section title and keeps one line', () => {
    expect(sectionTitle('  关于用户  ')).toBe('关于用户')
    expect(sectionTitle('')).toBe(DEFAULT_GLOBAL_SECTIONS[0])
    expect(sectionTitle('a\nb')).toBe('a b')
  })

  it('accepts exactly the four durable global kinds', () => {
    expect(isGlobalEntryKind('preference')).toBe(true)
    expect(isGlobalEntryKind('constraint')).toBe(true)
    expect(isGlobalEntryKind('convention')).toBe(true)
    expect(isGlobalEntryKind('decision')).toBe(true)
    expect(isGlobalEntryKind('fact')).toBe(false)
    expect(GLOBAL_MEMORY_FILE).toBe('MEMORY.md')
  })
})
