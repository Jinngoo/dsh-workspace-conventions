// Verify the built row against a real WorkBuddy project, outside DSH.
//
// Usage:  node scripts/verify-workbuddy.mjs "D:\\path\\to\\project" [rulesPromptBytes]
//
// This drives the real `apply()` with the six injected services stubbed over the
// host filesystem, then reports what each layer would contribute for that
// workspace. It is the fastest way to check compatibility against a project whose
// `.workbuddy/` you did not write, without restarting DSH. Pass a small
// `rulesPromptBytes` to watch the degraded-pointer path, where a triggered book
// no longer fits whole.
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const WORKSPACE = process.argv[2]
if (WORKSPACE === undefined) {
  console.error('usage: node scripts/verify-workbuddy.mjs <workspace> [rulesPromptBytes]')
  process.exit(2)
}
const RULES_BUDGET = Number(process.argv[3] ?? 48 * 1024)

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const AGENT = { session: { header: { cwd: WORKSPACE } } }
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

apply(ctx, { indexPromptBytes: 7000, rulesPromptBytes: RULES_BUDGET, ruleFileBytes: 16384 })

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
const candidates = await provider.list({ cwd: WORKSPACE })
console.log('candidates:', candidates.length)
for (const candidate of candidates) console.log(`  ${candidate.name}@${candidate.rank}  ${candidate.description.slice(0, 48)}…`)

// Trigger every conditional book, which is the case that stresses the section
// budget: with several books live at once, a book that does not fit must still
// be reachable rather than vanish.
const conditional = status.books.filter((book) => book.kind === 'conditional')
if (conditional.length > 0) {
  console.log('=== trigger every conditional book ===')
  // Turn a trigger glob into one path that matches it.
  const sampleFor = (glob) => glob
    .replace(/\*\*\/?/g, '')
    .replace(/\*/g, 'x')
    .replace(/\{[^}]*\}/, 'cs')
  for (const book of conditional) {
    const sample = sampleFor(book.paths[0])
    console.log(`touch  : ${sample}  (${book.file})`)
    handlers.get('tools/result')({
      name: 'read',
      arguments: { file_path: join(WORKSPACE, sample) },
      agent: AGENT,
      signal: new AbortController().signal,
    }, { isError: false })
    await settle(() => render('workspace-rules').includes('已触发的条件册'))
  }
  const after = render('workspace-rules')
  console.log(`injected: ${Buffer.byteLength(after, 'utf8')} bytes (budget ${RULES_BUDGET})`)
  const final = await tools.find((t) => t.name === 'rule_status').execute({})
  const statusOf = (file) => {
    const at = after.indexOf(`### ${file}`)
    if (at === -1) return after.includes(file) ? 'NAME' : 'LOST'
    const next = after.indexOf('\n### ', at + 1)
    const block = next === -1 ? after.slice(at) : after.slice(at, next)
    return block.includes('本册正文超出本轮注入预算') ? 'PTR' : 'FULL'
  }
  for (const book of final.books) console.log(`  ${statusOf(book.file)}  ${book.file}`)
  console.log('every book named at least once:', final.books.every((book) => after.includes(book.file)))
  console.log('within budget:', Buffer.byteLength(after, 'utf8') <= RULES_BUDGET)
}
