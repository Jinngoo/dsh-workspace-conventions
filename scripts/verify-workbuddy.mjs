// Verify the built row against a real WorkBuddy project, outside DSH.
//
// Usage:  node scripts/verify-workbuddy.mjs <workspace> [rulesPromptBytes]
//         node scripts/verify-workbuddy.mjs <workspace> --profile [--profile-dir <dir>]
//
// This drives the real `apply()` with the six injected services stubbed over the
// host filesystem, then reports what each layer would contribute for that
// workspace. It is the fastest way to check compatibility against a project whose
// `.workbuddy/` you did not write, without restarting DSH.
//
// Two modes decide the rules budget:
//
//   explicit   a positional byte count is the budget. Pass a small one to watch
//              the degraded-pointer path. This is the only way to probe a budget
//              that is not the one on disk.
//   --profile  the budget is resolved from the bundle patch plus the profile
//              patch that overrides it, exactly as the loader resolves it, so the
//              probe reports what this machine actually runs. A profile whose
//              override id no longer matches is therefore caught here too rather
//              than silently probing a stale default.
//
// Exit status is non-zero when a triggered book is neither injected nor reachable
// by name, or when the section exceeds its budget.
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// The row lives in the built output, and `lib/` is not committed, so a fresh
// checkout fails here before anything else — say so instead of letting the import
// report a missing module.
if (!existsSync(new URL('../lib/index.js', import.meta.url))) {
  console.error('lib/index.js is missing: run `pnpm build` first (lib/ is not committed)')
  process.exit(2)
}

const { expandBraces, matchGlob } = await import('../lib/glob.js')
const { defaultProfileDir, readPatchFile, resolveRow } = await import('../lib/patch.js')

const ROW_ID = 'workspace-conventions'
const BUNDLE_PATCH = 'cordis.patch.yml'

const argv = process.argv.slice(2)
const workspace = argv[0]
if (workspace === undefined || workspace.startsWith('--')) {
  console.error('usage: node scripts/verify-workbuddy.mjs <workspace> [rulesPromptBytes | --profile [--profile-dir <dir>]]')
  process.exit(2)
}

const flags = { profile: false, profileDir: defaultProfileDir() }
const positional = []
for (let at = 1; at < argv.length; at += 1) {
  const flag = argv[at]
  if (flag === '--profile') flags.profile = true
  else if (flag === '--profile-dir') {
    at += 1
    const value = argv[at]
    if (value === undefined) {
      console.error('--profile-dir needs a directory')
      process.exit(2)
    }
    flags.profileDir = value
  } else if (flag.startsWith('--')) {
    console.error(`unknown argument \`${flag}\``)
    process.exit(2)
  } else positional.push(flag)
}

const requested = positional[0] === undefined ? undefined : Number(positional[0])
if (requested !== undefined && !Number.isFinite(requested)) {
  console.error(`rulesPromptBytes must be a number, got \`${positional[0]}\``)
  process.exit(2)
}

const budget = requested ?? (flags.profile ? await resolveProfileBudget() : 48 * 1024)
const failures = []

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const AGENT = { session: { header: { cwd: workspace } } }
const sections = []
const tools = []
const handlers = new Map()
let factory

