/**
 * The pure pre-execute approval gate.
 *
 * `approvalRequestFor` is the decision half of the `tools/pre-execute` waterfall:
 * no services, no clock, so every branch is one assertion here. The gate only
 * ever asks for writes whose blast radius is cross-workspace (global memory) or
 * every-turn (persona); everything else must fall straight through.
 */

import { describe, expect, it } from 'vitest'

import {
  approvalRequestFor,
  digestOf,
  type ApprovalPolicy,
  type GatedToolCall,
} from '../src/approval.ts'

/** Every switch on: the branch under test is the only thing that can turn an ask off. */
const OPEN: ApprovalPolicy = {
  globalMemory: true,
  persona: true,
  escalation: false,
  memoryWritable: true,
  inheritMemory: true,
  personaEnabled: true,
  inheritPersona: true,
}

/** The baseline policy with only the named switches flipped. */
const policy = (overrides: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({ ...OPEN, ...overrides })

/** A gated call; omitting the arguments exercises the malformed/absent branch. */
const call = (name: string, args?: unknown): GatedToolCall =>
  args === undefined ? { name } : { name, arguments: args }

/** Collapse whitespace, trim, and cut at 60 chars — the excerpt the prompt may carry. */
const expectedDigest = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 60 ? flat : `${flat.slice(0, 60)}…`
}

/** Long, whitespace-noisy content whose tail deliberately sits past the 60-char cut. */
const LONG_CONTENT = `  第一行   有   多余空白  ${'内容'.repeat(40)}  TAIL-PAST-THE-DIGEST  `
const DIGEST = expectedDigest(LONG_CONTENT)

/** Assert one approval carries the bounded excerpt in all three prompt fields. */
function expectDigest(request: { readonly reason: string, readonly displayReason: { readonly en: string, readonly zh: string } }): void {
  expect(request.reason).toContain(DIGEST)
  expect(request.displayReason.en).toContain(DIGEST)
  expect(request.displayReason.zh).toContain(DIGEST)
  expect(request.displayReason.en.length).toBeGreaterThan(0)
  expect(request.displayReason.zh.length).toBeGreaterThan(0)
}

describe('digestOf', () => {
  it('collapses whitespace and trims', () => {
    expect(digestOf('  a\n\tb   c  ')).toBe('a b c')
  })

  it('keeps text up to the 60-char budget intact', () => {
    const sixty = 'x'.repeat(60)
    expect(digestOf(sixty)).toBe(sixty)
  })

  it('truncates past 60 chars with a single ellipsis', () => {
    expect(digestOf('x'.repeat(61))).toBe(`${'x'.repeat(60)}…`)
    expect(digestOf(LONG_CONTENT)).toBe(DIGEST)
    expect(digestOf(LONG_CONTENT)).not.toContain('TAIL-PAST-THE-DIGEST')
  })
})

describe('the global memory gate', () => {
  it('asks before a global memory_write, with the content digest in every prompt field', () => {
    const request = approvalRequestFor(call('memory_write', { scope: 'global', content: LONG_CONTENT }), policy())
    expect(request).toBeDefined()
    expectDigest(request as NonNullable<typeof request>)
  })

  it('asks before a global memory_promote, with the entry digest in every prompt field', () => {
    const request = approvalRequestFor(call('memory_promote', { scope: 'global', entry: LONG_CONTENT, section: '约束与红线' }), policy())
    expect(request).toBeDefined()
    expectDigest(request as NonNullable<typeof request>)
  })

  it('asks before a global memory_revise, with the rewrite digest', () => {
    const request = approvalRequestFor(call('memory_revise', { content: LONG_CONTENT }), policy())
    expect(request).toBeDefined()
    expectDigest(request as NonNullable<typeof request>)
  })

  it('does not ask when the call already carries an escalation request', () => {
    const escalation = policy({ escalation: true })
    expect(approvalRequestFor(call('memory_write', { scope: 'global', content: LONG_CONTENT }), escalation)).toBeUndefined()
    expect(approvalRequestFor(call('memory_revise', { content: LONG_CONTENT }), escalation)).toBeUndefined()
    expect(approvalRequestFor(call('persona_write', { name: '02-voice', content: LONG_CONTENT }), escalation)).toBeUndefined()
  })

  it('does not ask for a workspace-scoped memory_write', () => {
    expect(approvalRequestFor(call('memory_write', { scope: 'workspace', content: '项目事实' }), policy())).toBeUndefined()
  })

  it('does not ask for a workspace-scoped memory_promote', () => {
    expect(approvalRequestFor(call('memory_promote', { scope: 'workspace', entry: '项目事实' }), policy())).toBeUndefined()
  })

  it('does not ask when scope is absent (the tools default to the workspace)', () => {
    expect(approvalRequestFor(call('memory_write', { content: '项目事实' }), policy())).toBeUndefined()
    expect(approvalRequestFor(call('memory_promote', { entry: '项目事实' }), policy())).toBeUndefined()
  })

  it('does not ask when the global-memory approval flag is off', () => {
    const args = { scope: 'global', content: LONG_CONTENT }
    expect(approvalRequestFor(call('memory_write', args), policy({ globalMemory: false }))).toBeUndefined()
    expect(approvalRequestFor(call('memory_promote', { scope: 'global', entry: LONG_CONTENT }), policy({ globalMemory: false }))).toBeUndefined()
  })

  it('does not ask when the memory layer is not writable', () => {
    const args = { scope: 'global', content: LONG_CONTENT }
    expect(approvalRequestFor(call('memory_write', args), policy({ memoryWritable: false }))).toBeUndefined()
    expect(approvalRequestFor(call('memory_promote', { scope: 'global', entry: LONG_CONTENT }), policy({ memoryWritable: false }))).toBeUndefined()
  })

  it('does not ask when the workspace blocks global memory inheritance', () => {
    const args = { scope: 'global', content: LONG_CONTENT }
    expect(approvalRequestFor(call('memory_write', args), policy({ inheritMemory: false }))).toBeUndefined()
    expect(approvalRequestFor(call('memory_promote', { scope: 'global', entry: LONG_CONTENT }), policy({ inheritMemory: false }))).toBeUndefined()
  })

  it('does not ask when the required content is missing or blank', () => {
    for (const content of [undefined, '', '   \n\t ']) {
      expect(approvalRequestFor(call('memory_write', { scope: 'global', content }), policy())).toBeUndefined()
    }
  })

  it('does not ask when the required entry is missing or blank', () => {
    for (const entry of [undefined, '', '   ']) {
      expect(approvalRequestFor(call('memory_promote', { scope: 'global', entry }), policy())).toBeUndefined()
    }
  })

  it('does not ask when a required argument is not a string', () => {
    expect(approvalRequestFor(call('memory_write', { scope: 'global', content: 42 }), policy())).toBeUndefined()
    expect(approvalRequestFor(call('memory_promote', { scope: 'global', entry: ['x'] }), policy())).toBeUndefined()
  })

  it('does not ask when the arguments are malformed', () => {
    for (const args of [undefined, null, 'global', 42, []]) {
      expect(approvalRequestFor(call('memory_write', args), policy())).toBeUndefined()
      expect(approvalRequestFor(call('memory_promote', args), policy())).toBeUndefined()
    }
  })
})

