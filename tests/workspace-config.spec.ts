import { describe, expect, it } from 'vitest'

import {
  CONFIG_SECTION,
  DEFAULT_LAYERS,
  WORKSPACE_CONFIG_REL,
  WORKSPACE_CONFIG_TEMPLATE,
  ensureWorkspaceConfig,
  isMemoryReadable,
  isMemoryWritable,
  readWorkspaceConfig,
  type ConfigReader,
} from '../src/workspace-config.ts'

const WORKSPACE = 'C:\\work\\project'

/** A reader over one in-memory file, plus whatever else the test wants to see. */
function reader(contents: string | undefined, options: { readonly unreadable?: boolean } = {}): ConfigReader {
  return {
    stat: async (path) => path.endsWith('workspace.yml') && contents !== undefined,
    read: async () => (options.unreadable === true ? undefined : contents),
  }
}

const layersOf = (text: string) => readWorkspaceConfig(reader(text), WORKSPACE)

describe('an unconfigured workspace', () => {
  it('defaults every layer on', async () => {
    const config = await readWorkspaceConfig(reader(undefined), WORKSPACE)

    expect(config.exists).toBe(false)
    expect(config.issues).toEqual([])
    expect(config.layers).toEqual(DEFAULT_LAYERS)
    expect(config.rel).toBe(WORKSPACE_CONFIG_REL)
    expect(config.rel).toBe('.dsh/workspace.yml')
  })
})

describe('the layer switches', () => {
  it('reads a plugin section that turns one layer off', async () => {
    const config = await layersOf(['workspace-conventions:', '  rules: false'].join('\n'))

    expect(config.issues).toEqual([])
    expect(config.layers.rules).toBe(false)
    expect(config.layers.memory).toBe('enabled')
    expect(config.layers.skills).toBe(true)
  })

  it('applies the shared `layers` section to every plugin', async () => {
    const config = await layersOf(['layers:', '  rules: false', '  skills: false'].join('\n'))

    expect(config.issues).toEqual([])
    expect(config.layers).toEqual({ memory: 'enabled', rules: false, skills: false, memoryLayout: 'auto' })
  })

  it('lets the plugin section win over the shared section', async () => {
    const config = await layersOf(
      ['layers:', '  rules: false', 'workspace-conventions:', '  rules: true'].join('\n'),
    )

    expect(config.issues).toEqual([])
    expect(config.layers.rules).toBe(true)
  })

  it('ignores a section belonging to another plugin', async () => {
    const config = await layersOf(['some-other-plugin:', '  whatever: false'].join('\n'))

    expect(config.issues).toEqual([])
    expect(config.layers).toEqual(DEFAULT_LAYERS)
    expect(config.sections?.['some-other-plugin']).toEqual({ whatever: false })
  })
})

describe('the memory layer has three states', () => {
  it('accepts the read-only spelling', async () => {
    const config = await layersOf(['workspace-conventions:', '  memory: read-only'].join('\n'))

    expect(config.issues).toEqual([])
    expect(config.layers.memory).toBe('read-only')
    expect(isMemoryReadable(config.layers.memory)).toBe(true)
    expect(isMemoryWritable(config.layers.memory)).toBe(false)
  })

  it('accepts booleans as the on and off spellings', async () => {
    expect((await layersOf('workspace-conventions:\n  memory: false\n')).layers.memory).toBe('disabled')
    expect((await layersOf('workspace-conventions:\n  memory: true\n')).layers.memory).toBe('enabled')
  })

  it('accepts the explicit state names', async () => {
    expect((await layersOf('workspace-conventions:\n  memory: disabled\n')).layers.memory).toBe('disabled')
    expect((await layersOf('workspace-conventions:\n  memory: enabled\n')).layers.memory).toBe('enabled')
  })

  it('treats disabled as neither readable nor writable', async () => {
    const config = await layersOf('workspace-conventions:\n  memory: disabled\n')

    expect(isMemoryReadable(config.layers.memory)).toBe(false)
    expect(isMemoryWritable(config.layers.memory)).toBe(false)
  })
})

