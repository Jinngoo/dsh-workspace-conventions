/**
 * 情绪状态层：一份带衰减的小状态（`mood/current.md`）。
 *
 * 纯逻辑：解析状态文件、生成状态文件、按半衰期算衰减、渲染每轮注入的段落。
 * 不读文件、不读环境变量，当前时间一律由调用方以 `now` 传入，所以同样的
 * `(state, now, options)` 永远得到同样的字符串——本模块不调用任何 locale 相关的
 * 日期格式化，「x 小时前 / x 分钟前」由毫秒差自己算出来。
 *
 * 情绪和人格的区别是**有时效**：写入时由 `now` 落一个 `updated`，读取时按
 * `weight = 0.5 ** (ageHours / halfLifeHours)` 衰减。超过 `maxAgeHours` 或权重低于
 * {@link MIN_FRESH_WEIGHT} 就当作已平复，而不是继续假装还激动。
 *
 * @module @jinngoo/dsh-workspace-conventions/mood
 */

import { frontmatterScalar, parseFrontmatter, type Frontmatter } from './frontmatter.js'
import { LAYER_LABEL } from './scope.js'
import { byteLength, clipBytes, normalizeText, oneLine } from './text.js'

/** 情绪状态文件名；每个作用域目录下一份，写入即整体覆盖。 */
export const MOOD_FILE_NAME = 'current.md'

/** 默认半衰期（小时）：每过这么久，注入强度减半。 */
export const DEFAULT_MOOD_HALF_LIFE_HOURS = 6

/** 默认最大年龄（小时）：超过即视为已平复，不再注入具体情绪。 */
export const DEFAULT_MOOD_MAX_AGE_HOURS = 48

/**
 * 视为新鲜的最低强度。
 *
 * 与 `maxAgeHours` 共同构成新鲜判定：两个条件都满足才注入具体情绪，任一不满足
 * 都按已平复处理。默认半衰期 6 小时下，它把窗口收敛到约 26 小时。
 */
const MIN_FRESH_WEIGHT = 0.05

/** 正文（备注）的字节上限；超长时由 {@link buildMoodDocument} 截断，状态文件不无界增长。 */
const MAX_NOTE_BYTES = 1024

/** 一小时的毫秒数，供年龄换算使用。 */
const HOUR_MS = 3_600_000

/** 状态文本的固定前缀，渲染与视图共用，避免两处漂移。 */
const STATUS_PREFIX = '当前情绪：'

/** 已平复时的一句话。 */
const CALM_TEXT = `${STATUS_PREFIX}已平复`

/** 一条合法状态文件必须给出的时间格式：ISO 8601 日期时间，必须带时区偏移或 `Z`。 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** 严格浮点字面量：不接受 `0x10`、`1e3`、空串等 `Number()` 会额外接受的写法。 */
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

/**
 * 一份解析后的情绪状态。
 *
 * `valence`/`arousal`/`updated` 缺失是合法的（写者可以不表态、也可以只写标签），
 * 因此三者在类型上都是可选的；`bytes` 只计量正文，供正文预算判断。
 */
export interface MoodState {
  /** 情绪标签，例如「专注」；必填，解析时缺失或为空即整份状态无效。 */
  readonly label: string
  /** 效价：-1 消极 … +1 积极；未给出时渲染为「中性」。 */
  readonly valence?: number
  /** 唤醒度：0 平静 … 1 亢奋；未给出时渲染为「适中」。 */
  readonly arousal?: number
  /** 状态写入时间（ISO 8601 字符串）；缺失或不可解析时按已过期处理。 */
  readonly updated?: string
  /** 备注正文，可为空字符串；解析时已做换行与首尾空白归一。 */
  readonly body: string
  /** 备注正文的 UTF-8 字节数，供正文预算判断（设计上限 1024 字节）。 */
  readonly bytes: number
}

