import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DIR,
  ENTRY_KINDS,
  INDEX_FILE,
  WORKBUDDY_DIR,
  dateStamp,
  detectSectionLevel,
  evaluateEntry,
  ledgerForDate,
  ledgerWritePath,
  normalizeText,
  parseIndexDocument,
  renderEntry,
  scanLedgers,
  toPosix,
  upsertIndexEntry,
} from '../src/index.ts'

describe('admission', () => {
  it('rejects empty and too-short entries', () => {
    expect(evaluateEntry('', 'fact').allowed).toBe(false)
    expect(evaluateEntry('   ', 'fact').allowed).toBe(false)
    expect(evaluateEntry('改了下', 'fact').allowed).toBe(false)
  })

  it('rejects secrets unconditionally', () => {
    const verdict = evaluateEntry('配置 api_key = sk-abcdef1234567890 到环境变量', 'fact')
    expect(verdict.allowed).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('密钥')
  })

  it('rejects private key material', () => {
    expect(evaluateEntry('-----BEGIN RSA PRIVATE KEY-----\nMIIEow', 'fact').allowed).toBe(false)
  })

  it('allows a durable pitfall with no advisories', () => {
    const verdict = evaluateEntry('SignalR 的 Group 成员关系不会随重连保留，必须在 onReady() 里重新声明订阅。', 'pitfall')
    expect(verdict.allowed).toBe(true)
    expect(verdict.warnings).toEqual([])
    expect(verdict.kind).toBe('pitfall')
  })

  it('warns about play-by-play without refusing it', () => {
    const verdict = evaluateEntry('修复了订阅判等问题并更新了文档', 'fact')
    expect(verdict.allowed).toBe(true)
    expect(verdict.warnings.length).toBeGreaterThan(0)
  })

  it('falls back to fact for an unknown kind', () => {
    expect(evaluateEntry('这是一个足够长的稳定事实描述。', 'nonsense').kind).toBe('fact')
  })

  it('exposes every documented kind', () => {
    expect([...ENTRY_KINDS]).toEqual(['decision', 'preference', 'convention', 'pitfall', 'environment', 'constraint', 'fact'])
  })
})

describe('entry rendering', () => {
  it('carries time, kind, scope and tags', () => {
    const at = new Date(2026, 8, 14, 9, 30)
    const block = renderEntry({ content: '不要在未确认前提交。', kind: 'constraint', at, tags: ['svn'] })
    expect(block.startsWith('## 09:30 · constraint')).toBe(true)
    expect(block).toContain('- scope: workspace')
    expect(block).toContain('- tags: svn')
    expect(block).toContain('不要在未确认前提交。')
  })

  it('promotes a long body to a title plus prose', () => {
    const content = 'H'.repeat(200)
    const block = renderEntry({ content, kind: 'fact', title: '简短标题' })
    expect(block).toContain('简短标题\n\n')
  })
})

describe('index document parsing', () => {
  it('treats a lone top-level heading as the document title', () => {
    expect(detectSectionLevel([{ level: 1 }, { level: 2 }, { level: 2 }])).toBe(2)
  })

  it('treats the shallowest heading as the section level when no title exists', () => {
    expect(detectSectionLevel([{ level: 2 }, { level: 2 }])).toBe(2)
  })

  it('keeps the document title out of the sections', () => {
    const doc = parseIndexDocument('# T\n\n> note\n\n## A\n- 1\n\n## B\n- 2\n')
    expect(doc.sections.map((s) => s.title)).toEqual(['A', 'B'])
    expect(doc.preamble).toContain('# T')
    expect(doc.preamble).toContain('> note')
  })

  it('handles a document with no headings at all', () => {
    const doc = parseIndexDocument('just prose\n')
    expect(doc.sections).toEqual([])
    expect(doc.preamble).toBe('just prose')
  })
})

