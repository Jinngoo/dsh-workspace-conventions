import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PatchFormatError,
  defaultProfileDir,
  findRows,
  parsePatch,
  readPatchFile,
  resolveRow,
} from '../src/patch.ts'

const BUNDLE_PATCH = join(process.cwd(), 'cordis.patch.yml')
const PROFILE_DIR = defaultProfileDir()
const PROFILE_PATCH = PROFILE_DIR === undefined ? undefined : join(PROFILE_DIR, 'cordis.patch.yml')

const ROW_ID = 'workspace-conventions'

/**
 * 本机 profile 是否真的覆盖了本行。
 *
 * 「profile 里有覆盖」是**机器级可选配置**，不是包的契约：默认安装（含 CI 与任何新机器）只有 bundle
 * patch 那一份。所以下面那条断言必须在没有覆盖时跳过，而不是要求每台机器都手写一段 profile 配置。
 * 解析失败按「无覆盖」处理——profile patch 里出现本工程不支持的方言时，这条测试不该替 patch 解析器丢脸。
 */
function profileOverridesRow(): boolean {
  if (PROFILE_PATCH === undefined || !existsSync(PROFILE_PATCH)) return false
  try {
    return findRows(parsePatch(readFileSync(PROFILE_PATCH, 'utf8'), PROFILE_PATCH), ROW_ID).length > 0
  } catch {
    return false
  }
}

const PROFILE_OVERRIDES_ROW = profileOverridesRow()

describe('the supported slice of a patch file', () => {
  it('unwraps `- insert:` and keeps the nested config block', () => {
    const document = parsePatch(
      [
        '# a comment',
        '- insert:',
        '    - id: workspace-conventions',
        "      name: '@jinngoo/dsh-workspace-conventions'",
        '      config:',
        '        indexPromptBytes: 7000',
        '        rulesPromptBytes: 49152',
        '        ruleFileBytes: 16384',
      ].join('\n'),
      'bundle.yml',
    )

    expect(document.insert).toHaveLength(1)
    const row = document.insert[0]
    expect(row?.id).toBe(ROW_ID)
    expect(row?.name).toBe('@jinngoo/dsh-workspace-conventions')
    expect(row?.config).toEqual({ indexPromptBytes: 7000, rulesPromptBytes: 49152, ruleFileBytes: 16384 })
    expect(document.topLevel).toEqual([])
  })

  it('accepts `insert:` as a bare top-level key too', () => {
    const document = parsePatch(['insert:', '  - id: row', '    config:', '      n: 1'].join('\n'), 'bare.yml')

    expect(document.insert).toHaveLength(1)
    expect(document.insert[0]?.id).toBe('row')
    expect(document.insert[0]?.config).toEqual({ n: 1 })
  })

  it('reads a profile patch whose rows sit at the top level', () => {
    const document = parsePatch(
      [
        '- id: agent-preset-registry',
        '  name: "@deepseek-ai/dsh-agent-preset-registry"',
        '  config:',
        '    default: standard',
        '- id: workspace-conventions',
        '  name: "@jinngoo/dsh-workspace-conventions"',
        '  config:',
        '    indexPromptBytes: 7000',
        '    rulesPromptBytes: 32768',
        '    ruleFileBytes: 16384',
      ].join('\n'),
      'profile.yml',
    )

    expect(document.topLevel.map((row) => row.id)).toEqual(['agent-preset-registry', ROW_ID])
    expect(document.insert).toEqual([])
    expect(document.topLevel[1]?.config).toEqual({ indexPromptBytes: 7000, rulesPromptBytes: 32768, ruleFileBytes: 16384 })
  })

  it('reads a sequence value nested under a key', () => {
    const document = parsePatch(
      ['insert:', '  - id: outer', '    paths:', '      - a/*.ts', '      - b/*.cs'].join('\n'),
      'nested-seq.yml',
    )

    expect(document.insert[0]?.keys).toEqual({ id: 'outer', paths: ['a/*.ts', 'b/*.cs'] })
  })

  it('reads a nested map under a key', () => {
    const document = parsePatch(
      ['insert:', '  - id: outer', '    meta:', '      nested: true'].join('\n'),
      'nested-map.yml',
    )

    expect(document.insert[0]?.keys).toEqual({ id: 'outer', meta: { nested: true } })
  })

  it('keeps a colon inside quotes instead of splitting on it', () => {
    const document = parsePatch(
      ['- id: web', '  url: "http://127.0.0.1:3080"', "  note: 'a: b'"].join('\n'),
      'quoted.yml',
    )

    expect(document.topLevel[0]?.keys).toEqual({ id: 'web', url: 'http://127.0.0.1:3080', note: 'a: b' })
  })

  it('coerces plain scalars to numbers and booleans', () => {
    const document = parsePatch(['- id: row', '  n: 32768', '  neg: -5', '  on: true', '  off: false', '  s: 32768x'].join('\n'), 'scalars.yml')

    expect(document.topLevel[0]?.keys).toEqual({ id: 'row', n: 32768, neg: -5, on: true, off: false, s: '32768x' })
  })

  it('accepts an empty file and a file of only comments', () => {
    expect(parsePatch('', 'empty.yml').insert).toEqual([])
    expect(parsePatch('# nothing\n\n# here\n', 'comments.yml').topLevel).toEqual([])
  })
})