describe('the persona gate', () => {
  it('asks before a workspace persona_write, naming the fragment and the digest', () => {
    const request = approvalRequestFor(call('persona_write', { scope: 'workspace', name: '02-voice', content: LONG_CONTENT }), policy())
    expect(request).toBeDefined()
    expect(request?.reason).toContain('02-voice')
    expect(request?.displayReason.en).toContain('02-voice')
    expect(request?.displayReason.zh).toContain('02-voice')
    expectDigest(request as NonNullable<typeof request>)
  })

  it('asks before a global persona_write when inheritance is allowed', () => {
    const request = approvalRequestFor(call('persona_write', { scope: 'global', name: '02-voice', content: LONG_CONTENT }), policy())
    expect(request).toBeDefined()
    expect(request?.reason).toContain('02-voice')
    expectDigest(request as NonNullable<typeof request>)
  })

  it('defaults an absent scope to the workspace and still asks', () => {
    const request = approvalRequestFor(call('persona_write', { name: '02-voice', content: LONG_CONTENT }), policy())
    expect(request).toBeDefined()
    expect(request?.reason).toContain('02-voice')
  })

  it('does not ask for a global persona_write when inheritance is blocked', () => {
    const args = { scope: 'global', name: '02-voice', content: LONG_CONTENT }
    expect(approvalRequestFor(call('persona_write', args), policy({ inheritPersona: false }))).toBeUndefined()
  })

  it('still asks for a workspace persona_write when global inheritance is blocked', () => {
    const args = { scope: 'workspace', name: '02-voice', content: LONG_CONTENT }
    expect(approvalRequestFor(call('persona_write', args), policy({ inheritPersona: false }))).toBeDefined()
  })

  it('does not ask when the persona approval flag is off, in either scope', () => {
    const off = policy({ persona: false })
    expect(approvalRequestFor(call('persona_write', { scope: 'workspace', name: '02-voice', content: 'x' }), off)).toBeUndefined()
    expect(approvalRequestFor(call('persona_write', { scope: 'global', name: '02-voice', content: 'x' }), off)).toBeUndefined()
  })

  it('does not ask when the persona layer is off', () => {
    const off = policy({ personaEnabled: false })
    expect(approvalRequestFor(call('persona_write', { scope: 'workspace', name: '02-voice', content: 'x' }), off)).toBeUndefined()
    expect(approvalRequestFor(call('persona_write', { scope: 'global', name: '02-voice', content: 'x' }), off)).toBeUndefined()
  })

  it('does not ask when the fragment name or content is missing or blank', () => {
    for (const args of [
      { scope: 'workspace', content: 'x' },
      { scope: 'workspace', name: '', content: 'x' },
      { scope: 'workspace', name: '   ', content: 'x' },
      { scope: 'workspace', name: '02-voice' },
      { scope: 'workspace', name: '02-voice', content: '' },
      { scope: 'workspace', name: '02-voice', content: ' \n ' },
    ]) {
      expect(approvalRequestFor(call('persona_write', args), policy())).toBeUndefined()
    }
  })

  it('does not ask when the arguments are malformed', () => {
    for (const args of [undefined, null, 'persona', 42, []]) {
      expect(approvalRequestFor(call('persona_write', args), policy())).toBeUndefined()
    }
  })
})

describe('unrelated tools', () => {
  it('never asks, even with every switch on', () => {
    for (const name of ['read', 'memory_read', 'memory_search', 'mood_set', 'rule_read', 'self_status', 'persona_read']) {
      expect(approvalRequestFor(call(name, { scope: 'global', content: 'x' }), policy())).toBeUndefined()
    }
  })
})