describe('a typo is reported, never ignored', () => {
  it('reports an unknown key inside the plugin section and stops every layer', async () => {
    const config = await layersOf(['workspace-conventions:', '  memroy: false'].join('\n'))

    expect(config.issues).toHaveLength(1)
    expect(config.issues[0]?.message).toContain('memroy')
    expect(config.issues[0]?.message).toContain('unknown key')
    // A typo must not leave the intended switch silently inert, so the file is
    // treated as broken rather than as "the keys it did understand plus defaults".
    expect(config.layers).toEqual({ memory: 'disabled', rules: false, skills: false, memoryLayout: 'auto' })
  })

  it('reports a non-boolean switch and stops every layer', async () => {
    const config = await layersOf(['workspace-conventions:', '  rules: sometimes'].join('\n'))

    expect(config.issues).toHaveLength(1)
    expect(config.issues[0]?.message).toContain('rules')
    expect(config.issues[0]?.message).toContain('true or false')
    expect(config.layers).toEqual({ memory: 'disabled', rules: false, skills: false, memoryLayout: 'auto' })
  })

  it('reports an unusable memory value with the accepted spellings', async () => {
    const config = await layersOf(['workspace-conventions:', '  memory: maybe'].join('\n'))

    expect(config.issues).toHaveLength(1)
    expect(config.issues[0]?.message).toContain('read-only')
  })

  it('reports a section that is not a mapping', async () => {
    const config = await layersOf('workspace-conventions: 1\n')

    expect(config.issues).toHaveLength(1)
    expect(config.issues[0]?.message).toContain('mapping')
  })

  it('reports a version this plugin does not understand', async () => {
    const config = await layersOf(['version: 2', 'workspace-conventions:', '  rules: false'].join('\n'))

    expect(config.issues).toHaveLength(1)
    expect(config.issues[0]?.message).toContain('version: 2')
    expect(config.issues[0]?.message).toContain('understands (1)')
    // The switches it does understand still resolve.
    expect(config.layers.rules).toBe(false)
  })

  it('accepts the version this plugin understands', async () => {
    const config = await layersOf(['version: 1', 'workspace-conventions:', '  rules: false'].join('\n'))

    expect(config.issues).toEqual([])
  })
})

describe('a broken file fails the layers closed', () => {
  it('disables every layer when the file cannot be parsed', async () => {
    const config = await layersOf(['workspace-conventions:', '  rules: [true]'].join('\n'))

    expect(config.exists).toBe(true)
    expect(config.issues.length).toBeGreaterThan(0)
    expect(config.issues[0]?.message).toContain('not valid configuration')
    expect(config.layers).toEqual({ memory: 'disabled', rules: false, skills: false, memoryLayout: 'auto' })
  })

  it('disables every layer when the file exists but cannot be read', async () => {
    const config = await readWorkspaceConfig(reader('ignored', { unreadable: true }), WORKSPACE)

    expect(config.exists).toBe(true)
    expect(config.issues[0]?.message).toContain('could not be read')
    expect(config.layers).toEqual({ memory: 'disabled', rules: false, skills: false, memoryLayout: 'auto' })
  })

  it('names the offending line when the file is malformed YAML', async () => {
    const config = await layersOf(['workspace-conventions:', '  memory: x', '\tmemory: y'].join('\n'))

    expect(config.issues[0]?.message).toContain('line 3')
  })
})

describe('the file is a reusable container', () => {
  it('exposes the raw document so another plugin can read its own section', async () => {
    const config = await layersOf(
      ['version: 1', 'other-plugin:', '  mode: strict', '  flags:', '    - a', '    - b'].join('\n'),
    )

    expect(config.sections?.['version']).toBe(1)
    expect(config.sections?.['other-plugin']).toEqual({ mode: 'strict', flags: ['a', 'b'] })
  })

  it('tolerates comments and blank lines', async () => {
    const config = await layersOf(
      ['# project switches', '', 'version: 1', '', '# memory is handled elsewhere', `${CONFIG_SECTION}:`, '  skills: false'].join('\n'),
    )

    expect(config.issues).toEqual([])
    expect(config.layers.skills).toBe(false)
  })

  it('keeps the memory layer out of defaults when only skills is configured', async () => {
    const config = await layersOf('workspace-conventions:\n  skills: false\n')

    expect(config.layers).toEqual({ memory: 'enabled', rules: true, skills: false, memoryLayout: 'auto' })
  })
})

