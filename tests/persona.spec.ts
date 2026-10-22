import { describe, expect, it } from 'vitest'

import { mergePersona, parsePersonaFragment, renderPersonaSection, sortPersona, type PersonaFragment } from '../src/persona.ts'
import type { LayerScope } from '../src/scope.ts'

/** 一个空渲染结果，空输入与不可用预算都必须原样返回它。 */
const EMPTY_RENDER = { text: '', injected: [], pointers: [], dropped: [], truncated: [] }

/** UTF-8 字节数，测试里独立算一遍，避免直接相信被测模块的计量。 */
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** 解析一个必然成功的片段；失败时把 issue 带进断言信息。 */
function fragment(scope: LayerScope, name: string, raw: string): PersonaFragment {
  const parsed = parsePersonaFragment(scope, name, raw)
  if (parsed.fragment === undefined) {
    throw new Error(`parsePersonaFragment(${name}) 失败：${parsed.issue ?? '无 issue'}`)
  }
  return parsed.fragment
}

describe('parsing a fragment', () => {
  it('reads the title and order from frontmatter', () => {
    const parsed = parsePersonaFragment('global', '01-identity', '---\ntitle: 身份与语气\norder: 5\n---\n\n我是一名严谨的工程搭档。\n')
    expect(parsed.issue).toBeUndefined()
    const parsedFragment = parsed.fragment
    expect(parsedFragment).toBeDefined()
    if (parsedFragment === undefined) return
    expect(parsedFragment.scope).toBe('global')
    expect(parsedFragment.name).toBe('01-identity')
    expect(parsedFragment.title).toBe('身份与语气')
    expect(parsedFragment.order).toBe(5)
    expect(parsedFragment.body).toBe('我是一名严谨的工程搭档。')
    expect(parsedFragment.bytes).toBe(bytes(parsedFragment.body))
  })

  it('falls back to the name prefix for the order and to the name for the title', () => {
    const parsed = fragment('workspace', '03-prefs', '协作偏好：先读后改。\n')
    expect(parsed.order).toBe(3)
    expect(parsed.title).toBe('03-prefs')
    expect(parsed.bytes).toBe(bytes('协作偏好：先读后改。'))
  })

  it('defaults the order to 0 when the name has no numeric prefix', () => {
    expect(fragment('workspace', 'identity', '正文。').order).toBe(0)
  })

  it('lets the frontmatter order override the name prefix', () => {
    expect(fragment('workspace', '09-late', '---\norder: 1\n---\n\n正文。').order).toBe(1)
  })

  it('normalizes a name that was passed with its directory or extension', () => {
    const parsed = fragment('global', 'persona/01-identity.md', '正文。')
    expect(parsed.name).toBe('01-identity')
    expect(parsed.order).toBe(1)
    expect(parsed.title).toBe('01-identity')
  })

  it('normalizes CRLF bodies to LF', () => {
    const parsed = fragment('workspace', '01-a', '---\ntitle: 甲\n---\r\n\r\n第一行  \r\n第二行\r\n')
    expect(parsed.body).toBe('第一行\n第二行')
    expect(parsed.body).not.toContain('\r')
  })

  it('collapses a multi-line title to one line', () => {
    const parsed = fragment('workspace', '01-a', '---\ntitle: "身份\\n与语气"\n---\n\n正文。\n')
    expect(parsed.title).toBe('身份 与语气')
  })

  it('keeps the whole text as the body when the frontmatter is unterminated', () => {
    const parsed = fragment('workspace', '01-a', '---\ntitle: 甲\n\n正文留在文件里。\n')
    expect(parsed.body).toContain('title: 甲')
    expect(parsed.body).toContain('正文留在文件里。')
  })

  it('reports an unreadable order but still uses the name prefix', () => {
    const parsed = parsePersonaFragment('workspace', '04-a', '---\norder: 靠前\n---\n\n正文。\n')
    expect(parsed.fragment?.order).toBe(4)
    expect(parsed.issue).toContain('order')
  })

  it('reports a blank order instead of silently ignoring the key', () => {
    const parsed = parsePersonaFragment('workspace', '04-a', '---\norder:\n---\n\n正文。\n')
    expect(parsed.fragment?.order).toBe(4)
    expect(parsed.issue).toContain('order')
  })

  it('rejects an empty body: a heading alone would waste every turn', () => {
    const parsed = parsePersonaFragment('workspace', '01-empty', '---\ntitle: 只有标题\n---\n')
    expect(parsed.fragment).toBeUndefined()
    expect(parsed.issue).toContain('正文为空')
  })

  it('rejects a name that normalizes to nothing', () => {
    for (const name of ['', '   ', '.md', 'persona/', '.\\']) {
      const parsed = parsePersonaFragment('workspace', name, '正文。')
      expect(parsed.fragment, `name: ${JSON.stringify(name)}`).toBeUndefined()
      expect(parsed.issue).toContain('片段名称')
    }
  })
})