/** 一次可选数值读取的三种结果：缺失、合法、非法。 */
type NumberRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'value', readonly value: number }
  | { readonly kind: 'invalid', readonly raw: string }

/**
 * 读取一个限定区间的浮点标量。
 *
 * 缺失与非法刻意区分：缺失表示写者没表态，非法表示文件里有东西但读不懂，
 * 后者整份状态都不可信。
 * @param frontmatter - 已解析的 frontmatter。
 * @param key - 键名。
 * @param min - 允许的最小值（含）。
 * @param max - 允许的最大值（含）。
 * @returns 三选一的读取结果。
 */
function readRangeScalar(frontmatter: Frontmatter, key: string, min: number, max: number): NumberRead {
  if (!frontmatter.data.has(key)) return { kind: 'absent' }
  const raw = frontmatterScalar(frontmatter, key)
  if (raw === undefined) return { kind: 'invalid', raw: '' }
  const text = raw.trim()
  if (!NUMBER_RE.test(text)) return { kind: 'invalid', raw: text }
  const value = Number(text)
  if (!Number.isFinite(value) || value < min || value > max) return { kind: 'invalid', raw: text }
  return { kind: 'value', value }
}

/**
 * 把 `updated` 解析成时间戳。
 *
 * 只接受带时区偏移（或 `Z`）的 ISO 8601 日期时间：不带偏移的「本地时间」在不同
 * 机器上是不同的瞬间，用它算衰减会随机器漂移，所以宁可判为不可解析。
 * @param updated - 原始 `updated` 文本。
 * @returns 毫秒时间戳；缺失或不可解析时返回 `undefined`。
 */
function updatedInstant(updated: string | undefined): number | undefined {
  if (updated === undefined) return undefined
  const text = updated.trim()
  if (!ISO_INSTANT_RE.test(text)) return undefined
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : undefined
}

/**
 * 解析一份情绪状态文件。
 *
 * 缺 label 或数值非法时整份状态都不可信，只返回 `issue`；`updated` 缺失或不可
 * 解析时仍然返回 `state`，因为标签与正文还能用，只是按已过期处理（见
 * {@link moodView}）。
 * @param raw - 状态文件的原始文本。
 * @returns `state` 与/或 `issue`：成功时只有 `state`，`updated` 有问题时两者都有，其余失败只有 `issue`。
 */
export function parseMoodDocument(raw: string): { state?: MoodState, issue?: string } {
  const source = String(raw ?? '')
  if (normalizeText(source) === '') return { issue: '情绪文件为空' }
  const frontmatter = parseFrontmatter(source)
  if (!frontmatter.present) return { issue: '缺少 frontmatter 分隔符 ---，无法读取情绪状态' }

  const label = oneLine(frontmatterScalar(frontmatter, 'label') ?? '', 120)
  if (label === '') return { issue: 'frontmatter 缺少 label，情绪状态没有标签即无效' }

  const valence = readRangeScalar(frontmatter, 'valence', -1, 1)
  if (valence.kind === 'invalid') {
    return { issue: `valence 不是 -1..1 之间的浮点数：${valence.raw === '' ? '（空值）' : valence.raw}` }
  }
  const arousal = readRangeScalar(frontmatter, 'arousal', 0, 1)
  if (arousal.kind === 'invalid') {
    return { issue: `arousal 不是 0..1 之间的浮点数：${arousal.raw === '' ? '（空值）' : arousal.raw}` }
  }

  const updated = (frontmatterScalar(frontmatter, 'updated') ?? '').trim()
  const body = normalizeText(frontmatter.body)
  const state: MoodState = {
    label,
    ...(valence.kind === 'value' ? { valence: valence.value } : {}),
    ...(arousal.kind === 'value' ? { arousal: arousal.value } : {}),
    ...(updated === '' ? {} : { updated }),
    body,
    bytes: byteLength(body),
  }
  if (updated === '') return { state, issue: '缺少 updated，无法计算衰减，按已平复处理' }
  if (updatedInstant(updated) === undefined) {
    return { state, issue: `updated 不是可解析的 ISO 8601 时间：${updated}` }
  }
  return { state }
}

