/**
 * End-to-end wiring: drive the real `apply()` against the on-disk fixture.
 *
 * Everything else in this suite tests pure functions. This file is the only
 * place that proves the row actually registers what it claims — two prompt
 * sections in the right order, eight tools, one skill provider, and a
 * `tools/result` listener that turns a file touch into a rule injection.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

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
function harness(): {
  sections: Section[]
  tools: FakeTool[]
  emit: (event: string, ...args: unknown[]) => void
  skillProvider: () => { list: (o: unknown) => Promise<readonly { name: string }[]> } | undefined
} {
  const sections: Section[] = []
  const tools: FakeTool[] = []
  const handlers = new Map<string, (...args: never[]) => unknown>()
  let factory: ((control: unknown) => unknown) | undefined
  const control = { invalidate: () => undefined, signal: new AbortController().signal }

  const ctx = {
    fs: {
      resolve: async (path: string) => ({ path, displayPath: path }),
      stat: async (target: { path: string }) => {
        try {
          const info = await stat(target.path)
          return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
        } catch { return undefined }
      },
      readText: async (target: { path: string }) => await readFile(target.path, 'utf8'),
      listDir: async (target: { path: string }) => (await readdir(target.path, { withFileTypes: true }))
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
    },
    agents: { currentInitiator: () => AGENT },
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

const section = (sections: readonly Section[], name: string): string =>
  sections.find((entry) => entry.name === name)?.text({ agent: AGENT }) ?? ''

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

  it('registers exactly one skill provider', () => {
    expect(harness().skillProvider()).toBeDefined()
  })
})

describe('discovery against the fixture workspace', () => {
  it('detects the WorkBuddy memory store and injects its index', async () => {
    const { sections } = harness()
    const text = await settled(
      () => section(sections, 'workspace-memory'),
      (value) => value.includes('已检测到 WorkBuddy 体系'),
    )
    expect(text).toContain('生效后端：workbuddy（兼容模式）')
    expect(text).toContain('工作区：')
    expect(text).toContain('二、用户偏好')
    expect(text).toContain('2026-09-24.md')
  })

  it('injects the always book and lists the conditional ones', async () => {
    const { sections } = harness()
    const text = await settled(
      () => section(sections, 'workspace-rules'),
      (value) => value.includes('禁止无证据猜测根因'),
    )
    expect(text).toContain('## 常驻册')
    expect(text).toContain('### 01-协作红线.md')
    expect(text).toContain('## 尚未触发的条件册（读写匹配文件后自动注入）')
    expect(text).toContain('`10-服务端铁律.md` ← server/**/*.cs')
    expect(text).toContain('`12-错误码约定.md` ← **/*ErrCode*.{cs,ts}、**/*ErrMsg*.{cs,ts}')
    expect(text).toContain('## 按需规则')
    expect(text).toContain('`99-按需规则.md`')
    // A conditional book is listed, never injected before it is triggered.
    expect(text).not.toContain('改动任何 `.cs` 前必读本册。')
  })

  it('keeps the rules section inside its byte budget', async () => {
    const { sections } = harness()
    const text = await settled(() => section(sections, 'workspace-rules'), (value) => value.length > 0)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024)
  })

  it('publishes the fixture skill bundle to the native catalog', async () => {
    const provider = harness().skillProvider()
    const candidates = await provider?.list({ cwd: WORKSPACE })
    expect(candidates?.map((candidate) => candidate.name)).toEqual(['fixture-skill'])
  })
})

describe('touch-driven rule triggering', () => {
  const touch = (path: string): void => {
    harnessRef.emit('tools/result', {
      name: 'read',
      arguments: { file_path: path },
      agent: AGENT,
      signal: new AbortController().signal,
    }, { isError: false })
  }

  let harnessRef: ReturnType<typeof harness>

  it('injects a conditional book once a matching file is touched', async () => {
    harnessRef = harness()
    const before = await settled(
      () => section(harnessRef.sections, 'workspace-rules'),
      (value) => value.includes('尚未触发的条件册（读写匹配文件后自动注入）'),
    )
    expect(before).not.toContain('改动任何 `.cs` 前必读本册。')

    touch(join(WORKSPACE, 'server', 'Service.cs'))
    const after = await settled(
      () => section(harnessRef.sections, 'workspace-rules'),
      (value) => value.includes('已触发的条件册'),
    )
    expect(after).toContain('### 10-服务端铁律.md（触发：server/**/*.cs）')
    expect(after).toContain('改动任何 `.cs` 前必读本册。')
    // A triggered book moves out of the pending listing.
    expect(after).not.toContain('`10-服务端铁律.md` ←')
  })

  it('leaves the section alone for an unrelated file', async () => {
    harnessRef = harness()
    await settled(
      () => section(harnessRef.sections, 'workspace-rules'),
      (value) => value.includes('禁止无证据猜测根因'),
    )
    touch(join(WORKSPACE, 'docs', 'readme.md'))
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(section(harnessRef.sections, 'workspace-rules')).not.toContain('已触发的条件册')
  })

  it('ignores a failed tool result and a path outside the workspace', async () => {
    harnessRef = harness()
    await settled(
      () => section(harnessRef.sections, 'workspace-rules'),
      (value) => value.includes('禁止无证据猜测根因'),
    )
    harnessRef.emit('tools/result', {
      name: 'read',
      arguments: { file_path: join(WORKSPACE, 'server', 'Service.cs') },
      agent: AGENT,
      signal: new AbortController().signal,
    }, { isError: true })
    harnessRef.emit('tools/result', {
      name: 'read',
      arguments: { file_path: join(WORKSPACE, '..', 'outside.cs') },
      agent: AGENT,
      signal: new AbortController().signal,
    }, { isError: false })
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(section(harnessRef.sections, 'workspace-rules')).not.toContain('已触发的条件册')
  })
})

describe('the rules tools', () => {
  it('reports the fixture inventory through rule_status', async () => {
    const { tools } = harness()
    const tool = tools.find((entry) => entry.name === 'rule_status')
    const report = await tool?.execute({}) as {
      total: number
      exists: boolean
      books: readonly { file: string, kind: string, paths: readonly string[] }[]
    }
    expect(report.exists).toBe(true)
    expect(report.total).toBe(4)
    expect(report.books.map((book) => [book.file, book.kind])).toEqual([
      ['01-协作红线.md', 'always'],
      ['10-服务端铁律.md', 'conditional'],
      ['12-错误码约定.md', 'conditional'],
      ['99-按需规则.md', 'on-demand'],
    ])
    expect(report.books[1]?.paths).toEqual(['server/**/*.cs'])
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