describe('the memory layout preference', () => {
  it('accepts the three spellings', async () => {
    expect((await layersOf('workspace-conventions:\n  memoryLayout: flat\n')).layers.memoryLayout).toBe('flat')
    expect((await layersOf('workspace-conventions:\n  memoryLayout: host\n')).layers.memoryLayout).toBe('host')
    expect((await layersOf('workspace-conventions:\n  memoryLayout: auto\n')).layers.memoryLayout).toBe('auto')
  })

  it('reports an unusable value with the accepted spellings and stops every layer', async () => {
    const config = await layersOf('workspace-conventions:\n  memoryLayout: by-computer\n')

    expect(config.issues).toHaveLength(1)
    expect(config.issues[0]?.message).toContain('auto')
    expect(config.layers).toEqual({ memory: 'disabled', rules: false, skills: false, memoryLayout: 'auto' })
  })
})

describe('seeding a workspace that has no file', () => {
  it('writes the starter template and reports that it did', async () => {
    const written: { path: string, text: string }[] = []
    const result = await ensureWorkspaceConfig(
      reader(undefined),
      async (path, text) => { written.push({ path, text }) },
      WORKSPACE,
    )

    expect(result.created).toBe(true)
    expect(result.exists).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0]?.path.endsWith('workspace.yml')).toBe(true)
    expect(written[0]?.text).toBe(WORKSPACE_CONFIG_TEMPLATE)
  })

  it('creates the containing directory first, because `.dsh` usually does not exist', async () => {
    const made: string[] = []
    const result = await ensureWorkspaceConfig(
      { ...reader(undefined), mkdir: async (path) => { made.push(path) } },
      async () => undefined,
      WORKSPACE,
    )

    expect(result.created).toBe(true)
    expect(made).toHaveLength(1)
    expect(made[0]?.endsWith('.dsh')).toBe(true)
    expect(made[0]?.endsWith('workspace.yml')).toBe(false)
  })

  it('never touches a file that is already there', async () => {
    const written: string[] = []
    const result = await ensureWorkspaceConfig(
      reader('workspace-conventions:\n  rules: false\n'),
      async (path) => { written.push(path) },
      WORKSPACE,
    )

    expect(result.created).toBe(false)
    expect(result.exists).toBe(true)
    expect(written).toEqual([])
  })

  it('reports a refused write instead of failing the turn', async () => {
    const result = await ensureWorkspaceConfig(
      reader(undefined),
      async () => { throw new Error('sandbox denied') },
      WORKSPACE,
    )

    expect(result.created).toBe(false)
    expect(result.exists).toBe(false)
  })

  it('leaves every layer on once the template is read back', async () => {
    // The template must be inert: created files cannot change behaviour.
    const config = await readWorkspaceConfig(reader(WORKSPACE_CONFIG_TEMPLATE), WORKSPACE)

    expect(config.issues).toEqual([])
    expect(config.layers).toEqual(DEFAULT_LAYERS)
  })

  it('keeps the template short enough to read and entirely inert', () => {
    const lines = WORKSPACE_CONFIG_TEMPLATE.trimEnd().split('\n')

    // A starter file long enough to scroll past is one nobody reads.
    expect(lines.length).toBeLessThanOrEqual(20)
    // Nothing but comments, so creating the file can never change behaviour.
    expect(lines.every((line) => line.trimStart().startsWith('#'))).toBe(true)
    // Every switch the plugin understands is discoverable from the file itself.
    for (const key of ['version', 'layers', 'memory', 'rules', 'skills', 'memoryLayout']) {
      expect(WORKSPACE_CONFIG_TEMPLATE).toContain(key)
    }
  })
})