describe('sorting', () => {
  it('sorts by the name prefix ascending', () => {
    const fragments = ['10-c', '02-a', '01-b'].map((name) => fragment('workspace', name, '正文。'))
    expect(sortPersona(fragments).map((f) => f.name)).toEqual(['01-b', '02-a', '10-c'])
  })

  it('lets an explicit order outrank the prefix', () => {
    const fragments = [fragment('workspace', '01-early', '正文。'), fragment('workspace', '99-late', '---\norder: 0\n---\n\n正文。')]
    expect(sortPersona(fragments).map((f) => f.name)).toEqual(['99-late', '01-early'])
  })

  it('breaks ties by name, case-insensitively, then literally', () => {
    const fragments = ['beta', 'Alpha', 'alpha'].map((name) => fragment('workspace', name, '正文。'))
    expect(sortPersona(fragments).map((f) => f.name)).toEqual(['Alpha', 'alpha', 'beta'])
  })

  it('returns a new array and leaves the input untouched', () => {
    const fragments = [fragment('workspace', '02-b', '正文。'), fragment('workspace', '01-a', '正文。')]
    const sorted = sortPersona(fragments)
    expect(sorted).not.toBe(fragments)
    expect(fragments.map((f) => f.name)).toEqual(['02-b', '01-a'])
    expect(sorted.map((f) => f.name)).toEqual(['01-a', '02-b'])
  })

  it('returns an empty array for no fragments', () => {
    expect(sortPersona([])).toEqual([])
  })
})

describe('merging scopes', () => {
  it('keeps every global fragment before every workspace fragment', () => {
    const merged = mergePersona(
      [fragment('global', '05-global', '全局正文。')],
      [fragment('workspace', '01-local', '工作区正文。')],
    )
    expect(merged.fragments.map((f) => f.name)).toEqual(['05-global', '01-local'])
    expect(merged.shadowed).toEqual([])
  })

  it('sorts inside each scope group', () => {
    const merged = mergePersona(
      [fragment('global', '02-b', '正文。'), fragment('global', '01-a', '正文。')],
      [fragment('workspace', '02-d', '正文。'), fragment('workspace', '01-c', '正文。')],
    )
    expect(merged.fragments.map((f) => f.name)).toEqual(['01-a', '02-b', '01-c', '02-d'])
  })

  it('lets a workspace fragment wholly shadow the global one of the same name', () => {
    const globalFragment = fragment('global', '01-identity', '全局人格。')
    const workspaceFragment = fragment('workspace', '01-identity', '工作区人格。')
    const merged = mergePersona([globalFragment], [workspaceFragment])
    expect(merged.fragments).toHaveLength(1)
    expect(merged.fragments[0]?.body).toBe('工作区人格。')
    expect(merged.shadowed).toEqual([globalFragment])
  })

  it('shadows case-insensitively, because the file systems are', () => {
    const merged = mergePersona(
      [fragment('global', '01-Identity', '全局人格。')],
      [fragment('workspace', '01-identity', '工作区人格。')],
    )
    expect(merged.fragments).toHaveLength(1)
    expect(merged.fragments[0]?.scope).toBe('workspace')
    expect(merged.shadowed).toHaveLength(1)
  })

  it('keeps the global fragments the workspace does not cover', () => {
    const covered = fragment('global', '02-b', '全局正文。')
    const kept = fragment('global', '01-a', '保留的全局正文。')
    const merged = mergePersona([kept, covered], [fragment('workspace', '02-b', '工作区正文。')])
    expect(merged.fragments.map((f) => f.name)).toEqual(['01-a', '02-b'])
    expect(merged.fragments[1]?.scope).toBe('workspace')
    expect(merged.shadowed).toEqual([covered])
  })

  it('merges two empty scopes into empty lists', () => {
    expect(mergePersona([], [])).toEqual({ fragments: [], shadowed: [] })
  })
})

