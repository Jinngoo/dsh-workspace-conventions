import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MOOD_HALF_LIFE_HOURS,
  DEFAULT_MOOD_MAX_AGE_HOURS,
  MOOD_FILE_NAME,
  buildMoodDocument,
  moodView,
  parseMoodDocument,
  renderMoodSection,
  type MoodDecayOptions,
  type MoodRenderOptions,
  type MoodState,
} from '../src/mood.ts'
import { byteLength } from '../src/text.ts'

/** 固定时刻：本地时间 2026-10-23 00:12；毫秒为 0，避免年龄换算被毫秒误差影响。 */
const T0 = new Date(2026, 9, 23, 0, 12, 0, 0)

/** 距 `T0` 若干小时之后的时刻。 */
function at(hours: number): Date {
  return new Date(T0.getTime() + hours * 3_600_000)
}

/** 默认衰减参数：半衰期 6 小时、最大年龄 48 小时。 */
const DECAY: MoodDecayOptions = { halfLifeHours: 6, maxAgeHours: 48 }

/** 一份完整状态：标签 + 数值 + 备注。 */
function buildFocus(): string {
  return buildMoodDocument(
    { label: '专注', valence: 0.4, arousal: 0.3, note: '正在收尾一个插件设计，节奏紧凑但不急躁。' },
    T0,
  )
}

/** 从文档里取状态；取不到就直接失败，避免测试里反复判空。 */
function requireState(raw: string): MoodState {
  const parsed = parseMoodDocument(raw)
  if (parsed.state === undefined) throw new Error(`expected a state, got issue: ${parsed.issue ?? '(none)'}`)
  return parsed.state
}

/** 用 `T0` 作为写入时间的一份状态。 */
function stateAt0(input: { valence?: number, arousal?: number } = {}): MoodState {
  const doc = buildMoodDocument(
    {
      label: '专注',
      ...(input.valence === undefined ? {} : { valence: input.valence }),
      ...(input.arousal === undefined ? {} : { arousal: input.arousal }),
    },
    T0,
  )
  return requireState(doc)
}

/** 渲染选项。 */
const RENDER: MoodRenderOptions = { ...DECAY, maxBytes: 512, renderQuiet: true }

describe('constants', () => {
  it('names the state file and exports the design defaults', () => {
    expect(MOOD_FILE_NAME).toBe('current.md')
    expect(DEFAULT_MOOD_HALF_LIFE_HOURS).toBe(6)
    expect(DEFAULT_MOOD_MAX_AGE_HOURS).toBe(48)
  })
})