/** 两位补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 本地时间 + 时区偏移的 ISO 8601 表示，例如 `2026-10-23T00:12:00+08:00`。
 * @param at - 要格式化的瞬间。
 * @returns 带偏移的 ISO 字符串（秒级精度）。
 */
function localIso(at: Date): string {
  const offsetMinutes = -at.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const date = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`
  return `${date}T${clock}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/**
 * 把浮点写成 frontmatter 标量：最多 4 位小数，去掉尾随 0。
 * @param value - 已通过区间校验的数值。
 * @returns 确定的十进制文本。
 */
function formatScalar(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000
  return String(rounded === 0 ? 0 : rounded)
}

/**
 * 校验一个可选数值是否落在区间内。
 * @param value - 调用方给的数值。
 * @param min - 允许的最小值（含）。
 * @param max - 允许的最大值（含）。
 * @param name - 出错信息里的字段名。
 * @returns 原值，或原样返回 `undefined`。
 */
function requireRange(value: number | undefined, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`mood ${name} must be a finite number in ${min}..${max}`)
  }
  return value
}

/**
 * 生成一份可被 {@link parseMoodDocument} 读回的状态文件。
 *
 * frontmatter 只写给出的键（未表态的数值不写），`updated` 由 `now` 生成本地
 * ISO 8601（含时区偏移），正文超过 1024 字节会被截断。标签与数值会做归一与
 * 区间校验：静默写出一份读不回来的状态文件比抛错更糟。
 * @param input - 状态内容：`label` 必填，其余可选。
 * @param now - 当前时间，作为 `updated` 写入。
 * @returns 状态文件文本（frontmatter + 可选正文）。
 * @throws 当 `now` 不是有效日期、`label` 为空，或数值超出区间/不是有限数时抛出。
 */
export function buildMoodDocument(
  input: {
    readonly label: string
    readonly valence?: number
    readonly arousal?: number
    readonly note?: string
  },
  now: Date,
): string {
  if (!Number.isFinite(now.getTime())) throw new Error('mood document needs a valid Date')
  const label = oneLine(input.label, 120)
  if (label === '') throw new Error('mood label must not be empty')
  const valence = requireRange(input.valence, -1, 1, 'valence')
  const arousal = requireRange(input.arousal, 0, 1, 'arousal')

  const lines = ['---', `label: ${label}`]
  if (valence !== undefined) lines.push(`valence: ${formatScalar(valence)}`)
  if (arousal !== undefined) lines.push(`arousal: ${formatScalar(arousal)}`)
  lines.push(`updated: ${localIso(now)}`, '---')

  const head = lines.join('\n')
  const note = clipBytes(normalizeText(input.note ?? ''), MAX_NOTE_BYTES).text
  return note === '' ? `${head}\n` : `${head}\n\n${note}\n`
}

/** 衰减参数：两条门槛，与写入无关，只影响读取时的强度与新鲜判定。 */
export interface MoodDecayOptions {
  /** 半衰期（小时）：权重每过这么久减半；非正数视为无法衰减。 */
  readonly halfLifeHours: number
  /** 最大年龄（小时）：超过即视为已平复，与权重无关。 */
  readonly maxAgeHours: number
}

/** 一份状态在某个时刻的衰减结果。 */
export interface MoodView {
  /** 是否仍在注入窗口内：`updated` 可解析且未超过 `maxAgeHours` 且 `weight >= 0.05`。 */
  readonly fresh: boolean
  /** 距 `updated` 的小时数；无法计算时为 `Number.POSITIVE_INFINITY`。 */
  readonly ageHours: number
  /** 衰减后的强度，取值 [0, 1]；无法计算时为 0。 */
  readonly weight: number
  /** 确定性的状态文本：新鲜时是一整行状态描述，否则为「当前情绪：已平复」。 */
  readonly text: string
  /** 情绪标签；只在新鲜时给出（已平复时省略，避免误读成仍在生效）。 */
  readonly label?: string
}

