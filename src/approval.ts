/**
 * Which tool calls must obtain a one-time user approval before their body runs.
 *
 * The plugin's own writes fall into two very different blast radii. A workspace
 * memory entry is a project fact in a directory the user can inspect; a GLOBAL
 * memory entry or a persona fragment is injected into every turn of every
 * workspace, which is exactly the kind of write a user should consent to once
 * rather than discover afterwards. DSH already owns the only auditable consent
 * mechanism available to a plugin — the `tools/pre-execute` waterfall, whose
 * `{ kind: 'ask' }` decision is resolved by the approval seam and grants exactly
 * one execution (`allowed-once`). This module is the pure decision half: no
 * services, no config files, no clock, so the branches are testable in isolation
 * and the same answer is produced for the same `(call, policy)`.
 *
 * Deliberately excluded: a layer the workspace has already turned off, or whose
 * global scope it blocks, is not gated. The tool body refuses that call on its
 * own with a message naming the switch, and asking the user to approve a write
 * that is going to fail anyway is noise. The caller passes the resolved switches
 * in, so this module never reads the workspace configuration itself.
 *
 * @module @jinngoo/dsh-workspace-conventions/approval
 */

/** Longest content excerpt carried into an approval prompt; the prompt is UI, not a transcript. */
const DIGEST_CHARS = 60

/** Tools that write the single cross-workspace memory store. */
const GLOBAL_MEMORY_TOOLS: ReadonlySet<string> = new Set(['memory_write', 'memory_promote', 'memory_revise'])

/** The tool that writes persona fragments in either scope. */
const PERSONA_TOOL = 'persona_write'

/** One pending tool call as the pre-execute gate sees it. */
export interface GatedToolCall {
  /** The registered tool name. */
  readonly name: string
  /** Parsed arguments; nothing is schema-validated yet, so every branch is defensive. */
  readonly arguments?: unknown
}

/**
 * The resolved switches the gate needs, all supplied by the caller.
 *
 * The approval switches are the row's own config (`requestGlobalMemoryApproval`,
 * `requestPersonaWriteApproval`); the layer switches come from the workspace's
 * `.dsh/workspace.yml`. Keeping them in one flat object makes the gate total and
 * lets a test exercise any branch without composing a context.
 */
export interface ApprovalPolicy {
  /** Ask before writing the global (cross-workspace) memory scope. */
  readonly globalMemory: boolean
  /** Ask before writing a persona fragment, in either scope. */
  readonly persona: boolean
  /**
   * Whether this call already carries an explicit sandbox-escalation request.
   *
   * An escalation approval (DSH's sandbox seam) asks the user once for "run this
   * single call with wider permissions", which is strictly stronger consent than
   * "may I write this entry". Asking the memory gate on top of it would show two
   * windows for one action, so the escalation owns the consent for that call. The
   * memory gate stays silent and the tool body resolves the grant itself.
   */
  readonly escalation: boolean
  /** Whether the workspace memory layer currently accepts writes. */
  readonly memoryWritable: boolean
  /** Whether this workspace may read/write the global memory scope. */
  readonly inheritMemory: boolean
  /** Whether the persona layer is on for this workspace. */
  readonly personaEnabled: boolean
  /** Whether this workspace may read/write the global persona scope. */
  readonly inheritPersona: boolean
}

/** The approval one call must obtain before its body runs. */
export interface ApprovalRequest {
  /** Audited reason (Chinese, like the rest of this plugin's tool surface); also the UI fallback text. */
  readonly reason: string
  /** Localized approval-prompt text; `en` is mandatory in this harness. */
  readonly displayReason: { readonly en: string; readonly zh: string }
}

/**
 * Decide whether one tool call requires a user approval.
 * @param call - the pending call's name and unvalidated arguments.
 * @param policy - the resolved approval and layer switches.
 * @returns the approval to request, or `undefined` when the call may proceed
 *   straight to the rest of the pre-execute chain.
 */
export function approvalRequestFor(call: GatedToolCall, policy: ApprovalPolicy): ApprovalRequest | undefined {
  // Unrelated tools are never inspected beyond this point; the listener must be
  // total and cheap for the overwhelming majority of calls.
  if (!GLOBAL_MEMORY_TOOLS.has(call.name) && call.name !== PERSONA_TOOL) return undefined
  // An explicit escalation ask owns this call's consent; a second window for the
  // same write would be noise the user has to dismiss twice.
  if (policy.escalation) return undefined

  const args = asRecord(call.arguments)
  if (args === undefined) return undefined
  if (GLOBAL_MEMORY_TOOLS.has(call.name)) return globalMemoryRequest(call.name, args, policy)
  return personaRequest(args, policy)
}

