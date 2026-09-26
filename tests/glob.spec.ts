import { describe, expect, it } from 'vitest'

import { expandBraces, firstMatchingGlob, globToRegExp, matchGlob } from '../src/glob.ts'

describe('brace expansion', () => {
  it('expands extensions', () => {
    expect(expandBraces('*.{cs,ts}')).toEqual(['*.cs', '*.ts'])
  })

  it('expands every group it finds', () => {
    expect(expandBraces('{a,b}/x.{cs,ts}')).toEqual(['a/x.cs', 'a/x.ts', 'b/x.cs', 'b/x.ts'])
  })

  it('leaves an unclosed group alone rather than dropping text', () => {
    expect(expandBraces('a/{b')).toEqual(['a/{b'])
  })
})

describe('the WorkBuddy trigger dialect', () => {
  it('anchors both ends', () => {
    expect(globToRegExp('a.cs').test('a.cs')).toBe(true)
    expect(globToRegExp('a.cs').test('xa.cs')).toBe(false)
    expect(globToRegExp('a.cs').test('a.csx')).toBe(false)
  })

  it('lets ** span directories', () => {
    expect(matchGlob('server/**/*.cs', 'server/a.cs')).toBe(true)
    expect(matchGlob('server/**/*.cs', 'server/deep/nested/a.cs')).toBe(true)
    expect(matchGlob('server/**/*.cs', 'client/a.cs')).toBe(false)
    expect(matchGlob('server/**/*.cs', 'server/a.ts')).toBe(false)
  })

  it('keeps a single * inside one path segment', () => {
    expect(matchGlob('server/*.cs', 'server/a.cs')).toBe(true)
    expect(matchGlob('server/*.cs', 'server/deep/a.cs')).toBe(false)
  })

  it('handles the error-code book trigger', () => {
    const paths = ['**/*ErrCode*.{cs,ts}', '**/*ErrMsg*.{cs,ts}', '**/*ErrorCode*.{cs,ts}']
    expect(firstMatchingGlob(paths, 'server/Escort/Protocol/BagErrCode.cs')).toBe(paths[0])
    expect(firstMatchingGlob(paths, 'client/assets/ErrorCodeAll.ts')).toBe(paths[2])
    expect(firstMatchingGlob(paths, 'server/BagService.cs')).toBeUndefined()
  })

  it('matches either separator style', () => {
    expect(matchGlob('server/**/*.cs', 'server\\deep\\a.cs')).toBe(true)
  })

  it('is case-insensitive, because the platforms it targets are', () => {
    expect(matchGlob('client/Escort/assets/**/*.ts', 'Client/escort/Assets/UI/A.ts')).toBe(true)
  })

  it('matches ? against one non-separator character', () => {
    expect(matchGlob('a?.cs', 'ab.cs')).toBe(true)
    expect(matchGlob('a?.cs', 'a/b.cs')).toBe(false)
  })

  it('treats regex metacharacters literally', () => {
    expect(matchGlob('a+b.cs', 'a+b.cs')).toBe(true)
    expect(matchGlob('a+b.cs', 'aab.cs')).toBe(false)
  })
})
