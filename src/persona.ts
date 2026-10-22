/**
 * 人格层：片段解析、作用域合并与预算渲染。
 *
 * 人格片段是 `persona/<name>.md` 文件，一个片段只讲「我是谁」（身份、语气、价值观、
 * 禁忌、协作偏好）；项目事实属于 memory，不属于人格。本模块只做纯文本处理：不读
 * 文件、不碰环境变量、不取当前时间，所以目录扫描交给调用方，逻辑全部可单测。
 *
 * 渲染沿用 rules 层的两条既有结论：预算按**实际拼装出的字符串**逐片段准入（用估算
 * 会漏掉标题、空行与段尾点名，让片段「准入成功」却被硬裁剪掉），以及放不下的内容
 * 降级为 `persona_read` 指针而不是无声消失——模型只有看到「有这个片段、用
 * persona_read 读它的名字」才可能把人格找回来。
 *
 * @module @jinngoo/dsh-workspace-conventions/persona
 */

import { frontmatterScalar, parseFrontmatter, type Frontmatter } from './frontmatter.js'
import type { LayerScope } from './scope.js'
import { byteLength, clipBytes, normalizeText, oneLine } from './text.js'

/** 人格段落的固定标题，渲染结果以它开头。 */
const SECTION_TITLE = '## 人格'

/** 文件名里的序号前缀：`01-identity` → `1`。 */
const ORDER_PREFIX_RE = /^(\d+)-/

/** 严格整数写法，避免 `order: 1.5` 或 `order: 靠前` 被当成数字。 */
const INTEGER_RE = /^[-+]?\d+$/

/** 片段文件扩展名；调用方误传 `01-identity.md` 时容错剥掉。 */
const MARKDOWN_EXTENSION_RE = /\.(?:md|markdown)$/i

/** 一个人格片段。 */
export interface PersonaFragment {
  /** 片段所属作用域：`global` 或 `workspace`。 */
  readonly scope: LayerScope
  /** 片段名，不含扩展名，例如 `01-identity`。 */
  readonly name: string
  /** 展示标题：frontmatter 的 `title`，缺省回退到 {@link PersonaFragment.name}。 */
  readonly title: string
  /** 排序序号：frontmatter 的 `order`，缺省取文件名数字前缀，再缺省为 `0`。 */
  readonly order: number
  /** 去掉 frontmatter 后的正文，已做换行与空白归一。 */
  readonly body: string
  /** 正文的 UTF-8 字节数，用于状态汇报与预算预判。 */
  readonly bytes: number
}

/**
 * 解析一个人格片段文件。
 *
 * frontmatter 的 `title` 与 `order` 都可省略：`order` 缺省取文件名的数字前缀
 * （`01-identity` → `1`），没有前缀则为 `0`。名称、正文或 `order` 有问题时不会
 * 静默猜：`issue` 带出可读原因，能用的字段仍然返回，让调用方既能注入也能汇报。
 * 正文为空的文件不产片段——一个只有标题的片段只会在每轮注入里白占字节。
 * @param scope - 片段所属作用域。
 * @param name - 片段名；允许误带 `.md` 扩展名或路径，会被归一，不含扩展名。
 * @param raw - 片段文件的原始文本。
 * @returns 解析出的片段，以及（可选）需要汇报的问题。
 */
export function parsePersonaFragment(
  scope: LayerScope,
  name: string,
  raw: string,
): { fragment?: PersonaFragment; issue?: string } {
  const normalized = normalizeFragmentName(name)
  if (normalized === '') return { issue: '片段名称为空' }

  const frontmatter = parseFrontmatter(String(raw ?? ''))
  const body = normalizeText(frontmatter.body)
  const issues: string[] = []

  let order = orderFromName(normalized)
  if (frontmatter.data.has('order')) {
    const declared = frontmatterScalar(frontmatter, 'order')?.trim() ?? ''
    if (declared === '') issues.push('order 取值无法识别（空）')
    else if (INTEGER_RE.test(declared)) order = Number.parseInt(declared, 10)
    else issues.push(`order 取值无法识别（${declared}）`)
  }

  if (body === '') {
    issues.push('正文为空，片段不会注入')
    return { issue: issues.join('；') }
  }

  const fragment: PersonaFragment = {
    scope,
    name: normalized,
    title: fragmentTitle(frontmatter, normalized),
    order,
    body,
    bytes: byteLength(body),
  }
  return issues.length > 0 ? { fragment, issue: issues.join('；') } : { fragment }
}

/**
 * 按 `order` 升序、再按名称（大小写不敏感）排序。
 *
 * 名称相同时以字面名称、作用域（`global` 在前）作为兜底判据，保证排序结果与输入
 * 顺序无关；不修改传入数组。渲染仍按数组顺序进行，所以合并后的分组由
 * {@link mergePersona} 决定。
 * @param fragments - 待排序的片段。
 * @returns 排好序的新数组。
 */
