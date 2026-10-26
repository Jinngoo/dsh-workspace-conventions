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
  // resolveGlobalRoot 会对入参做 path.resolve：Windows 盘符路径在 POSIX 上是相对路径，
  // 会被拼上 cwd 而永远不等于原值。夹具按平台取绝对路径，两个平台下语义才一致。
  const EXPLICIT_HOME = process.platform === 'win32' ? join('D:', 'custom', 'home') : '/tmp/custom/home'
  const ENV_HOME = process.platform === 'win32' ? join('E:', 'dsh-home') : '/tmp/dsh-home'

  it('prefers an explicit setting', () => {
    expect(resolveGlobalRoot(EXPLICIT_HOME)).toBe(EXPLICIT_HOME)
  })

  it('follows $DSH_HOME when no setting is given, and ~/.dsh otherwise', () => {
    const previous = process.env['DSH_HOME']
    try {
      process.env['DSH_HOME'] = ENV_HOME
      expect(resolveGlobalRoot()).toBe(ENV_HOME)
      expect(resolveGlobalRoot('   ')).toBe(ENV_HOME)

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
