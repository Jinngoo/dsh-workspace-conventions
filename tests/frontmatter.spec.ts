import { describe, expect, it } from 'vitest'

import { frontmatterList, frontmatterScalar, parseFrontmatter, readFrontmatterBoolean } from '../src/frontmatter.ts'

describe('frontmatter extraction', () => {
  it('returns the whole document when there is no block', () => {
    const parsed = parseFrontmatter('# T\n\nbody\n')
    expect(parsed.present).toBe(false)
    expect(parsed.body).toBe('# T\n\nbody\n')
    expect(parsed.data.size).toBe(0)
  })

  it('refuses to treat an unterminated block as frontmatter', () => {
    const parsed = parseFrontmatter('---\nalwaysApply: true\n\n# T\n')
    expect(parsed.present).toBe(false)
    expect(parsed.body).toContain('alwaysApply')
  })

  it('splits a block from its body and tolerates CRLF', () => {
    const parsed = parseFrontmatter('---\r\nalwaysApply: true\r\n---\r\n\r\n# T\r\nbody\r\n')
    expect(parsed.present).toBe(true)
    expect(frontmatterScalar(parsed, 'alwaysApply')).toBe('true')
    expect(parsed.body.trim()).toBe('# T\nbody')
  })

  it('reads a block list', () => {
    const parsed = parseFrontmatter([
      '---',
      'alwaysApply: false',
      'paths:',
      '  - "server/**/*.cs"',
      '  - client/**/*.ts',
      '---',
      '',
    ].join('\n'))
    expect(frontmatterList(parsed, 'paths')).toEqual(['server/**/*.cs', 'client/**/*.ts'])
  })

  it('reads an inline list', () => {
    const parsed = parseFrontmatter('---\npaths: [a, "b c"]\n---\n')
    expect(frontmatterList(parsed, 'paths')).toEqual(['a', 'b c'])
  })

  it('unescapes a quoted scalar and keeps inner colons', () => {
    const parsed = parseFrontmatter('---\ndescription: "a: b \\"c\\""\n---\n')
    expect(frontmatterScalar(parsed, 'description')).toBe('a: b "c"')
  })

  it('skips indented children of a nested structure instead of guessing', () => {
    const parsed = parseFrontmatter('---\nmetadata:\n  owner: someone\nname: x\n---\n')
    expect(frontmatterScalar(parsed, 'owner')).toBeUndefined()
    expect(frontmatterScalar(parsed, 'name')).toBe('x')
  })

  it('ignores comments and blank lines', () => {
    const parsed = parseFrontmatter('---\n# note\n\nalwaysApply: false\n---\n')
    expect(frontmatterScalar(parsed, 'alwaysApply')).toBe('false')
    expect(parsed.data.size).toBe(1)
  })
})

describe('the strict boolean grammar', () => {
  const read = (source: string, key: string) => readFrontmatterBoolean(parseFrontmatter(source), key)

  it('separates absence from an unreadable spelling', () => {
    expect(read('---\nname: x\n---\n', 'alwaysApply').kind).toBe('absent')
    expect(read('---\nalwaysApply: maybe\n---\n', 'alwaysApply').kind).toBe('invalid')
    expect(read('---\nalwaysApply:\n---\n', 'alwaysApply').kind).toBe('invalid')
  })

  it('accepts every documented spelling of both values', () => {
    for (const word of ['true', 'TRUE', 'yes', 'on', '1']) {
      expect(read(`---\nalwaysApply: ${word}\n---\n`, 'alwaysApply')).toEqual({ kind: 'value', value: true })
    }
    for (const word of ['false', 'no', 'off', '0']) {
      expect(read(`---\nalwaysApply: ${word}\n---\n`, 'alwaysApply')).toEqual({ kind: 'value', value: false })
    }
  })
})