export function sortPersona(fragments: readonly PersonaFragment[]): PersonaFragment[] {
  return [...fragments].sort(compareFragments)
}

/** 一次作用域合并的结果。 */
export interface PersonaMerge {
  /** 实际注入的片段：全局片段在前、工作区片段在后，各自按 {@link sortPersona} 排序。 */
  readonly fragments: readonly PersonaFragment[]
  /** 被工作区同名片段整体遮蔽的全局片段，按排序后的顺序汇报。 */
  readonly shadowed: readonly PersonaFragment[]
}

/**
 * 合并全局与工作区两层人格。
 *
 * 全局片段先出现，工作区片段随后；**同名片段整体遮蔽**——工作区的
 * `01-identity` 完整替换全局的那一份，而不是拼接成两段互相矛盾的人格文本。遮蔽
 * 判定按名称大小写不敏感（Windows 上 `01-Identity.md` 与 `01-identity.md` 是同一个
 * 文件，不能既遮蔽又并存）。被遮蔽的全局片段进入 `shadowed`，供状态汇报。
 * @param global - 全局作用域的片段。
 * @param workspace - 工作区作用域的片段。
 * @returns 合并结果与遮蔽清单。
 */
export function mergePersona(
  global: readonly PersonaFragment[],
  workspace: readonly PersonaFragment[],
): PersonaMerge {
  const globalSorted = sortPersona(global)
  const workspaceSorted = sortPersona(workspace)
  const covered = new Set(workspaceSorted.map((fragment) => fragment.name.toLowerCase()))
  const shadowed = globalSorted.filter((fragment) => covered.has(fragment.name.toLowerCase()))
  const visible = globalSorted.filter((fragment) => !covered.has(fragment.name.toLowerCase()))
  return { fragments: [...visible, ...workspaceSorted], shadowed }
}

/** 人格段落的渲染预算。 */
export interface PersonaRenderOptions {
  /** 整段注入的字节上限，按实际拼装出的字符串计量。 */
  readonly maxBytes: number
  /** 单片段正文的字节上限，超出即截断并留下 `persona_read` 指针。 */
  readonly fileBytes: number
}

/** 一次人格段落渲染的结果。 */
export interface PersonaRender {
  /** 面向模型的段落文本；空输入或预算不可用时为空串。 */
  readonly text: string
  /** 整段注入（可能被单片段上限截断）的片段名，按渲染顺序。 */
  readonly injected: readonly string[]
  /** 因整段预算不足而降级为指针行的片段名，按渲染顺序。 */
  readonly pointers: readonly string[]
  /** 因预算不足连指针行都放不下的片段名，按渲染顺序；正文在段尾被点名。 */
  readonly dropped: readonly string[]
  /** 正文超过单片段上限、已被截断的片段名，按渲染顺序。 */
  readonly truncated: readonly string[]
}

/** 一个片段在本次渲染里的去向。 */
interface PersonaAdmission {
  /** `block` 带正文，`pointer` 只有一行 `persona_read` 指针。 */
  readonly kind: 'block' | 'pointer'
  /** 该片段贡献的文本块。 */
  readonly text: string
  /** 正文是否被单片段上限截断。 */
  readonly truncated: boolean
}

/**
 * 渲染 `## 人格` 段落。
 *
 * 传入顺序即渲染顺序（{@link mergePersona} 已保证全局在前），本函数不再排序，因此
 * 调用方可以决定分组。逐片段准入：先试整段，放不下就降级为一行
 * `persona_read` 指针，指针也放不下则丢弃并在段尾点名——每一档都按**实际拼装出的
 * 字符串**计量字节，避免「准入成功但被截断」或「丢掉了却不留任何线索」。
 *
 * 空的片段列表直接返回空串，让没写人格的工作区零 token 开销；`maxBytes` 非法或
 * 非正时同样返回空串，而不是渲染出注定被裁剪的半段文本。
 * @param fragments - 已合并、已排序的片段。
 * @param options - 整段预算与单片段预算。
 * @returns 段落文本、被截断清单与各片段的去向。
 */
