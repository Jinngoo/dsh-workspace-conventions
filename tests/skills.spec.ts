import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { WORKBUDDY_SKILL_RANK, createWorkbuddySkillProvider, parseSkill } from '../src/skills.ts'
import { toPosix } from '../src/text.ts'

const GOOD = [
  '---',
  'name: "escort-design-docs"',
  'description: "策划文档与配置表的处理规程。"',
  'agent_created: true',
  '---',
  '',
  '# 正文',
  '',
  '细则在 references/ 下。',
].join('\n')

describe('skill bundle parsing', () => {
  it('reads the reference bundle shape', () => {
    const parsed = parseSkill(GOOD)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.skill.name).toBe('escort-design-docs')
    expect(parsed.skill.description).toBe('策划文档与配置表的处理规程。')
    expect(parsed.skill.modelInvocable).toBe(true)
    expect(parsed.skill.userInvocable).toBe(true)
    expect(parsed.skill.body).toContain('细则在 references/ 下。')
    expect(parsed.skill.body).not.toContain('name:')
  })

  it('removes the invocation surface the author closed', () => {
    const parsed = parseSkill('---\nname: x\ndescription: d\ndisable-model-invocation: true\nuser-invocable: off\n---\n\nbody\n')
    expect(parsed.ok && parsed.skill.modelInvocable).toBe(false)
    expect(parsed.ok && parsed.skill.userInvocable).toBe(false)
  })

  it('drops the skill rather than quietly permitting a surface', () => {
    const parsed = parseSkill('---\nname: x\ndescription: d\ndisable-model-invocation: maybe\n---\n\nbody\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('disable-model-invocation')
  })

  it('names each reason it rejects a bundle', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['# no frontmatter\n', 'frontmatter'],
      ['---\ndescription: d\n---\n', 'name'],
      ['---\nname: "Not Kebab"\ndescription: d\n---\n', 'kebab-case'],
      ['---\nname: x\n---\n', 'description'],
    ]
    for (const [source, expected] of cases) {
      const parsed = parseSkill(source)
      expect(parsed.ok, source).toBe(false)
      if (parsed.ok) continue
      expect(parsed.reason).toContain(expected)
    }
  })
})

interface FakeStore {
  readonly dirs: Readonly<Record<string, readonly { readonly name: string, readonly type?: string }[]>>
  readonly files: Readonly<Record<string, string>>
  readonly reads: string[]
}

function provider(store: FakeStore, warnings: string[] = []) {
  return createWorkbuddySkillProvider({
    list: async (dir) => store.dirs[toPosix(dir)] ?? [],
    read: async (path) => {
      store.reads.push(toPosix(path))
      return store.files[toPosix(path)]
    },
  }, 'workspace-workbuddy-skills', (message) => warnings.push(message))
}

const WORKSPACE = 'C:/repo/program'
const SKILLS = `${WORKSPACE}/.workbuddy/skills`

describe('the WorkBuddy skill provider', () => {
  const store: FakeStore = {
    dirs: {
      [SKILLS]: [
        { name: 'escort-design-docs', type: 'directory' },
        { name: 'loose.md', type: 'file' },
        { name: 'scripts', type: 'directory' },
        { name: 'notes.txt', type: 'file' },
        { name: '.hidden', type: 'directory' },
      ],
    },
    files: {
      [`${SKILLS}/escort-design-docs/SKILL.md`]: GOOD,
      [`${SKILLS}/loose.md`]: '---\nname: loose\ndescription: 平铺技能。\n---\n\nbody\n',
    },
    reads: [],
  }

  it('lists both bundle shapes and ignores everything else', async () => {
    const candidates = await provider(store).list({ cwd: WORKSPACE })
    expect(candidates.map((c) => c.name)).toEqual(['escort-design-docs', 'loose'])
    expect(candidates.every((c) => c.rank === WORKBUDDY_SKILL_RANK)).toBe(true)
    expect(candidates.every((c) => c.source === 'workbuddy')).toBe(true)
  })

  it('ranks below both project roots so a real project skill wins a collision', () => {
    expect(WORKBUDDY_SKILL_RANK).toBeGreaterThan(200)
    expect(WORKBUDDY_SKILL_RANK).toBeLessThan(300)
  })

  it('resolves relative resources against the bundle directory', async () => {
    const [first] = await provider(store).list({ cwd: WORKSPACE })
    expect(first?.resourceBase).toEqual({ kind: 'directory', path: join(SKILLS, 'escort-design-docs') })
    expect(toPosix(first?.path ?? '')).toBe(`${SKILLS}/escort-design-docs/SKILL.md`)
  })

  it('loads the body on demand and strips the frontmatter', async () => {
    const [first] = await provider(store).list({ cwd: WORKSPACE })
    expect(first).toBeDefined()
    if (first === undefined) return
    const definition = await provider(store).get(first, { cwd: WORKSPACE })
    expect(definition?.content).toContain('细则在 references/ 下。')
    expect(definition?.name).toBe('escort-design-docs')
  })

  it('offers nothing without a workspace selector', async () => {
    expect(await provider(store).list({})).toEqual([])
  })

  it('reports a rejected bundle instead of hiding it', async () => {
    const warnings: string[] = []
    const bad: FakeStore = {
      dirs: { [SKILLS]: [{ name: 'broken', type: 'directory' }] },
      files: { [`${SKILLS}/broken/SKILL.md`]: '---\nname: broken\n---\n\nbody\n' },
      reads: [],
    }
    expect(await provider(bad, warnings).list({ cwd: WORKSPACE })).toEqual([])
    expect(warnings.join(' ')).toContain('description')
  })

  it('keeps working when the store does not exist', async () => {
    const empty: FakeStore = { dirs: {}, files: {}, reads: [] }
    expect(await provider(empty).list({ cwd: WORKSPACE })).toEqual([])
  })
})