describe('document round trip', () => {
  it('writes frontmatter plus body that the parser reads back', () => {
    const doc = buildFocus()

    expect(doc.startsWith('---\nlabel: 专注\n')).toBe(true)
    expect(doc).toContain('\nvalence: 0.4\n')
    expect(doc).toContain('\narousal: 0.3\n')
    expect(doc).toContain('\nupdated: ')
    expect(doc).toContain('节奏紧凑但不急躁')

    const state = requireState(doc)
    expect(state.label).toBe('专注')
    expect(state.valence).toBeCloseTo(0.4, 10)
    expect(state.arousal).toBeCloseTo(0.3, 10)
    expect(state.body).toBe('正在收尾一个插件设计，节奏紧凑但不急躁。')
    expect(state.bytes).toBe(byteLength(state.body))
  })

  it('stamps updated as local ISO 8601 with an explicit offset', () => {
    const state = requireState(buildMoodDocument({ label: '平静' }, T0))

    expect(state.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(state.updated?.startsWith('2026-10-23T00:12:00')).toBe(true)
    expect(Date.parse(state.updated ?? '')).toBe(T0.getTime())
  })

  it('omits keys the writer did not supply and accepts an empty body', () => {
    const state = requireState(buildMoodDocument({ label: '平静' }, T0))

    expect('valence' in state).toBe(false)
    expect('arousal' in state).toBe(false)
    expect(state.body).toBe('')
    expect(state.bytes).toBe(0)
  })

  it('keeps only the supplied optional values', () => {
    const state = requireState(buildMoodDocument({ label: '专注', arousal: 0.8 }, T0))

    expect('valence' in state).toBe(false)
    expect(state.arousal).toBeCloseTo(0.8, 10)
  })

  it('normalizes CRLF and trailing blanks in the note', () => {
    const state = requireState(buildMoodDocument({ label: '专注', note: 'a\r\nb  \r\n\r\n' }, T0))

    expect(state.body).toBe('a\nb')
  })

  it('keeps multi-line CJK prose intact', () => {
    const note = '第一行：交付压力大。\n\n第二行：但可控。'
    const state = requireState(buildMoodDocument({ label: '焦虑', note }, T0))

    expect(state.label).toBe('焦虑')
    expect(state.body).toBe(note)
    expect(state.bytes).toBe(byteLength(note))
  })

  it('collapses a multi-line label to one line', () => {
    const state = requireState(buildMoodDocument({ label: '专注\n仔细' }, T0))

    expect(state.label).toBe('专注 仔细')
  })

  it('clips an over-long note to the 1024-byte body budget', () => {
    const note = '中'.repeat(400)
    expect(byteLength(note)).toBe(1200)

    const state = requireState(buildMoodDocument({ label: '专注', note }, T0))

    expect(state.bytes).toBeLessThanOrEqual(1024)
    expect(state.bytes).toBe(1023)
    expect(state.body).toBe('中'.repeat(341))
  })
})

describe('document generation guards', () => {
  it('refuses an empty label', () => {
    expect(() => buildMoodDocument({ label: '   ' }, T0)).toThrow()
  })

  it('refuses out-of-range and non-finite numbers', () => {
    expect(() => buildMoodDocument({ label: '专注', valence: 1.5 }, T0)).toThrow()
    expect(() => buildMoodDocument({ label: '专注', valence: -1.5 }, T0)).toThrow()
    expect(() => buildMoodDocument({ label: '专注', arousal: -0.1 }, T0)).toThrow()
    expect(() => buildMoodDocument({ label: '专注', arousal: 1.1 }, T0)).toThrow()
    expect(() => buildMoodDocument({ label: '专注', valence: Number.NaN }, T0)).toThrow()
  })

  it('refuses an invalid date', () => {
    expect(() => buildMoodDocument({ label: '专注' }, new Date(Number.NaN))).toThrow()
  })
})

describe('parsing failures', () => {
  it('reports an empty file', () => {
    const parsed = parseMoodDocument('   \n\n')

    expect(parsed.state).toBeUndefined()
    expect(parsed.issue).toBeTruthy()
  })

  it('reports a document without frontmatter', () => {
    const parsed = parseMoodDocument('当前情绪：专注\n')

    expect(parsed.state).toBeUndefined()
    expect(parsed.issue).toContain('frontmatter')
  })

  it('reports a missing or blank label without a state', () => {
    for (const doc of ['---\nvalence: 0.4\n---\n', '---\nlabel:   \n---\n']) {
      const parsed = parseMoodDocument(doc)
      expect(parsed.state).toBeUndefined()
      expect(parsed.issue).toContain('label')
    }
  })

  it('reports an out-of-range valence without a state', () => {
    const parsed = parseMoodDocument('---\nlabel: 专注\nvalence: 1.2\n---\n')

    expect(parsed.state).toBeUndefined()
    expect(parsed.issue).toContain('valence')
  })

  it('reports a non-numeric valence without a state', () => {
    const parsed = parseMoodDocument('---\nlabel: 专注\nvalence: high\n---\n')

    expect(parsed.state).toBeUndefined()
    expect(parsed.issue).toContain('valence')
  })

  it('reports an out-of-range arousal without a state', () => {
    const parsed = parseMoodDocument('---\nlabel: 专注\narousal: -0.2\n---\n')

    expect(parsed.state).toBeUndefined()
    expect(parsed.issue).toContain('arousal')
  })

  it('keeps the state but flags an unparseable updated', () => {
    const parsed = parseMoodDocument('---\nlabel: 专注\nupdated: yesterday\n---\n备注还在\n')

    expect(parsed.state?.label).toBe('专注')
    expect(parsed.state?.body).toBe('备注还在')
    expect(parsed.issue).toContain('updated')

    const view = moodView(requireState('---\nlabel: 专注\nupdated: yesterday\n---\n'), T0, DECAY)
    expect(view.fresh).toBe(false)
    expect(view.ageHours).toBe(Number.POSITIVE_INFINITY)
    expect(view.weight).toBe(0)
  })

  it('keeps the state but flags a missing updated', () => {
    const parsed = parseMoodDocument('---\nlabel: 专注\n---\n')

    expect(parsed.state?.label).toBe('专注')
    expect(parsed.issue).toContain('updated')
    expect(parsed.state === undefined ? true : moodView(parsed.state, T0, DECAY).fresh).toBe(false)
  })

  it('rejects a timestamp without an offset, which would drift between machines', () => {
    const parsed = parseMoodDocument('---\nlabel: 专注\nupdated: 2026-10-23T00:12:00\n---\n')

    expect(parsed.state).toBeDefined()
    expect(parsed.issue).toContain('updated')
  })

  it('accepts a UTC timestamp', () => {
    const updated = T0.toISOString()
    const doc = `---\nlabel: 专注\nupdated: ${updated}\n---\n`
    const parsed = parseMoodDocument(doc)

    expect(parsed.state?.updated).toBe(updated)
    expect(parsed.issue).toBeUndefined()
    expect(moodView(requireState(doc), T0, DECAY).ageHours).toBe(0)
  })
})

describe('decay', () => {
  it('is fully fresh at 0 hours', () => {
    const view = moodView(stateAt0(), T0, DECAY)

    expect(view.fresh).toBe(true)
    expect(view.ageHours).toBe(0)
    expect(view.weight).toBe(1)
    expect(view.label).toBe('专注')
    expect(view.text).toContain('强度 1.00')
    expect(view.text).toContain('0 分钟前')
  })

  it('halves the weight after one half-life (6h)', () => {
    const view = moodView(stateAt0(), at(6), DECAY)

    expect(view.fresh).toBe(true)
    expect(view.weight).toBeCloseTo(0.5, 12)
    expect(view.text).toContain('强度 0.50')
    expect(view.text).toContain('6 小时前')
  })

  it('quarters the weight after two half-lives (12h)', () => {
    const view = moodView(stateAt0(), at(12), DECAY)

    expect(view.fresh).toBe(true)
    expect(view.weight).toBeCloseTo(0.25, 12)
    expect(view.text).toContain('强度 0.25')
    expect(view.text).toContain('12 小时前')
  })

  it('survives four half-lives (24h) as still fresh', () => {
    const view = moodView(stateAt0(), at(24), DECAY)

    expect(view.weight).toBeCloseTo(0.0625, 12)
    expect(view.fresh).toBe(true)
  })

  it('is calm at the 48h maximum age, where the weight floor has already bitten', () => {
    const view = moodView(stateAt0(), at(48), DECAY)

    expect(view.ageHours).toBe(48)
    expect(view.weight).toBeCloseTo(1 / 256, 12)
    expect(view.fresh).toBe(false)
    expect(view.label).toBeUndefined()
    expect(view.text).toBe('当前情绪：已平复')
  })

  it('fails the freshness gate on age alone even when the weight is high', () => {
    const view = moodView(stateAt0(), at(3), { halfLifeHours: 1000, maxAgeHours: 2 })

    expect(view.weight).toBeGreaterThan(0.9)
    expect(view.fresh).toBe(false)
  })

  it('fails the freshness gate on the weight floor even when the age is allowed', () => {
    const view = moodView(stateAt0(), at(30), { halfLifeHours: 6, maxAgeHours: 100 })

    expect(view.ageHours).toBe(30)
    expect(view.weight).toBeCloseTo(0.5 ** 5, 12)
    expect(view.fresh).toBe(false)
  })

  it('treats a state without a usable updated as infinitely old', () => {
    const view = moodView({ label: '专注', body: '', bytes: 0 }, T0, DECAY)

    expect(view.ageHours).toBe(Number.POSITIVE_INFINITY)
    expect(view.weight).toBe(0)
    expect(view.fresh).toBe(false)
  })

  it('clamps a future timestamp to zero age', () => {
    const future = requireState(buildMoodDocument({ label: '专注' }, at(5)))
    const view = moodView(future, T0, DECAY)

    expect(view.ageHours).toBe(0)
    expect(view.weight).toBe(1)
    expect(view.fresh).toBe(true)
  })

  it('refuses to decay with a non-positive half-life', () => {
    const view = moodView(stateAt0(), T0, { halfLifeHours: 0, maxAgeHours: 48 })

    expect(view.weight).toBe(0)
    expect(view.fresh).toBe(false)
  })

  it('is not fresh for an invalid now', () => {
    const view = moodView(stateAt0(), new Date(Number.NaN), DECAY)

    expect(view.ageHours).toBe(Number.POSITIVE_INFINITY)
    expect(view.fresh).toBe(false)
  })
})

describe('valence and arousal mapping', () => {
  /**
   * 直接构造状态：映射边界的断言不该被「写盘只保留 4 位小数」影响（1/3 写成
   * 0.3333 后本来就低于 1/3 的阈值，那是文件精度问题，不是映射问题）。
   */
  function tuned(valence?: number, arousal?: number): MoodState {
    const updated = stateAt0().updated
    return {
      label: '专注',
      ...(valence === undefined ? {} : { valence }),
      ...(arousal === undefined ? {} : { arousal }),
      ...(updated === undefined ? {} : { updated }),
      body: '',
      bytes: 0,
    }
  }

  it('maps valence across the documented boundaries', () => {
    const trend = (valence: number): string => moodView(tuned(valence), T0, DECAY).text

    expect(trend(1)).toContain('（积极、')
    expect(trend(0.5)).toContain('（积极、')
    expect(trend(0.49)).toContain('（偏积极、')
    expect(trend(0.15)).toContain('（偏积极、')
    expect(trend(0.14)).toContain('（中性、')
    expect(trend(0)).toContain('（中性、')
    expect(trend(-0.14)).toContain('（中性、')
    expect(trend(-0.15)).toContain('（偏消极、')
    expect(trend(-0.49)).toContain('（偏消极、')
    expect(trend(-0.5)).toContain('（消极、')
    expect(trend(-1)).toContain('（消极、')
  })

  it('reads a missing valence as neutral', () => {
    expect(moodView(stateAt0(), T0, DECAY).text).toContain('（中性、')
  })

  it('maps arousal across the documented thirds', () => {
    const energy = (arousal: number): string => moodView(tuned(undefined, arousal), T0, DECAY).text

    expect(energy(1)).toContain('、活跃，')
    expect(energy(2 / 3)).toContain('、活跃，')
    expect(energy(0.6)).toContain('、适中，')
    expect(energy(1 / 3)).toContain('、适中，')
    expect(energy(0.3)).toContain('、平静，')
    expect(energy(0)).toContain('、平静，')
  })

  it('reads a missing arousal as moderate', () => {
    expect(moodView(stateAt0(), T0, DECAY).text).toContain('、适中，')
  })

  it('renders sub-hour ages in minutes and whole hours otherwise', () => {
    expect(moodView(stateAt0(), at(0.4), DECAY).text).toContain('24 分钟前')
    expect(moodView(stateAt0(), at(0.5), DECAY).text).toContain('30 分钟前')
    expect(moodView(stateAt0(), at(1.5), DECAY).text).toContain('1 小时前')
  })

  it('is deterministic for identical inputs', () => {
    expect(moodView(stateAt0(), at(3), DECAY)).toEqual(moodView(stateAt0(), at(3), DECAY))
  })
})

describe('section rendering', () => {
  it('renders heading, status line and note when fresh', () => {
    const text = renderMoodSection(requireState(buildFocus()), at(6), RENDER)

    expect(text).toBe(
      '## 情绪\n当前情绪：专注（偏积极、平静，强度 0.50，6 小时前）\n\n正在收尾一个插件设计，节奏紧凑但不急躁。',
    )
  })

  it('renders the body straight after the status line when there is no note', () => {
    const text = renderMoodSection(requireState(buildMoodDocument({ label: '专注' }, T0)), T0, RENDER)

    expect(text).toBe('## 情绪\n当前情绪：专注（中性、适中，强度 1.00，0 分钟前）')
  })

  it('renders one calm line when stale and quiet rendering is on', () => {
    expect(renderMoodSection(stateAt0(), at(48), RENDER)).toBe('## 情绪\n当前情绪：已平复')
  })

  it('renders nothing when stale and quiet rendering is off', () => {
    expect(renderMoodSection(stateAt0(), at(48), { ...RENDER, renderQuiet: false })).toBe('')
  })

  it('renders nothing when there is no state at all', () => {
    expect(renderMoodSection(undefined, T0, RENDER)).toBe('')
    expect(renderMoodSection(undefined, T0, { ...RENDER, renderQuiet: false })).toBe('')
  })

  it('clips a long CJK section to the byte budget without splitting a code point', () => {
    const note = '中'.repeat(200)
    const state = requireState(buildMoodDocument({ label: '专注', note }, T0))
    const full = renderMoodSection(state, T0, { ...RENDER, maxBytes: 4096 })
    const clipped = renderMoodSection(state, T0, { ...RENDER, maxBytes: 120 })

    expect(byteLength(clipped)).toBeLessThanOrEqual(120)
    expect(clipped.length).toBeLessThan(full.length)
    expect(full.startsWith(clipped)).toBe(true)
    expect(clipped.includes('\uFFFD')).toBe(false)
    expect(clipped.startsWith('## 情绪\n当前情绪：')).toBe(true)
  })

  it('renders nothing when the budget is non-positive', () => {
    expect(renderMoodSection(stateAt0(), T0, { ...RENDER, maxBytes: 0 })).toBe('')
  })

  it('is deterministic for identical inputs', () => {
    const state = requireState(buildFocus())
    expect(renderMoodSection(state, at(2), RENDER)).toBe(renderMoodSection(state, at(2), RENDER))
  })
})