describe('index insertion', () => {
  const WB = '# 项目记忆\n\n> 写入准则：宁缺毋滥。\n\n## 一、文档索引\n- 规范\n\n## 二、用户偏好\n- 中文沟通\n\n## 三、阶段与遗留\n- P2\n'

  it('lands the bullet inside the named section, before the next one', () => {
    const result = upsertIndexEntry(WB, '二、用户偏好', '不擅自启动服务')
    const at = result.text.indexOf('不擅自启动服务')
    expect(at).toBeGreaterThan(result.text.indexOf('## 二、用户偏好'))
    expect(at).toBeLessThan(result.text.indexOf('## 三、阶段与遗留'))
  })

  it('preserves the preamble, every other section and existing bullets', () => {
    const result = upsertIndexEntry(WB, '二、用户偏好', '不擅自启动服务')
    expect(result.text).toContain('宁缺毋滥')
    expect(result.text).toContain('## 一、文档索引')
    expect(result.text).toContain('- 规范')
    expect(result.text).toContain('- 中文沟通')
    expect(result.text).toContain('## 三、阶段与遗留')
    expect(result.text).toContain('- P2')
  })

  it('is idempotent', () => {
    const first = upsertIndexEntry(WB, '二、用户偏好', '不擅自启动服务')
    const second = upsertIndexEntry(first.text, '二、用户偏好', '不擅自启动服务')
    expect(second.changed).toBe(false)
    expect(second.text).toBe(first.text)
  })

  it('creates a missing section', () => {
    const result = upsertIndexEntry(WB, '约束与红线', '禁止 force push')
    expect(result.createdSection).toBe(true)
    expect(result.text).toContain('## 约束与红线')
    expect(result.text).toContain('- 禁止 force push')
  })

  it('builds a heading when the index is empty', () => {
    const result = upsertIndexEntry('', '约束与红线', '禁止 force push')
    expect(result.text).toBe('## 约束与红线\n- 禁止 force push')
  })

  it('rejects an empty entry', () => {
    expect(() => upsertIndexEntry(WB, '一、文档索引', '   ')).toThrow()
  })
})

