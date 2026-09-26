// Guard the profile's override of this bundle's row.
//
// Usage:  node scripts/verify-profile.mjs [--id <row id>] [--profile-dir <dir>]
//                                        [--expect <key>=<value> ...]
//
// Why this exists: an id-targeted profile patch replaces a row's whole `config`
// and is applied only when its `id` still matches the bundle's inserted row. If
// the id drifts — the classic case being a rename that updates the package name
// but not the patch — the loader warns and skips the override, and the row
// silently falls back to the bundle's own default. Nothing else in the toolchain
// notices: typecheck, the unit tests, and the assembly probe all pass, because
// none of them reads the profile.
//
// So this script resolves the effective config the way the loader does, from the
// real patch files on disk, and fails when the result is not the intended one.
import { existsSync } from 'node:fs'

// The reader lives in the built output, and `lib/` is not committed, so a fresh
// checkout fails here before anything else — say so instead of letting the import
// report a missing module.
if (!existsSync(new URL('../lib/patch.js', import.meta.url))) {
  console.error('lib/patch.js is missing: run `pnpm build` first (lib/ is not committed)')
  process.exit(2)
}

const { defaultProfileDir, readPatchFile, resolveRow } = await import('../lib/patch.js')

const DEFAULTS = { id: 'workspace-conventions', profileDir: defaultProfileDir() }
const EXPECTED = new Map([['rulesPromptBytes', '32768']])

const options = parseArgs(process.argv.slice(2))
const id = options.id ?? DEFAULTS.id
const profileDir = options.profileDir ?? DEFAULTS.profileDir
for (const entry of options.expect) {
  const [key, value] = splitExpectation(entry)
  EXPECTED.set(key, value)
}

const bundlePath = 'cordis.patch.yml'
if (!existsSync(bundlePath)) fail([`cannot find ${bundlePath}; run this script from the repository root`])

if (profileDir === undefined) {
  fail([
    'cannot locate the profile: set DSH_PROFILE_DIR (or DSH_HOME) or pass --profile-dir <dir>',
    '  PowerShell: $env:DSH_PROFILE_DIR = "$env:USERPROFILE\\.dsh\\profiles\\web"',
  ])
}

const profilePath = `${profileDir}/cordis.patch.yml`
const bundle = await readPatchFile(bundlePath)

console.log('=== bundle ===')
console.log(`file     : ${bundlePath}`)
console.log(`inserted : ${bundle.insert.length} row(s)`)

console.log('=== profile ===')
console.log(`file     : ${profilePath}`)
if (!existsSync(profilePath)) fail([`${profilePath} does not exist`])

const profile = await readPatchFile(profilePath)
console.log(`rows     : ${profile.topLevel.length} top-level row(s)`)

let resolved
try {
  resolved = resolveRow(bundle, [profile], id)
} catch (error) {
  fail([error instanceof Error ? error.message : String(error)])
}

console.log(`=== resolved row \`${id}\` ===`)
console.log(`baseline : ${JSON.stringify(resolved.baseline ?? null)}`)
console.log(`applied  : ${resolved.applied.length} patch(es)${resolved.applied.length === 0 ? '' : ` from ${resolved.applied.map((entry) => entry.source).join(', ')}`}`)
console.log(`effective: ${JSON.stringify(resolved.effective ?? null)}`)

const problems = []
if (!resolved.overridden) {
  problems.push(
    `no patch in ${profilePath} carries id \`${id}\`, so the loader skips every override and the row keeps the bundle default`,
    `the effective config above is the bundle's, not the profile's`,
  )
}

for (const [key, want] of EXPECTED) {
  const have = resolved.effective?.[key]
  const shown = have === undefined ? 'undefined' : JSON.stringify(have)
  console.log(`expect   : ${key} = ${want}  ->  ${shown}  ${String(have) === want ? 'OK' : 'MISMATCH'}`)
  if (String(have) !== want) problems.push(`${key}: expected ${want} but the effective config says ${shown}`)
}

console.log(problems.length === 0 ? 'verdict  : OK' : 'verdict  : FAIL')

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

function parseArgs(argv) {
  const out = { id: undefined, profileDir: undefined, expect: [] }

  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at]
    const value = () => {
      at += 1
      const next = argv[at]
      if (next === undefined) fail([`${flag} needs a value`])
      return next
    }

    if (flag === '--id') out.id = value()
    else if (flag === '--profile-dir') out.profileDir = value()
    else if (flag === '--expect') out.expect.push(value())
    else fail([`unknown argument \`${flag}\``, 'usage: node scripts/verify-profile.mjs [--id <row id>] [--profile-dir <dir>] [--expect <key>=<value> ...]'])
  }

  return out
}

function splitExpectation(entry) {
  const at = entry.indexOf('=')
  if (at <= 0) fail([`--expect wants <key>=<value> but got \`${entry}\``])
  return [entry.slice(0, at), entry.slice(at + 1)]
}

function fail(lines) {
  for (const line of lines) console.error(line)
  process.exit(2)
}