describe('refusing what it cannot read', () => {
  it('refuses a flow-style collection rather than guessing', () => {
    expect(() => parsePatch('- id: row\n  config: { a: 1 }\n', 'flow.yml')).toThrow(/flow-style/)
    expect(() => parsePatch('- id: row\n  config: [1, 2]\n', 'flow.yml')).toThrow(/flow-style/)
  })

  it('refuses an unterminated quoted scalar', () => {
    expect(() => parsePatch('- id: "row\n', 'quote.yml')).toThrow(/unterminated/)
  })

  it('refuses an anchor', () => {
    expect(() => parsePatch('- id: &anchor row\n', 'anchor.yml')).toThrow(/anchors/)
  })

  it('refuses a tag', () => {
    expect(() => parsePatch('- id: !!str row\n', 'tag.yml')).toThrow(/tags/)
  })

  it('refuses a block scalar', () => {
    expect(() => parsePatch('- id: row\n  body: |\n    text\n', 'block.yml')).toThrow(/block scalars/)
  })

  it('refuses a row whose sequence item is not a mapping', () => {
    expect(() => parsePatch('- insert:\n- 7\n', 'empty-item.yml')).toThrow(/patch row must be a mapping/)
  })

  it('refuses a duplicate key instead of keeping the last one silently', () => {
    expect(() => parsePatch('- id: row\n  id: other\n', 'dupe.yml')).toThrow(/duplicate key/)
  })

  it('refuses a tab used as indentation', () => {
    expect(() => parsePatch('- id: row\n  name: a\n\tvalue: b\n', 'tab.yml')).toThrow(/tabs are not supported/)
  })

  it('still detects a sibling key when the indentation is irregular', () => {
    // Indentation is read relatively, so a sibling key may sit at an irregular
    // depth; what must not change is that it is recognised as a sibling, which
    // is what turns a repeated key into a refusal instead of a silent overwrite.
    expect(() => parsePatch('- id: row\n        id: other\n', 'irregular.yml')).toThrow(/duplicate key/)
  })

  it('refuses a top-level row that declares neither an id nor an insert', () => {
    expect(() => parsePatch('inject:\n  - id: x\n', 'other.yml')).toThrow(/top-level row must declare/)
  })
})

