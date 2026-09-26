/**
 * The glob dialect WorkBuddy rule files use for their `paths:` triggers.
 *
 * This is not a general glob engine: it supports `**`, `*`, `?` and brace
 * alternation, which is the whole dialect the supported rule files are written
 * in. Matching is case-insensitive because the platforms these rules target
 * (Windows, macOS) resolve paths case-insensitively, so an authored trigger
 * like `client/Escort/assets/**\/*.ts` must still fire for a differently cased
 * spelling on disk.
 *
 * @module @jinngoo/dsh-workspace-conventions/glob
 */

/**
 * Expand every top-level `{a,b}` alternation into separate patterns.
 *
 * Alternations do not nest, which matches the dialect: the brace groups in real
 * rule files are extensions such as `*.{cs,ts}`.
 * @param pattern - the pattern to expand.
 * @returns one pattern per combination.
 */
export function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{')
  if (start === -1) return [pattern]
  const end = pattern.indexOf('}', start)
  if (end === -1) return [pattern]
  const head = pattern.slice(0, start)
  const tail = pattern.slice(end + 1)
  const options = pattern.slice(start + 1, end).split(',')
  return options.flatMap((option) => expandBraces(`${head}${option}${tail}`))
}

/**
 * Compile one glob into an anchored regular expression.
 * @param pattern - a glob using `**`, `*`, `?` and braces.
 * @returns the compiled expression, anchored at both ends and case-insensitive.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = toSlashes(pattern)
  let out = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i] ?? ''
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` spans zero or more directories, so it also matches a top-level file.
        if (normalized[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2 } else { out += '.*'; i += 1 }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') { out += '[^/]'; continue }
    out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^${out}$`, 'i')
}

/**
 * Match one workspace-relative path against one glob.
 * @param pattern - the authored glob.
 * @param path - the workspace-relative path, in either separator style.
 * @returns whether any brace expansion of the glob matches.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const candidate = toSlashes(path).replace(/^\.\//, '')
  return expandBraces(toSlashes(pattern)).some((expanded) => globToRegExp(expanded).test(candidate))
}

/**
 * Match one path against an ordered list of globs.
 * @param patterns - the authored globs.
 * @param path - the workspace-relative path.
 * @returns the first matching glob, or `undefined` when none matches.
 */
export function firstMatchingGlob(patterns: readonly string[], path: string): string | undefined {
  return patterns.find((pattern) => matchGlob(pattern, path))
}

function toSlashes(value: string): string {
  return value.split('\\').join('/')
}
