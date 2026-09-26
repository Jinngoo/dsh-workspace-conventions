/**
 * WorkBuddy skill bundles as a native DSH skill provider.
 *
 * WorkBuddy keeps reusable procedures as `<name>/SKILL.md` bundles under
 * `.workbuddy/skills/`. DSH's own local provider only scans `.dsh/skills`,
 * `.agents/skills`, its configured custom directories and the user homes, so
 * those bundles are invisible to it. Registering this provider puts them in the
 * ordinary skill catalog — reachable through the stock `skill` tool, with
 * relative resources resolved against the bundle directory — instead of
 * inventing a second, parallel way to load them.
 *
 * The provider ranks below both project roots so a skill genuinely authored for
 * DSH wins a name collision, and it is workspace-sensitive: `list()` derives its
 * root from the lookup `cwd`, so one registered provider serves every workspace.
 *
 * @module @jinngoo/dsh-workspace-conventions/skills
 */

import { isSkillName, type SkillCandidate, type SkillDefinition, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { join } from 'node:path'

import { frontmatterScalar, parseFrontmatter, readFrontmatterBoolean } from './frontmatter.js'
import { SKILLS_SUBDIR, WORKBUDDY_DIR } from './layout.js'
import { normalizeText, toPosix } from './text.js'

/** Discovery rank: below `project-dsh` (100) and `project-agents` (200), above `custom` (300). */
export const WORKBUDDY_SKILL_RANK = 250

/** Discovery source label carried by every candidate this provider emits. */
export const WORKBUDDY_SKILL_SOURCE = 'workbuddy'

/** Bundle entry file name. */
export const SKILL_FILE_NAME = 'SKILL.md'

/** Workspace-relative skills directory, with `/` separators. */
export const SKILLS_DIR_REL = `${WORKBUDDY_DIR}/${SKILLS_SUBDIR}`

/** One parsed WorkBuddy skill bundle. */
export interface WorkbuddySkill {
  /** Kebab-case name from the bundle's frontmatter. */
  readonly name: string
  /** Routing description from the bundle's frontmatter. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Whether the model-facing catalog includes this skill. */
  readonly modelInvocable: boolean
  /** Whether the human-facing command catalog includes this skill. */
  readonly userInvocable: boolean
  /** Instruction body with the frontmatter block removed. */
  readonly body: string
}

/** The verdict on one bundle source. */
export type SkillParse =
  | { readonly ok: true, readonly skill: WorkbuddySkill }
  | { readonly ok: false, readonly reason: string }

/**
 * Parse one skill bundle source.
 *
 * The invocation keys follow the strict grammar DSH's local provider uses: an
 * unreadable spelling rejects the whole skill rather than quietly permitting a
 * surface the author tried to close. The reason is returned instead of thrown
 * so the caller can name the offending bundle in a log line.
 * @param source - the raw `SKILL.md` text.
 * @returns the parsed skill, or the reason it was rejected.
 */
export function parseSkill(source: string): SkillParse {
  const frontmatter = parseFrontmatter(source)
  if (!frontmatter.present) return { ok: false, reason: '缺少 frontmatter 块' }

  const name = (frontmatterScalar(frontmatter, 'name') ?? '').trim()
  if (name.length === 0) return { ok: false, reason: 'frontmatter 缺少 name' }
  if (!isSkillName(name)) return { ok: false, reason: `name "${name}" 不是 kebab-case` }

  const description = (frontmatterScalar(frontmatter, 'description') ?? '').trim()
  if (description.length === 0) return { ok: false, reason: 'frontmatter 缺少 description' }

  const model = readFrontmatterBoolean(frontmatter, 'disable-model-invocation')
  if (model.kind === 'invalid') return { ok: false, reason: `disable-model-invocation 取值无法识别（${model.raw || '空'}）` }
  const user = readFrontmatterBoolean(frontmatter, 'user-invocable')
  if (user.kind === 'invalid') return { ok: false, reason: `user-invocable 取值无法识别（${user.raw || '空'}）` }

  const whenToUse = (frontmatterScalar(frontmatter, 'whenToUse') ?? '').trim()
  return {
    ok: true,
    skill: {
      name,
      description,
      ...whenToUse.length > 0 ? { whenToUse } : {},
      modelInvocable: model.kind === 'value' ? !model.value : true,
      userInvocable: user.kind === 'value' ? user.value : true,
      body: normalizeText(frontmatter.body),
    },
  }
}

/** Provider-owned handle returned from `list()` and handed back to `get()`. */
export interface WorkbuddySkillLocator {
  /** Absolute path of the bundle's instruction file. */
  readonly path: string
  /** Absolute directory relative resources resolve against. */
  readonly directory: string
}

/** The two filesystem reads this provider needs, kept minimal so it stays testable. */
export interface SkillStoreReader {
  /** List one directory's direct children. */
  list: (dir: string) => Promise<readonly { readonly name: string, readonly type?: string }[]>
  /** Read one file as UTF-8 text, or `undefined` when it is unreadable. */
  read: (path: string) => Promise<string | undefined>
}

/**
 * Build the provider that publishes `<cwd>/.workbuddy/skills` as DSH skills.
 * @param reader - the filesystem reads to use.
 * @param providerName - the unique provider name to register under.
 * @param log - sink for bundles that were found but rejected.
 * @param enabled - whether the layer is on for one workspace; omitted means always on.
 * @returns the provider to hand to `ctx.skills.registerProvider()`.
 */
export function createWorkbuddySkillProvider(
  reader: SkillStoreReader,
  providerName: string,
  log: (message: string) => void,
  enabled: (workspace: string) => boolean = () => true,
): SkillProvider {
  const toCandidate = (skill: WorkbuddySkill, path: string, directory: string): SkillCandidate => ({
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
    source: WORKBUDDY_SKILL_SOURCE,
    provider: providerName,
    path,
    resourceBase: { kind: 'directory', path: directory },
    rank: WORKBUDDY_SKILL_RANK,
    locator: { path, directory } satisfies WorkbuddySkillLocator,
  })

  const load = async (path: string, directory: string): Promise<SkillCandidate | undefined> => {
    const source = await reader.read(path)
    if (source === undefined) return undefined
    const parsed = parseSkill(source)
    if (!parsed.ok) {
      log(`ignored skill bundle ${toPosix(path)}: ${parsed.reason}`)
      return undefined
    }
    return toCandidate(parsed.skill, path, directory)
  }

  return {
    name: providerName,
    async list(options) {
      const workspace = options.cwd
      if (workspace === undefined || workspace.length === 0) return []
      // A workspace whose project file turns this layer off publishes nothing, so
      // the directory is never even scanned.
      if (!enabled(workspace)) return []
      options.signal?.throwIfAborted()
      const root = join(workspace, WORKBUDDY_DIR, SKILLS_SUBDIR)
      const entries = await reader.list(root)
      options.signal?.throwIfAborted()
      const candidates: SkillCandidate[] = []
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        options.signal?.throwIfAborted()
        const isBundle = entry.type === 'directory'
        const isFlat = entry.type === 'file' && entry.name.toLowerCase().endsWith('.md')
        if (!isBundle && !isFlat) continue
        const directory = isBundle ? join(root, entry.name) : root
        const path = isBundle ? join(directory, SKILL_FILE_NAME) : join(root, entry.name)
        const candidate = await load(path, directory)
        if (candidate !== undefined) candidates.push(candidate)
      }
      return candidates.sort((left, right) => left.name.localeCompare(right.name))
    },
    async get(candidate): Promise<SkillDefinition | undefined> {
      const locator = candidate.locator as WorkbuddySkillLocator
      const source = await reader.read(locator.path)
      if (source === undefined) return undefined
      const parsed = parseSkill(source)
      if (!parsed.ok) return undefined
      const { skill } = parsed
      return {
        name: skill.name,
        description: skill.description,
        ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
        invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
        source: WORKBUDDY_SKILL_SOURCE,
        provider: providerName,
        path: locator.path,
        resourceBase: { kind: 'directory', path: locator.directory },
        content: skill.body,
      }
    },
  }
}
