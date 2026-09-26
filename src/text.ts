/**
 * Text, path and byte-budget helpers shared by every layer.
 *
 * @module @jinngoo/dsh-workspace-memory/text
 */

/**
 * Normalize any value to a primitive, trimmed string with LF line endings.
 * @param value - the value to normalize.
 * @returns the normalized text.
 */
export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * Present a path with forward slashes so prompt text is platform-neutral.
 * @param p - the path to present.
 * @returns the path with `/` separators.
 */
export function toPosix(p: string): string {
  return p.split('\\').join('/')
}

/**
 * Collapse a value to a single line, capped for use as a heading.
 * @param value - the value to collapse.
 * @param max - maximum characters kept before an ellipsis is appended.
 * @returns the single-line text.
 */
export function oneLine(value: unknown, max = 120): string {
  const text = normalizeText(value).replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * `YYYY-MM-DD` in local time.
 * @param at - the instant to stamp; defaults to now.
 * @returns the local date stamp.
 */
export function dateStamp(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/**
 * `HH:MM` in local time.
 * @param at - the instant to stamp; defaults to now.
 * @returns the local clock stamp.
 */
export function clockStamp(at: Date = new Date()): string {
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/**
 * Cut text to a UTF-8 byte budget without splitting a code point.
 *
 * Byte caps here are authored in bytes because the injected prompt budget is a
 * byte budget, while `String.length` counts UTF-16 units: CJK rule bodies would
 * otherwise overrun the cap by a factor of three.
 * @param text - the text to cut.
 * @param maxBytes - the cap; non-positive keeps nothing.
 * @returns the cut text plus whether anything was dropped.
 */
export function clipBytes(text: string, maxBytes: number): { readonly text: string, readonly truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

/**
 * Count the UTF-8 bytes one string contributes to a prompt.
 * @param text - the text to measure.
 * @returns the byte length.
 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