const ctx = {
  fs: {
    resolve: async (path) => ({ path, displayPath: path }),
    stat: async (target) => {
      try {
        const info = await stat(target.path)
        return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
      } catch { return undefined }
    },
    readText: async (target) => await readFile(target.path, 'utf8'),
    listDir: async (target) => (await readdir(target.path, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
  },
  agents: { currentInitiator: () => AGENT },
  systemPrompt: { context: (section) => { sections.push(section); return () => undefined } },
  sandboxPolicy: { resolve: () => undefined },
  tools: { register: (tool) => { tools.push(tool); return () => undefined } },
  skills: { registerProvider: (create) => { factory = create; return () => undefined } },
  effect: (fn) => fn(),
  on: (event, handler) => { handlers.set(event, handler); return () => undefined },
  logger: { warn: (message) => console.log('WARN', message) },
}

apply(ctx, { indexPromptBytes: 7000, rulesPromptBytes: budget, ruleFileBytes: 16384 })

const render = (name) => sections.find((s) => s.name === name)?.text({ agent: AGENT }) ?? ''
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (predicate) => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await wait(20)
}

await settle(() => render('workspace-rules').includes('常驻册'))

const status = await tools.find((t) => t.name === 'rule_status').execute({})
console.log('=== memory ===')
console.log(render('workspace-memory').split('\n')[0])
console.log('=== rules ===')
console.log('dir      :', status.rulesDir, status.exists ? '(exists)' : '(missing)')
console.log('books    :', status.total)
for (const book of status.books) {
  console.log(`  ${book.kind.padEnd(11)} ${String(book.bytes).padStart(6)}B  ${book.file}${book.paths.length > 0 ? `  ← ${book.paths.join('、')}` : ''}${book.issue === '' ? '' : `  [${book.issue}]`}`)
}
const before = render('workspace-rules')
console.log('injected :', Buffer.byteLength(before, 'utf8'), 'bytes')
for (const book of status.books) {
  // The book heading appears only when its body was injected; the listing spells
  // the file name in backticks instead.
  console.log(`  ${before.includes(`### ${book.file}`) ? 'IN ' : 'off'}  ${book.file}`)
}

console.log('=== skills ===')
const provider = factory({ invalidate: () => undefined, signal: new AbortController().signal })
const candidates = await provider.list({ cwd: workspace })
console.log('candidates:', candidates.length)
for (const candidate of candidates) console.log(`  ${candidate.name}@${candidate.rank}  ${candidate.description.slice(0, 48)}…`)

// Trigger every conditional book, which is the case that stresses the section
// budget: with several books live at once, a book that does not fit must still
// be reachable rather than vanish.
const conditional = status.books.filter((book) => book.kind === 'conditional')
if (conditional.length > 0) {
  console.log('=== trigger every conditional book ===')
  for (const book of conditional) {
    const sample = sampleFor(book.paths)
    if (sample === undefined) {
      failures.push(`${book.file}: no path could be derived for its trigger glob(s) ${JSON.stringify(book.paths)}, so this book was never exercised`)
      continue
    }

    console.log(`touch  : ${sample}  (${book.file})`)
    handlers.get('tools/result')({
      name: 'read',
      arguments: { file_path: join(workspace, sample) },
      agent: AGENT,
      signal: new AbortController().signal,
    }, { isError: false })
    await settle(() => render('workspace-rules').includes('已触发的条件册'))
  }

  const after = render('workspace-rules')
  console.log(`injected: ${Buffer.byteLength(after, 'utf8')} bytes (budget ${budget})`)
  const final = await tools.find((t) => t.name === 'rule_status').execute({})
  const statusOf = (file) => {
    const at = after.indexOf(`### ${file}`)
    if (at === -1) return after.includes(file) ? 'NAME' : 'LOST'
    const next = after.indexOf('\n### ', at + 1)
    const block = next === -1 ? after.slice(at) : after.slice(at, next)
    return block.includes('本册正文超出本轮注入预算') ? 'PTR' : 'FULL'
  }
  for (const book of final.books) {
    const verdict = statusOf(book.file)
    console.log(`  ${verdict}  ${book.file}`)
    if (verdict === 'LOST') failures.push(`${book.file}: not injected and not named anywhere in the section`)
  }

  const named = final.books.every((book) => after.includes(book.file))
  const withinBudget = Buffer.byteLength(after, 'utf8') <= budget
  console.log('every book named at least once:', named)
  console.log('within budget:', withinBudget)
  if (!named) failures.push('at least one book was never named in the section')
  if (!withinBudget) failures.push(`the section is ${Buffer.byteLength(after, 'utf8')} bytes, over the ${budget}-byte budget`)
}

console.log('verdict  :', failures.length === 0 ? 'OK' : 'FAIL')
if (failures.length > 0) {
  console.error('')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

/**
 * Derive one workspace-relative path that the book's own trigger matches.
 *
 * Every candidate is checked against the plugin's matcher rather than trusted,
 * so a glob this generator cannot invert is reported instead of silently
 * producing a path that triggers nothing.
 * @param patterns - the book's trigger globs.
 * @returns a matching path, or `undefined` when none could be derived.
 */
function sampleFor(patterns) {
  for (const pattern of patterns) {
    for (const candidate of candidatesFor(pattern)) {
      if (matchGlob(pattern, candidate)) return candidate
    }
  }
  return undefined
}

function candidatesFor(pattern) {
  const out = []

  for (const expanded of expandBraces(pattern)) {
    const concrete = expanded
      .replace(/\*\*\//g, '')
      .replace(/\*\*/g, 'x')
      .replace(/\*/g, 'x')
      .replace(/\?/g, 'x')

    if (concrete !== '' && !concrete.includes('*')) out.push(concrete)
  }

  return out
}

/**
 * Resolve the rules budget this machine's profile actually applies, the way the
 * loader does: the bundle's inserted row, then the profile patch that targets it.
 * @returns the effective `rulesPromptBytes`, or the bundle default when absent.
 */
async function resolveProfileBudget() {
  if (!existsSync(BUNDLE_PATCH)) {
    console.error(`${BUNDLE_PATCH} not found; run this script from the repository root`)
    process.exit(2)
  }

  if (flags.profileDir === undefined) {
    console.error('cannot locate the profile: set DSH_PROFILE_DIR (or DSH_HOME) or pass --profile-dir <dir>')
    process.exit(2)
  }

  const profilePath = join(flags.profileDir, BUNDLE_PATCH)
  if (!existsSync(profilePath)) {
    console.error(`${profilePath} does not exist`)
    process.exit(2)
  }

  const bundle = await readPatchFile(BUNDLE_PATCH)
  const profile = await readPatchFile(profilePath)
  const resolved = resolveRow(bundle, [profile], ROW_ID)

  console.log('=== effective rules budget (profile) ===')
  console.log(`profile  : ${profilePath}`)
  console.log(`baseline : ${resolved.baseline?.['rulesPromptBytes'] ?? 'undefined'}`)
  console.log(`overrides: ${resolved.applied.length}`)
  console.log(`effective: ${resolved.effective?.['rulesPromptBytes'] ?? 'undefined'}`)

  if (!resolved.overridden) {
    console.error(`  note: no patch carries id \`${ROW_ID}\`; this is the bundle default, not the profile's intent`)
    console.error('  run `pnpm verify:profile` for the guarded form of this check')
  }

  const value = resolved.effective?.['rulesPromptBytes']
  if (typeof value !== 'number') {
    console.error('the resolved config states no numeric rulesPromptBytes')
    process.exit(2)
  }

  return value
}