describe('helpers', () => {
  it('normalizes CRLF and trailing whitespace', () => {
    expect(normalizeText('a\r\nb  \n\n')).toBe('a\nb')
  })

  it('presents paths with forward slashes', () => {
    expect(toPosix('D:\\Work\\x')).toBe('D:/Work/x')
  })

  it('formats a local date stamp', () => {
    expect(dateStamp(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('names both backend directories and the shared index file', () => {
    expect(WORKBUDDY_DIR).toBe('.workbuddy')
    expect(DEFAULT_DIR).toBe('.dsh')
    expect(INDEX_FILE).toBe('MEMORY.md')
  })
})

describe('ledger layout', () => {
  it('keeps a flat store flat', () => {
    const scan = scanLedgers([
      { name: 'MEMORY.md', type: 'file' },
      { name: 'document.md', type: 'file' },
      { name: '2026-09-24.md', type: 'file' },
    ], [], 'DevPC')
    expect(scan.layout).toBe('flat')
    expect(scan.hostDir).toBe('')
    expect(scan.ledgers.map((f) => f.rel)).toEqual(['2026-09-24.md'])
    expect(ledgerWritePath(scan, '2026-09-25')).toBe('2026-09-25.md')
  })

  it('detects the per-computer layout from a dated file in a subdirectory', () => {
    const scan = scanLedgers(
      [{ name: 'MEMORY.md', type: 'file' }],
      [
        { name: 'DevPC', entries: [{ name: '2026-09-24.md', type: 'file' }] },
        { name: 'Laptop', entries: [{ name: '2026-09-23.md', type: 'file' }] },
      ],
      'DevPC',
    )
    expect(scan.layout).toBe('host')
    expect(scan.hostDir).toBe('DevPC')
    expect(scan.ledgers.map((f) => f.rel)).toEqual(['DevPC/2026-09-24.md', 'Laptop/2026-09-23.md'])
    expect(ledgerWritePath(scan, '2026-09-25')).toBe('DevPC/2026-09-25.md')
  })

  it('reuses an existing machine directory whatever its case', () => {
    const scan = scanLedgers([], [{ name: 'DevPC', entries: [] }], 'devpc')
    expect(scan.layout).toBe('host')
    expect(scan.hostDir).toBe('DevPC')
    expect(ledgerWritePath(scan, '2026-09-25')).toBe('DevPC/2026-09-25.md')
  })

  it('prefers an exact machine name over a case-insensitive one', () => {
    const scan = scanLedgers([], [
      { name: 'devpc', entries: [] },
      { name: 'DevPC', entries: [] },
    ], 'DevPC')
    expect(scan.hostDir).toBe('DevPC')
  })

  describe('a configured preference overrides the detected layout', () => {
    const flatStore = () => scanLedgers([{ name: '2026-09-24.md', type: 'file' }], [], 'DevPC')

    it('forces per-computer writes on a flat store', () => {
      const scan = scanLedgers([{ name: '2026-09-24.md', type: 'file' }], [], 'DevPC', 'host')

      expect(scan.layout).toBe('host')
      expect(scan.hostDir).toBe('DevPC')
      expect(ledgerWritePath(scan, '2026-09-25')).toBe('DevPC/2026-09-25.md')
      // The existing flat ledger is still inventoried, not hidden by the switch.
      expect(scan.ledgers.map((f) => f.rel)).toEqual(['2026-09-24.md'])
    })

    it('forces flat writes on a per-computer store', () => {
      const scan = scanLedgers(
        [],
        [{ name: 'DevPC', entries: [{ name: '2026-09-24.md', type: 'file' }] }],
        'DevPC',
        'flat',
      )

      expect(scan.layout).toBe('flat')
      expect(scan.hostDir).toBe('')
      expect(ledgerWritePath(scan, '2026-09-25')).toBe('2026-09-25.md')
      expect(scan.ledgers.map((f) => f.rel)).toEqual(['DevPC/2026-09-24.md'])
    })

    it('keeps the store own layout under auto', () => {
      expect(flatStore().layout).toBe('flat')
      expect(scanLedgers([], [{ name: 'DevPC', entries: [] }], 'DevPC', 'auto').layout).toBe('host')
    })
  })

  it('reads this machine own ledger before the store root', () => {
    const scan = scanLedgers(
      [{ name: '2026-09-24.md', type: 'file' }],
      [{ name: 'DevPC', entries: [{ name: '2026-09-24.md', type: 'file' }] }],
      'DevPC',
    )
    expect(ledgerForDate(scan, '2026-09-24')?.rel).toBe('DevPC/2026-09-24.md')
  })

  it('falls back to another machine only for an unambiguous date', () => {
    const single = scanLedgers([], [{ name: 'Laptop', entries: [{ name: '2026-09-23.md', type: 'file' }] }], 'DevPC')
    expect(ledgerForDate(single, '2026-09-23')?.rel).toBe('Laptop/2026-09-23.md')

    const ambiguous = scanLedgers([], [
      { name: 'Laptop', entries: [{ name: '2026-09-23.md', type: 'file' }] },
      { name: 'MacMini', entries: [{ name: '2026-09-23.md', type: 'file' }] },
    ], 'DevPC')
    expect(ledgerForDate(ambiguous, '2026-09-23')).toBeUndefined()
    expect(ledgerForDate(ambiguous, '2026-09-22')).toBeUndefined()
  })

  it('ignores anything that is not a dated ledger file', () => {
    const scan = scanLedgers([
      { name: 'MEMORY.md', type: 'file' },
      { name: '2026-9-4.md', type: 'file' },
      { name: '2026-09-24.md', type: 'directory' },
    ], [{ name: 'DevPC', entries: [{ name: 'MEMORY.md', type: 'file' }] }], 'DevPC')
    expect(scan.ledgers).toEqual([])
    expect(scan.layout).toBe('host')
  })
})