/**
 * The gate for `memory_write` / `memory_promote` with `scope: global`.
 *
 * Scope is read exactly as the tools read it: only the literal string `global`
 * selects the global store, and an absent value means the workspace, so a typo
 * cannot smuggle a cross-workspace write past the gate as an approved
 * workspace write.
 */
function globalMemoryRequest(name: string, args: Record<string, unknown>, policy: ApprovalPolicy): ApprovalRequest | undefined {
  if (name === 'memory_revise') {
    // The revise tool has no `scope` argument: it only ever rewrites the global profile.
    if (!policy.globalMemory || !policy.memoryWritable || !policy.inheritMemory) return undefined
    const content = stringArg(args, 'content')
    if (content === undefined) return undefined
    const digest = digestOf(content)
    return {
      reason: `重写全局记忆（所有工作区共享）：${digest}`,
      displayReason: {
        en: `Rewrite the global memory profile shared by every workspace: "${digest}"`,
        zh: `重写全局记忆（所有工作区共享）：${digest}`,
      },
    }
  }
  if (args['scope'] !== 'global') return undefined
  if (!policy.globalMemory || !policy.memoryWritable || !policy.inheritMemory) return undefined

  if (name === 'memory_write') {
    const content = stringArg(args, 'content')
    if (content === undefined || content.trim().length === 0) return undefined
    const kind = stringArg(args, 'kind')
    const label = kind === undefined ? '默认分类' : kind
    const digest = digestOf(content)
    return {
      reason: `写入全局记忆（${label}）：${digest}`,
      displayReason: {
        en: `Write to the global memory shared by every workspace (${kind ?? 'default kind'}): "${digest}"`,
        zh: `写入全局记忆（所有工作区共享，${label}）：${digest}`,
      },
    }
  }

  if (name === 'memory_revise') {
    const content = stringArg(args, 'content')
    if (content === undefined) return undefined
    const digest = digestOf(content)
    return {
      reason: `重写全局记忆（所有工作区共享）：${digest}`,
      displayReason: {
        en: `Rewrite the global memory profile shared by every workspace: "${digest}"`,
        zh: `重写全局记忆（所有工作区共享）：${digest}`,
      },
    }
  }

  const entry = stringArg(args, 'entry')
  if (entry === undefined || entry.trim().length === 0) return undefined
  const section = stringArg(args, 'section')
  const label = section ?? '未分类'
  const digest = digestOf(entry)
  return {
    reason: `提升到全局记忆索引（${label}）：${digest}`,
    displayReason: {
      en: `Promote a line into the global memory index, injected every turn (section: ${label}): "${digest}"`,
      zh: `提升到全局记忆索引（每轮注入，章节：${label}）：${digest}`,
    },
  }
}

/**
 * The gate for `persona_write`, in both scopes.
 *
 * Persona is injected into every turn of the workspace that owns it, and the
 * global scope makes that true everywhere, so a single mistaken fragment is more
 * expensive than a mistaken memory entry. The workspace layer switch and the
 * inheritance switch still win: a disabled layer refuses instead of asking.
 */
function personaRequest(args: Record<string, unknown>, policy: ApprovalPolicy): ApprovalRequest | undefined {
  if (!policy.persona || !policy.personaEnabled) return undefined
  const scope = args['scope'] === 'global' ? 'global' : 'workspace'
  if (scope === 'global' && !policy.inheritPersona) return undefined

  const name = fragmentName(stringArg(args, 'name'))
  const content = stringArg(args, 'content')
  if (name === undefined || content === undefined || content.trim().length === 0) return undefined
  const mode = args['mode'] === 'append' ? 'append' : 'replace'
  const scopeText = scope === 'global' ? '全局' : '工作区'
  const actionText = mode === 'append' ? '追加' : '替换'
  const digest = digestOf(content)
  return {
    reason: `写入${scopeText}人格片段 ${name}（${actionText}，人格每轮注入）：${digest}`,
    displayReason: {
      en: `${mode === 'append' ? 'Append to' : 'Replace'} the ${scope === 'global' ? 'global persona shared by every workspace' : 'workspace persona'} fragment "${name}", which is injected every turn: "${digest}"`,
      zh: `写入${scopeText}人格片段「${name}」（${actionText}，人格每轮注入）：${digest}`,
    },
  }
}

/** A plain object view of unvalidated arguments, or `undefined` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A non-blank string argument, trimmed; `undefined` when absent or another type. */
function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** The fragment's file stem, normalized the way `persona_write` normalizes it. */
function fragmentName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const stem = raw.replace(/^.*[\\/]/, '').replace(/\.md$/i, '')
  return stem.length > 0 && !stem.startsWith('.') ? stem : undefined
}

/**
 * A single-line excerpt for the approval prompt: whitespace collapsed and cut at
 * a bounded length, so a long entry cannot turn the prompt into a wall of text.
 */
export function digestOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= DIGEST_CHARS ? flat : `${flat.slice(0, DIGEST_CHARS)}…`
}