export function renderPersonaSection(
  fragments: readonly PersonaFragment[],
  options: PersonaRenderOptions,
): PersonaRender {
  const empty: PersonaRender = { text: '', injected: [], pointers: [], dropped: [], truncated: [] }
  const { maxBytes } = options
  if (fragments.length === 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) return empty
  const fileBytes = Number.isFinite(options.fileBytes) ? Math.max(0, options.fileBytes) : 0

  const admissions: Array<PersonaAdmission | undefined> = fragments.map(() => undefined)
  const dropped: string[] = []

  /** 按当前去向拼出段落：片段间空行，段尾是未注入片段的点名。 */
  const assemble = (): string => {
    const parts: string[] = [SECTION_TITLE]
    for (let index = 0; index < fragments.length; index += 1) {
      const admission = admissions[index]
      if (admission !== undefined) parts.push(admission.text)
    }
    if (dropped.length > 0) parts.push(renderOmissionNotice(dropped, maxBytes))
    return parts.join('\n\n')
  }
  const fits = (): boolean => byteLength(assemble()) <= maxBytes

  // 逐片段准入。先整段、再指针：一个片段只要还能被点名，就不要让它从上下文里
  // 彻底消失——人格片段是「我是谁」，模型不知道它存在就不会去读。
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index]
    if (fragment === undefined) continue
    const block = renderFragmentBlock(fragment, fileBytes)
    admissions[index] = { kind: 'block', text: block.text, truncated: block.truncated }
    if (fits()) continue
    admissions[index] = { kind: 'pointer', text: renderPointerLine(fragment), truncated: false }
    if (fits()) continue
    admissions[index] = undefined
    dropped.push(fragment.name)
  }

  // 段尾点名的字节数只有到最后才知道；硬裁剪是兜底，正常预算下不会被触发。
  const text = clipBytes(assemble(), maxBytes).text.trimEnd()
  const injected: string[] = []
  const pointers: string[] = []
  const truncated: string[] = []
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index]
    const admission = admissions[index]
    if (fragment === undefined || admission === undefined) continue
    if (admission.kind === 'block') {
      injected.push(fragment.name)
      if (admission.truncated) truncated.push(fragment.name)
    } else {
      pointers.push(fragment.name)
    }
  }
  return { text, injected, pointers, dropped, truncated }
}

/**
 * 把一个片段渲染成标题加正文的文本块。
 * @param fragment - 待渲染的片段。
 * @param fileBytes - 正文的字节上限。
 * @returns 文本块及其是否被截断。
 */
function renderFragmentBlock(
  fragment: PersonaFragment,
  fileBytes: number,
): { readonly text: string, readonly truncated: boolean } {
  const clipped = clipBytes(fragment.body, fileBytes)
  const lines = [`### ${fragment.title}`]
  if (clipped.text.length > 0) lines.push('', clipped.text)
  if (clipped.truncated) lines.push('', `…（已截断，完整内容用 persona_read 读 ${fragment.name}）`)
  return { text: lines.join('\n'), truncated: clipped.truncated }
}

/**
 * 把一个放不下的片段降级为一行指针。
 * @param fragment - 待降级的片段。
 * @returns 指针行。
 */
function renderPointerLine(fragment: PersonaFragment): string {
  return `- ${fragment.title}（完整内容用 persona_read 读 ${fragment.name}）`
}

/**
 * 段尾点名：本轮连指针都放不下、因而完全没有注入的片段。
 * @param names - 被丢弃的片段名。
 * @param maxBytes - 本轮整段预算，写进提示里便于排查。
 * @returns 提示行；没有丢弃片段时为空串。
 */
function renderOmissionNotice(names: readonly string[], maxBytes: number): string {
  if (names.length === 0) return ''
  return `> 注入预算（${String(maxBytes)} 字节）已满，以下片段本轮未注入，需要时用 persona_read 直接读：${names.join('、')}`
}

/**
 * 归一化片段名：取路径末段并剥掉 Markdown 扩展名。
 * @param name - 调用方给的名称。
 * @returns 归一后的片段名，可能为空。
 */
function normalizeFragmentName(name: string): string {
  const trimmed = String(name ?? '').trim().replace(/\\/g, '/')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return base.replace(MARKDOWN_EXTENSION_RE, '').trim()
}

/**
 * 从文件名的数字前缀推导排序序号。
 * @param name - 归一后的片段名。
 * @returns 前缀数字；没有前缀时为 `0`。
 */
function orderFromName(name: string): number {
  const match = ORDER_PREFIX_RE.exec(name)
  const digits = match?.[1]
  if (digits === undefined) return 0
  const parsed = Number.parseInt(digits, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 取片段的展示标题。
 * @param frontmatter - 已解析的 frontmatter。
 * @param fallback - 标题缺省时使用的片段名。
 * @returns 单行标题。
 */
function fragmentTitle(frontmatter: Frontmatter, fallback: string): string {
  const declared = oneLine(frontmatterScalar(frontmatter, 'title') ?? '')
  return declared.length > 0 ? declared : fallback
}

/**
 * 片段排序比较器：order 升序 → 名称大小写不敏感 → 名称字面 → 作用域。
 * @param left - 左侧片段。
 * @param right - 右侧片段。
 * @returns 负数表示左侧在前。
 */
function compareFragments(left: PersonaFragment, right: PersonaFragment): number {
  if (left.order !== right.order) return left.order - right.order
  const leftKey = left.name.toLowerCase()
  const rightKey = right.name.toLowerCase()
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  return scopeRank(left.scope) - scopeRank(right.scope)
}

/**
 * 作用域的稳定排序权重：全局在前。
 * @param scope - 片段作用域。
 * @returns 全局 `0`，工作区 `1`。
 */
function scopeRank(scope: LayerScope): number {
  return scope === 'global' ? 0 : 1
}
