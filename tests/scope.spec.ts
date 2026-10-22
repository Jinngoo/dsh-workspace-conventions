import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_DIR } from '../src/layout.ts'
import {
  globalLayerDir,
  isWithin,
  layerDir,
  resolveGlobalRoot,
  scopeRoot,
  workspaceLayerDir,
} from '../src/scope.ts'

describe('layer directories', () => {
  it('puts workspace layers under <workspace>/.dsh', () => {
    const workspace = join('C:', 'work', 'project')

    expect(workspaceLayerDir(workspace, 'persona')).toBe(join(workspace, DEFAULT_DIR, 'persona'))
    expect(workspaceLayerDir(workspace, 'mood')).toBe(join(workspace, DEFAULT_DIR, 'mood'))
    expect(workspaceLayerDir(workspace, 'rules')).toBe(join(workspace, DEFAULT_DIR, 'rules'))
    expect(workspaceLayerDir(workspace, 'memory')).toBe(join(workspace, DEFAULT_DIR, 'memory'))
  })

  it('puts global layers directly under the global root', () => {
    const root = join('C:', 'home', '.dsh')

    expect(globalLayerDir(root, 'persona')).toBe(join(root, 'persona'))
    expect(globalLayerDir(root, 'memory')).toBe(join(root, 'memory'))
    expect(layerDir(root, 'rules')).toBe(join(root, 'rules'))
  })

  it('resolves a scope root to the workspace store or the global root', () => {
    const workspace = join('C:', 'work', 'project')
    const global = join('C:', 'home', '.dsh')

    expect(scopeRoot('workspace', workspace, global)).toBe(join(workspace, DEFAULT_DIR))
    expect(scopeRoot('global', workspace, global)).toBe(global)
  })
})

describe('the global root', () => {
  it('prefers an explicit setting', () => {
    expect(resolveGlobalRoot(join('D:', 'custom', 'home'))).toBe(join('D:', 'custom', 'home'))
  })

  it('follows $DSH_HOME when no setting is given, and ~/.dsh otherwise', () => {
    const previous = process.env['DSH_HOME']
    try {
      process.env['DSH_HOME'] = join('E:', 'dsh-home')
      expect(resolveGlobalRoot()).toBe(join('E:', 'dsh-home'))
      expect(resolveGlobalRoot('   ')).toBe(join('E:', 'dsh-home'))

      delete process.env['DSH_HOME']
      expect(resolveGlobalRoot()).toContain(DEFAULT_DIR)
      expect(resolveGlobalRoot()).toContain('.dsh')
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })
})

describe('path containment', () => {
  it('accepts the directory itself and anything strictly inside', () => {
    const root = join('C:', 'work', 'project', DEFAULT_DIR)

    expect(isWithin(root, root)).toBe(true)
    expect(isWithin(root, join(root, 'persona', '01-identity.md'))).toBe(true)
  })

  it('rejects siblings that merely share a prefix', () => {
    const root = join('C:', 'work', 'project')

    expect(isWithin(root, join('C:', 'work', 'project-other'))).toBe(false)
    expect(isWithin(root, join('C:', 'work'))).toBe(false)
  })
})
