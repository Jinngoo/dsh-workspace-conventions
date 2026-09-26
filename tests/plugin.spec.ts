/**
 * End-to-end wiring: drive the real `apply()` against the on-disk fixture.
 *
 * Everything else in this suite tests pure functions. This file is the only
 * place that proves the row actually registers what it claims — two prompt
 * sections in the right order, eight tools, one skill provider, and a
 * `tools/result` listener that turns a file touch into a rule injection.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { apply, type Config } from '../src/index.ts'

const WORKSPACE = fileURLToPath(new URL('./fixtures/workbuddy', import.meta.url))
const SKILL_DIR = join(WORKSPACE, '.workbuddy', 'skills', 'fixture-skill')

interface FakeAgent {
  readonly session: { readonly header: { readonly cwd: string } }
}

const AGENT: FakeAgent = { session: { header: { cwd: WORKSPACE } } }

interface Section {
  readonly name: string
  readonly order: number
  readonly text: (assembly: { readonly agent?: unknown }) => string
}

interface FakeTool {
  readonly name: string
  execute: (args: unknown, ...rest: unknown[]) => Promise<unknown>
}

/**
 * A context providing exactly the six services the row injects.
 *
 * The filesystem stands in for `ctx.fs` with real Node reads, so discovery,
 * parsing and rendering all run against the fixture's actual bytes.
 */
function harness(workspace: string = WORKSPACE): {
  /** The prompt sections, carrying the agent they were mounted for. */
  sections: Section[] & { readonly agent: FakeAgent }
  tools: FakeTool[]
  emit: (event: string, ...args: unknown[]) => void
  skillProvider: () => { list: (o: unknown) => Promise<readonly { name: string }[]> } | undefined
} {
  const sections = [] as Section[] & { agent: FakeAgent }
  const tools: FakeTool[] = []
  const handlers = new Map<string, (...args: never[]) => unknown>()
  let factory: ((control: unknown) => unknown) | undefined
  const control = { invalidate: () => undefined, signal: new AbortController().signal }
  const agent: FakeAgent = { session: { header: { cwd: workspace } } }
  sections.agent = agent

  const ctx = {
    fs: {
      resolve: async (path: string) => ({ path, displayPath: path }),
      stat: async (target: { path: string }) => {
        try {
          const info = await stat(target.path)
          // `mtimeMs` rides along: the row revalidates its cached switches
          // against it, so a stub that dropped it would hide staleness.
          return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size, mtimeMs: info.mtimeMs }
        } catch { return undefined }
      },
      readText: async (target: { path: string }) => await readFile(target.path, 'utf8'),
      listDir: async (target: { path: string }) => (await readdir(target.path, { withFileTypes: true }))
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
    },
    agents: { currentInitiator: () => agent },
    systemPrompt: { context: (section: Section) => { sections.push(section); return () => undefined } },
    sandboxPolicy: { resolve: () => undefined },
    tools: { register: (tool: FakeTool) => { tools.push(tool); return () => undefined } },
    skills: { registerProvider: (create: (control: unknown) => unknown) => { factory = create; return () => undefined } },
    effect: (fn: () => unknown) => fn(),
    on: (event: string, handler: (...args: never[]) => unknown) => { handlers.set(event, handler); return () => undefined },
    logger: { warn: () => undefined },
  }

  const config: Config = { indexPromptBytes: 7000, rulesPromptBytes: 32 * 1024, ruleFileBytes: 16 * 1024 }
  apply(ctx as never, config)

  return {
    sections,
    tools,
    emit: (event, ...args) => { handlers.get(event)?.(...(args as never[])) },
    skillProvider: () => factory?.(control) as { list: (o: unknown) => Promise<readonly { name: string }[]> } | undefined,
  }
}