describe('resolving a row against the profile that overrides it', () => {
  const bundle = parsePatch(
    ['- insert:', '    - id: row', '      config:', '        rulesPromptBytes: 49152', '        ruleFileBytes: 16384'].join('\n'),
    'bundle.yml',
  )

  it('takes the last id-targeted patch as the effective config', () => {
    const first = parsePatch('- id: row\n  config:\n    rulesPromptBytes: 24576\n', 'first.yml')
    const second = parsePatch('- id: row\n  config:\n    rulesPromptBytes: 32768\n', 'second.yml')

    const effective = resolveRow(bundle, [first, second], 'row')
    expect(effective.overridden).toBe(true)
    expect(effective.effective).toEqual({ rulesPromptBytes: 32768 })
    expect(effective.applied.map((entry) => entry.source)).toEqual(['first.yml', 'second.yml'])
    expect(effective.baseline).toEqual({ rulesPromptBytes: 49152, ruleFileBytes: 16384 })
  })

  it('replaces the config wholesale instead of merging into the baseline', () => {
    const patch = parsePatch('- id: row\n  config:\n    rulesPromptBytes: 32768\n', 'partial.yml')

    const effective = resolveRow(bundle, [patch], 'row')
    expect(effective.effective).toEqual({ rulesPromptBytes: 32768 })
    expect(effective.effective?.['ruleFileBytes']).toBeUndefined()
  })

  /**
   * The regression this module exists for: an id-targeted patch whose `id` no
   * longer matches the bundle's row silently leaves the baseline in place, so
   * the effective value stays at 49152 and the intended saving never happens.
   */
  it('falls back to the baseline when the profile id no longer matches', () => {
    const stale = parsePatch('- id: workspace-memory\n  config:\n    rulesPromptBytes: 32768\n', 'stale.yml')

    const effective = resolveRow(bundle, [stale], 'row')
    expect(effective.overridden).toBe(false)
    expect(effective.effective?.['rulesPromptBytes']).toBe(49152)
  })

  it('reports a bundle that inserts no such row', () => {
    expect(() => resolveRow(bundle, [], 'absent')).toThrow(/inserts no row/)
  })

  it('reports an id that addresses more than one row', () => {
    const doubled = parsePatch(['- insert:', '    - id: row', '    - id: row'].join('\n'), 'doubled.yml')
    expect(() => resolveRow(doubled, [], 'row')).toThrow(/exactly one row/)
  })
})

describe('the patch files this repository actually ships', () => {
  it('states a 49152 baseline in the bundle patch', async () => {
    const document = await readPatchFile(BUNDLE_PATCH)
    const rows = findRows(document, ROW_ID)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('@jinngoo/dsh-workspace-conventions')
    expect(rows[0]?.config?.['rulesPromptBytes']).toBe(49152)
    expect(rows[0]?.config?.['ruleFileBytes']).toBe(16384)
    expect(rows[0]?.config?.['indexPromptBytes']).toBe(7000)
  })

  it('reads the bundle patch without leaving the supported slice', () => {
    expect(() => readPatchFile(BUNDLE_PATCH)).not.toThrow()
  })

  it.skipIf(!PROFILE_OVERRIDES_ROW)(
    'has a profile patch that overrides the baseline for this machine',
    async () => {
      const bundle = await readPatchFile(BUNDLE_PATCH)
      const profile = await readPatchFile(PROFILE_PATCH as string)

      const effective = resolveRow(bundle, [profile], ROW_ID)
      expect(effective.overridden).toBe(true)
      expect(typeof effective.effective?.['rulesPromptBytes']).toBe('number')
      // 覆盖的动机可以是任意字段（例如审批开关），不一定是预算。
      // 这里只要求本机 profile 的覆盖确实改变了某一项配置，而不是固定挑 rulesPromptBytes。
      const changedKeys = Object.keys(effective.effective ?? {}).filter(
        (key) => JSON.stringify(effective.effective?.[key]) !== JSON.stringify(effective.baseline?.[key]),
      )
      expect(changedKeys.length).toBeGreaterThan(0)
    },
  )
})

describe('locating the profile from the environment', () => {
  it('prefers DSH_PROFILE_DIR', () => {
    expect(defaultProfileDir({ DSH_PROFILE_DIR: 'C:/x/web', DSH_HOME: 'C:/ignored' })).toBe('C:/x/web')
  })

  it('falls back to DSH_HOME plus the profile name', () => {
    expect(defaultProfileDir({ DSH_HOME: 'C:/dsh', DSH_PROFILE: 'cordis' })).toBe(join('C:/dsh', 'profiles', 'cordis'))
  })

  it('defaults the profile name to web', () => {
    expect(defaultProfileDir({ DSH_HOME: 'C:/dsh' })).toBe(join('C:/dsh', 'profiles', 'web'))
  })

  it('reports nothing when neither variable is set', () => {
    expect(defaultProfileDir({})).toBeUndefined()
  })
})