/**
 * 效价值到倾向词的映射。
 *
 * 边界刻意写死并对称：`>= 0.5` 积极、`>= 0.15` 偏积极、`> -0.15` 中性、
 * `> -0.5` 偏消极，其余消极；未给出效价视为不表态，渲染为「中性」。
 * @param value - 效价，或 `undefined`。
 * @returns 倾向词。
 */
function valenceLabel(value: number | undefined): string {
  if (value === undefined) return '中性'
  if (value >= 0.5) return '积极'
  if (value >= 0.15) return '偏积极'
  if (value > -0.15) return '中性'
  if (value > -0.5) return '偏消极'
  return '消极'
}

/**
 * 唤醒度到唤醒词的映射。
 *
 * 按三等分写死：`>= 2/3` 活跃、`>= 1/3` 适中、其余平静；未给出视为「适中」。
 * @param value - 唤醒度，或 `undefined`。
 * @returns 唤醒词。
 */
function arousalLabel(value: number | undefined): string {
  if (value === undefined) return '适中'
  if (value >= 2 / 3) return '活跃'
  if (value >= 1 / 3) return '适中'
  return '平静'
}

/**
 * 年龄的**粗粒度**表述，自己算而不走 `Intl`，保证跨 locale 确定。
 *
 * 注入文本会进入 runtime-context 快照，而快照只在文本变化时追加；分钟级或
 * 两位小数的表述会让它每分钟都变，长会话里持续追加整份快照（实测一份约
 * 1.2 KB，且包含其它插件的上下文）。因此这里把年龄分桶到 ≥ 半小时的粒度：
 * 同一份情绪状态在约一小时内最多只让快照变化一次。
 *
 * 分桶：`< 15 分钟` → 刚刚；`< 90 分钟` → 约半小时前；其余按整小时向下取整。
 * @param ageHours - 已算出的小时数（此时必为有限值）。
 * @returns 例如「约 3 小时前」「刚刚」「约半小时前」。
 */
function ageText(ageHours: number): string {
  const minutes = Math.max(0, ageHours * 60)
  if (minutes < 15) return '刚刚'
  if (minutes < 90) return '约半小时前'
  return `约 ${Math.floor(minutes / 60)} 小时前`
}

/**
 * 计算一份状态在 `now` 时的衰减与展示文本。
 *
 * `ageHours` 由 `now - updated` 得出；`updated` 缺失或不可解析时按
 * `Number.POSITIVE_INFINITY`、`weight = 0`、`fresh = false` 处理。未来时间戳
 * （时钟回拨或写错）按 0 小时处理，不会得到大于 1 的强度。
 * @param state - 已解析的状态。
 * @param now - 当前时间。
 * @param options - 半衰期与最大年龄。
 * @returns 新鲜判定、年龄、强度与状态文本。
 */
export function moodView(state: MoodState, now: Date, options: MoodDecayOptions): MoodView {
  const at = updatedInstant(state.updated)
  const nowMs = now.getTime()
  const ageHours = at === undefined || !Number.isFinite(nowMs)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, (nowMs - at) / HOUR_MS)

  const halfLife = options.halfLifeHours
  const weight = Number.isFinite(ageHours) && Number.isFinite(halfLife) && halfLife > 0
    ? 0.5 ** (ageHours / halfLife)
    : 0
  const fresh = Number.isFinite(ageHours)
    && ageHours <= options.maxAgeHours
    && weight >= MIN_FRESH_WEIGHT

  if (!fresh) return { fresh: false, ageHours, weight, text: CALM_TEXT }

  // Deliberately no numeric intensity: `weight` changes continuously, so putting
  // it in the injected line would rewrite the snapshot every few minutes. The
  // exact value stays available through `mood_get`; the prompt only needs the
  // label, the coarse trend and the coarse age.
  const text = `${STATUS_PREFIX}${state.label}（${valenceLabel(state.valence)}、${arousalLabel(state.arousal)}，${ageText(ageHours)}）`
  return { fresh: true, ageHours, weight, text, label: state.label }
}