/** Poll until an asynchronous probe has populated the synchronous cache. */
async function settled(read: () => string, ready: (text: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = read()
    if (ready(text)) return text
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  return read()
}

/**
 * Render one prompt section for the workspace its harness was built for.
 *
 * The agent comes from the harness rather than the module-level fixture: a
 * section renders for whatever workspace the caller names, so a helper that
 * always asked about the fixture would report the fixture's layers no matter
 * which workspace a test had configured.
 */
const section = (sections: readonly Section[] & { readonly agent?: FakeAgent }, name: string): string =>
  sections.find((entry) => entry.name === name)?.text({ agent: sections.agent ?? AGENT }) ?? ''

describe('row wiring', () => {
  it('registers both prompt sections, rules before memory', () => {
    const { sections } = harness()
    expect(sections.map((s) => s.name)).toEqual(['workspace-rules', 'workspace-memory'])
    expect(sections[0]?.order).toBeLessThan(sections[1]?.order ?? 0)
  })

  it('registers the eight tools it documents', () => {
    expect(harness().tools.map((tool) => tool.name)).toEqual([
      'memory_status',
      'memory_read',
      'memory_search',
      'memory_write',
      'memory_promote',
      'memory_help',
      'rule_status',
      'rule_read',
    ])
  })

  it('renders the memory section from the fixture index', async () => {
    const { sections } = harness()
    const text = await settled(
      () => section(sections, 'workspace-memory'),
      (value) => value.includes('二、用户偏好'),
    )
    expect(text).toContain('已检测到 WorkBuddy 体系')
    expect(text).toContain('二、用户偏好')
  })

  it('lists conditional books as untriggered before any file is touched', async () => {
    const { sections } = harness()
    const text = await settled(
      () => section(sections, 'workspace-rules'),
      (value) => value.includes('尚未触发的条件册'),
    )
    expect(text).toContain('## 常驻册')
    expect(text).toContain('01-协作红线.md')
    expect(text).toContain('尚未触发的条件册')
    expect(text).not.toContain('### 10-服务端铁律.md')
  })
})

describe('the rules layer', () => {
  it('injects a conditional book once a matching file is touched', async () => {
    const harnessRef = harness()
    const before = await settled(
      () => section(harnessRef.sections, 'workspace-rules'),
      (value) => value.includes('尚未触发的条件册'),
    )
    expect(before).not.toContain('已触发的条件册')

    harnessRef.emit('tools/result', {
      name: 'read',
      arguments: { file_path: join(WORKSPACE, 'server', 'Service.cs') },
      agent: AGENT,
      signal: new AbortController().signal,
    }, { isError: false })

    const after = await settled(
      () => section(harnessRef.sections, 'workspace-rules'),
      (value) => value.includes('已触发的条件册'),
    )
    expect(after).toContain('已触发的条件册')
    expect(after).toContain('### 10-服务端铁律.md（触发：server/**/*.cs）')
    expect(after).toContain('改动任何 `.cs` 前必读本册。')
  })

  it('ignores a touch that matches no book', async () => {
    const harnessRef = harness()
    await settled(
      () => section(harnessRef.sections, 'workspace-rules'),
      (value) => value.includes('尚未触发的条件册'),
    )

    harnessRef.emit('tools/result', {
      name: 'read',
      arguments: { file_path: join(WORKSPACE, 'README.md') },
      agent: AGENT,
      signal: new AbortController().signal,
    }, { isError: false })
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(section(harnessRef.sections, 'workspace-rules')).not.toContain('已触发的条件册')
  })

  it('ignores a failed tool call', async () => {
    const harnessRef = harness()
    await settled(
      () => section(harnessRef.sections, 'workspace-rules'),
      (value) => value.includes('尚未触发的条件册'),
    )

    harnessRef.emit('tools/result', {
      name: 'read',
      arguments: { file_path: join(WORKSPACE, 'server', 'Service.cs') },
      agent: AGENT,
      signal: new AbortController().signal,
    }, { isError: true })
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(section(harnessRef.sections, 'workspace-rules')).not.toContain('已触发的条件册')
  })

  it('returns a whole book through rule_read, and lists the alternatives when it misses', async () => {
    const { tools } = harness()
    const tool = tools.find((entry) => entry.name === 'rule_read')

    const found = await tool?.execute({ file: '10-服务端铁律.md' }) as { ok: boolean, text: string, kind: string }
    expect(found.ok).toBe(true)
    expect(found.kind).toBe('conditional')
    expect(found.text).toContain('改动任何 `.cs` 前必读本册。')

    const missed = await tool?.execute({ file: 'nope.md' }) as { ok: boolean, available: readonly string[] }
    expect(missed.ok).toBe(false)
    expect(missed.available).toContain('99-按需规则.md')
  })
})

describe('the memory tools', () => {
  it('reads the fixture index and searches it', async () => {
    const { tools } = harness()
    const read = tools.find((entry) => entry.name === 'memory_read')
    const index = await read?.execute({ layer: 'index' }) as { ok: boolean, text: string, exists: boolean }
    expect(index.ok).toBe(true)
    expect(index.exists).toBe(true)
    expect(index.text).toContain('二、用户偏好')

    const search = tools.find((entry) => entry.name === 'memory_search')
    const hits = await search?.execute({ query: '中文沟通' }) as { ok: boolean, totalHits: number }
    expect(hits.ok).toBe(true)
    expect(hits.totalHits).toBeGreaterThan(0)
  })

  it('refuses an entry that looks like a secret', async () => {
    const { tools } = harness()
    const write = tools.find((entry) => entry.name === 'memory_write')
    const verdict = await write?.execute({ content: 'api_key = sk-abcdef1234567890' }) as { ok: boolean, reasons: readonly string[] }
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('密钥')
  })
})

describe('project-level layer switches', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = join(await mkdtemp(join(tmpdir(), 'dsh-layers-')), 'project')
    await mkdir(join(workspace, '.dsh'), { recursive: true })
  })

  afterEach(async () => {
    await rm(dirname(workspace), { recursive: true, force: true })
  })

  /** Write the project switches for this test's workspace. */
  async function configure(text: string): Promise<void> {
    await writeFile(join(workspace, '.dsh', 'workspace.yml'), text, 'utf8')
  }

  /**
   * Force the workspace's switches to be read and cached by calling a tool.
   *
   * The tools await the asynchronous configuration probe, so letting one run to
   * completion is the deterministic way to know the cache is warm. A tool whose
   * own layer is refused still resolves the config first, so `rule_status` — which
   * reports the switches even when a broken file has stopped everything — is the
   * right trigger when the file is expected to be broken.
   */
  async function configured(harnessed: ReturnType<typeof harness>, toolName = 'memory_read'): Promise<void> {
    const tool = harnessed.tools.find((entry) => entry.name === toolName)
    await tool?.execute(toolName === 'rule_status' ? {} : { layer: 'index' })
  }

  it('turns the rules layer off: no section, no trigger, refused tools', async () => {
    const harnessed = harness(workspace)
    await configure('workspace-conventions:\n  rules: false\n')
    await configured(harnessed, 'rule_status')

    expect(section(harnessed.sections, 'workspace-rules')).toBe('')

    harnessed.emit('tools/result', {
      name: 'read',
      arguments: { file_path: join(workspace, 'server', 'x.cs') },
      agent: { session: { header: { cwd: workspace } } },
      signal: new AbortController().signal,
    }, { isError: false })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(section(harnessed.sections, 'workspace-rules')).toBe('')

    const read = harnessed.tools.find((tool) => tool.name === 'rule_read')
    const refused = await read?.execute({ file: 'anything.md' }) as { ok: boolean, error: string }
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('rules 层在本工作区已禁用')
    expect(refused.error).toContain('.dsh/workspace.yml')
  })

  it('keeps every layer on when the file has no section for this plugin', async () => {
    const harnessed = harness(workspace)
    await configure('version: 1\nsome-other-plugin:\n  rules: false\n')
    await configured(harnessed, 'rule_status')

    const status = await harnessed.tools.find((tool) => tool.name === 'rule_status')?.execute({}) as {
      config: { layers: { memory: string, rules: boolean, skills: boolean } }
    }
    expect(status.config.layers).toEqual({ memory: 'enabled', rules: true, skills: true })
  })

  it('memory read-only: no section, writes refused, reads still served', async () => {
    const harnessed = harness(workspace)
    await configure('workspace-conventions:\n  memory: read-only\n')
    await configured(harnessed)

    expect(section(harnessed.sections, 'workspace-memory')).toBe('')

    const write = harnessed.tools.find((tool) => tool.name === 'memory_write')
    const refused = await write?.execute({ content: '第二条跨会话仍有价值的结论。' }) as { ok: boolean, written: boolean, error: string }
    expect(refused.ok).toBe(false)
    expect(refused.written).toBe(false)
    expect(refused.error).toContain('只读')

    // Reading stays available, so a read-only workspace is not a blind one.
    const read = harnessed.tools.find((tool) => tool.name === 'memory_read')
    const status = await read?.execute({ layer: 'index' }) as { ok: boolean }
    expect(status.ok).toBe(true)
  })

  it('memory disabled: the read tools are refused too', async () => {
    const harnessed = harness(workspace)
    await configure('workspace-conventions:\n  memory: disabled\n')
    await configured(harnessed)

    const read = harnessed.tools.find((tool) => tool.name === 'memory_read')
    const refused = await read?.execute({ layer: 'index' }) as { ok: boolean, error: string }
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('memory 层在本工作区已禁用')
  })

  it('skills off: the provider publishes nothing for that workspace', async () => {
    const harnessed = harness(workspace)
    await configure('workspace-conventions:\n  skills: false\n')
    await configured(harnessed, 'rule_status')

    const provider = harnessed.skillProvider()
    expect(await provider?.list({ cwd: workspace })).toEqual([])
    // The fixture workspace keeps its skill, proving the switch is what emptied it.
    expect(await harnessed.skillProvider()?.list({ cwd: WORKSPACE })).toHaveLength(1)
  })

  it('reports a broken file through the refusal and fails the layers closed', async () => {
    const harnessed = harness(workspace)
    await configure('workspace-conventions:\n  memroy: false\n')
    await configured(harnessed, 'rule_status')

    // With every layer stopped, the refusal is the only place the reason can
    // appear, so it has to carry the offending key itself.
    const status = await harnessed.tools.find((tool) => tool.name === 'rule_status')?.execute({}) as {
      ok: boolean
      error: string
      configIssues: readonly string[]
    }
    expect(status.ok).toBe(false)
    expect(status.error).toContain('配置错误')
    expect(status.configIssues.join(' ')).toContain('memroy')
  })
})