describe('rendering the section', () => {
  const a = fragment('workspace', '01-a', '甲正文。')
  const b = fragment('workspace', '02-b', '---\ntitle: 乙\n---\n\n乙正文。\n')

  it('renders nothing for no fragments', () => {
    expect(renderPersonaSection([], { maxBytes: 4096, fileBytes: 1024 })).toEqual(EMPTY_RENDER)
  })

  it('renders nothing for a budget that cannot be used', () => {
    for (const maxBytes of [0, -1, Number.NaN]) {
      expect(renderPersonaSection([a], { maxBytes, fileBytes: 1024 })).toEqual(EMPTY_RENDER)
    }
  })

  it('renders the heading, one title per fragment, and blank lines between them', () => {
    const render = renderPersonaSection([a, b], { maxBytes: 4096, fileBytes: 1024 })
    expect(render.text).toBe('## 人格\n\n### 01-a\n\n甲正文。\n\n### 乙\n\n乙正文。')
    expect(render.injected).toEqual(['01-a', '02-b'])
    expect(render.pointers).toEqual([])
    expect(render.dropped).toEqual([])
    expect(render.truncated).toEqual([])
  })

  it('keeps the incoming order instead of sorting again', () => {
    const render = renderPersonaSection([b, a], { maxBytes: 4096, fileBytes: 1024 })
    expect(render.text).toBe('## 人格\n\n### 乙\n\n乙正文。\n\n### 01-a\n\n甲正文。')
    expect(render.injected).toEqual(['02-b', '01-a'])
  })

  it('truncates one fragment at its own byte cap and points at persona_read', () => {
    const long = fragment('workspace', '01-long', '人格正文'.repeat(40))
    expect(long.bytes).toBe(480)
    const render = renderPersonaSection([long], { maxBytes: 4096, fileBytes: 30 })
    expect(render.injected).toEqual(['01-long'])
    expect(render.truncated).toEqual(['01-long'])
    expect(render.text).toContain('…（已截断，完整内容用 persona_read 读 01-long）')
    // 30 字节 = 10 个 CJK 字符；按 UTF-16 计会留下 30 个字符。
    const kept = '人格正文'.repeat(2) + '人格'
    expect(render.text).toContain(kept)
    expect(render.text).not.toContain(`${kept}正`)
    expect(bytes(render.text)).toBeLessThanOrEqual(4096)
  })

  it('measures CJK in bytes, never splitting a code point', () => {
    const cjk = fragment('workspace', '01-cjk', '中文字')
    expect(cjk.bytes).toBe(9)
    const render = renderPersonaSection([cjk], { maxBytes: 4096, fileBytes: 8 })
    expect(render.truncated).toEqual(['01-cjk'])
    expect(render.text).toContain('中文')
    expect(render.text).not.toContain('中文字')
    expect(render.text).not.toContain('\uFFFD')
  })

  it('degrades a fragment that does not fit to a persona_read pointer', () => {
    const small = fragment('workspace', '01-a', '短的甲正文。')
    const large = fragment('workspace', '02-b', 'B'.repeat(80))
    const blockA = '### 01-a\n\n短的甲正文。'
    const pointerB = '- 02-b（完整内容用 persona_read 读 02-b）'
    const maxBytes = bytes(`## 人格\n\n${blockA}\n\n${pointerB}`)
    // 自检：整段确实放不下第二个片段的正文，否则这条用例什么也没测到。
    expect(bytes(`## 人格\n\n${blockA}\n\n### 02-b\n\n${large.body}`)).toBeGreaterThan(maxBytes)

    const render = renderPersonaSection([small, large], { maxBytes, fileBytes: 1024 })
    expect(render.text).toBe(`## 人格\n\n${blockA}\n\n${pointerB}`)
    expect(render.injected).toEqual(['01-a'])
    expect(render.pointers).toEqual(['02-b'])
    expect(render.dropped).toEqual([])
    expect(bytes(render.text)).toBeLessThanOrEqual(maxBytes)
  })

  it('drops a fragment that cannot even hold a pointer, and names it at the end', () => {
    const small = fragment('workspace', '01-a', '短的甲正文。')
    const wideTitle = '乙'.repeat(40)
    const large = fragment('workspace', '02-b', `---\ntitle: "${wideTitle}"\n---\n\n乙的正文。\n`)
    // 160 字节：容得下第一段正文 + 段尾点名（152 字节），但放不下宽标题的指针行。
    const maxBytes = 160
    const notice = `> 注入预算（${maxBytes} 字节）已满，以下片段本轮未注入，需要时用 persona_read 直接读：02-b`

    const render = renderPersonaSection([small, large], { maxBytes, fileBytes: 1024 })
    expect(render.injected).toEqual(['01-a'])
    expect(render.pointers).toEqual([])
    expect(render.dropped).toEqual(['02-b'])
    expect(render.text).toBe(`## 人格\n\n### 01-a\n\n短的甲正文。\n\n${notice}`)
    expect(bytes(render.text)).toBeLessThanOrEqual(maxBytes)
  })

  it('never exceeds the whole-section budget', () => {
    const fragments = [
      fragment('workspace', '01-a', '短的甲正文。'),
      fragment('workspace', '02-wide', `---\ntitle: "${'乙'.repeat(40)}"\n---\n\n${'乙'.repeat(300)}\n`),
      fragment('workspace', '03-long', '人格正文'.repeat(40)),
    ]
    for (const maxBytes of [1, 5, 20, 90, 152, 160, 400, 1200, 4096]) {
      const render = renderPersonaSection(fragments, { maxBytes, fileBytes: 30 })
      expect(bytes(render.text), `budget ${maxBytes}`).toBeLessThanOrEqual(maxBytes)
    }
  })

  it('stays within a budget too small even for its own heading', () => {
    const render = renderPersonaSection([a], { maxBytes: 5, fileBytes: 1024 })
    expect(bytes(render.text)).toBeLessThanOrEqual(5)
  })

  it('reports a fragment whose block and pointer both failed as dropped only', () => {
    const fragments = [
      fragment('workspace', '01-a', '甲正文。'),
      fragment('workspace', '02-b', `---\ntitle: "${'乙'.repeat(40)}"\n---\n\n乙正文。\n`),
    ]
    // 20 字节连第一段正文和它的指针行都放不下。
    const render = renderPersonaSection(fragments, { maxBytes: 20, fileBytes: 1024 })
    expect(render.injected).toEqual([])
    expect(render.pointers).toEqual([])
    expect(render.dropped).toEqual(['01-a', '02-b'])
    expect(bytes(render.text)).toBeLessThanOrEqual(20)
  })
})
