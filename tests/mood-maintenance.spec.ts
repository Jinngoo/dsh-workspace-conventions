/**
 * The `## 情绪维护` prompt section.
 *
 * Mood is opt-in: the model only has a mood if it calls `mood_set`, so the
 * section has to say when writing is worth it without inviting a write every
 * turn. The text is injected into the runtime-context snapshot, which is only
 * appended when it changes byte-for-byte — so it must be a pure function of its
 * options and contain no clock.
 */

import { describe, expect, it } from 'vitest'

import { renderMoodMaintenanceSection } from '../src/mood.ts'

/** The unconditional body, verbatim. */
const BODY = [
  '## 情绪维护',
  '情绪层已开启：本轮工作出现明确的状态变化（任务阶段切换、被纠正、卡住后突破、长任务收尾）时，可主动调用 mood_set 更新；无变化不必每轮写入。',
  '情绪只描述此刻的倾向与唤醒度，不是记忆：项目事实用 memory_write，不要写进情绪。',
]

/** The extra line only the "no record yet" state may carry. */
const MISSING_RECORD_LINE = '（尚无情绪记录：出现明确状态时可写第一条，之后只在变化时更新。）'

describe('renderMoodMaintenanceSection', () => {
  it('always renders the heading and the mood_set workflow', () => {
    const text = renderMoodMaintenanceSection({ missingRecord: false })
    expect(text).toContain('## 情绪维护')
    expect(text).toContain('mood_set')
    expect(text).toContain('无变化不必每轮写入')
    expect(text).toContain('不是记忆')
  })

  it('renders exactly the three unconditional lines when a record exists', () => {
    const text = renderMoodMaintenanceSection({ missingRecord: false })
    expect(text).toBe(BODY.join('\n'))
    expect(text).not.toContain('尚无情绪记录')
    expect(text).not.toContain(MISSING_RECORD_LINE)
  })

  it('appends the conditional first-record invitation only when the record is missing', () => {
    const text = renderMoodMaintenanceSection({ missingRecord: true })
    expect(text).toBe([...BODY, MISSING_RECORD_LINE].join('\n'))
    expect(text).toContain('尚无情绪记录')
    expect(text.split('\n')).toHaveLength(BODY.length + 1)
  })

  it('is stable across calls: no clock and no jitter', () => {
    for (const missingRecord of [false, true]) {
      const first = renderMoodMaintenanceSection({ missingRecord })
      const second = renderMoodMaintenanceSection({ missingRecord })
      expect(second).toBe(first)
      // A timestamp (ISO date or HH:MM) would rewrite the snapshot every turn.
      expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(first).not.toMatch(/\d{1,2}:\d{2}/)
    }
  })
})