/** 渲染情绪段落所需的全部参数：衰减两条门槛 + 段落预算 + 平复时是否出声。 */
export interface MoodRenderOptions extends MoodDecayOptions {
  /** 段落总预算（UTF-8 字节）；非正数得到空串。 */
  readonly maxBytes: number
  /** 已平复时是否仍输出一行「当前情绪：已平复」。 */
  readonly renderQuiet: boolean
}

/**
 * 渲染每轮注入的情绪段落。
 *
 * 新鲜时是 `## 情绪` 标题 + 一行状态 +（可选）正文；过期或权重过低时，按
 * {@link MoodRenderOptions.renderQuiet} 输出一行「当前情绪：已平复」或空串。
 * 完全没有状态（从未写过 `current.md`）时返回空串：没有记录就不该声称任何情绪。
 * 整段最后按 `maxBytes` 用 {@link clipBytes} 截断，保证不切断码点。
 * @param state - 当前作用域的合并结果，`undefined` 表示没有状态。
 * @param now - 当前时间。
 * @param options - 衰减参数、段落字节预算与平复时的渲染开关。
 * @returns 可注入 prompt 的段落；不注入时为 `''`。
 */
export function renderMoodSection(
  state: MoodState | undefined,
  now: Date,
  options: MoodRenderOptions,
): string {
  if (state === undefined) return ''
  const view = moodView(state, now, options)
  const lines = [`## ${LAYER_LABEL.mood}`, view.text]
  if (view.fresh) {
    const body = state.body.trim()
    if (body !== '') lines.push('', body)
  } else if (!options.renderQuiet) {
    return ''
  }
  return clipBytes(lines.join('\n'), options.maxBytes).text
}

/** 渲染「情绪维护」段落所需的参数。 */
export interface MoodMaintenanceOptions {
  /**
   * 本作用域确实没有任何情绪记录（探测已完成，工作区与全局都为空）。
   *
   * 只有这个状态才邀请「写第一条」；已记录但已平复不算空缺，不能再说成
   * 「尚无记录」，否则每次平复后都会冒出一句误导性提示。
   */
  readonly missingRecord: boolean
}

/**
 * 渲染每轮注入的「情绪维护」段落。
 *
 * 情绪层只是工具，模型不写就没有。这个段落把「何时值得写」说清楚，让主动
 * 更新有依据，同时明确禁止机械地每轮写入——情绪是状态，不是流水账。
 *
 * 必须是纯函数且不含时间：注入文本进入 runtime-context 快照，快照只在文本
 * 变化时追加。开关不变时文本必须逐字节相同，否则每轮都会追加一份快照。
 * @param options - 是否处于「尚无任何记录」的空缺态。
 * @returns 固定段落文本；调用方决定是否注入（层关闭或 `moodProactive` 为
 *   false 时整段消失，token 为 0）。
 */
export function renderMoodMaintenanceSection(options: MoodMaintenanceOptions): string {
  const lines = [
    '## 情绪维护',
    '情绪层已开启：本轮工作出现明确的状态变化（任务阶段切换、被纠正、卡住后突破、长任务收尾）时，可主动调用 mood_set 更新；无变化不必每轮写入。',
    '情绪只描述此刻的倾向与唤醒度，不是记忆：项目事实用 memory_write，不要写进情绪。',
  ]
  if (options.missingRecord) {
    lines.push('（尚无情绪记录：出现明确状态时可写第一条，之后只在变化时更新。）')
  }
  return lines.join('\n')
}
