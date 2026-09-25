import { describe, expect, it } from 'vitest'
import { chooseNextDeadline, parseDurableHabitSpec, tickId } from '../schedule'

describe('durable Cloudflare schedule math', () => {
  it.each([['3s', 3_000], ['5s', 5_000], ['30m', 1_800_000]])(
    'parses %s through the core parser',
    (every, intervalMs) => {
      expect(parseDurableHabitSpec({ id: 'x', every }, 1_000).intervalMs).toBe(intervalMs)
    },
  )

  it('uses fixed-grid deadlines and skips missed sequences', () => {
    const state = { startedAt: 5_000, intervalMs: 5_000, jitterMinMs: 0, jitterMaxMs: 0 }
    expect(chooseNextDeadline(state, 1, 4_999)).toEqual({ sequence: 1, scheduledAt: 5_000 })
    expect(chooseNextDeadline(state, 2, 16_000)).toEqual({ sequence: 4, scheduledAt: 20_000 })
  })

  it('keeps searching when negative jitter places a candidate in the past', () => {
    const state = { startedAt: 10_000, intervalMs: 10_000, jitterMinMs: 4_000, jitterMaxMs: 4_000 }
    const random = vi.fn().mockReturnValue(0)
    expect(chooseNextDeadline(state, 1, 7_000, random)).toEqual({ sequence: 2, scheduledAt: 16_000 })
  })

  it('rejects jitter that can reorder adjacent ticks', () => {
    expect(() => parseDurableHabitSpec({ id: 'x', every: '5s', jitter: '2.5s' }, 0))
      .toThrow('jitter must be less than half')
  })

  it('converts maxDurationMs once and rejects ambiguous expiry', () => {
    expect(parseDurableHabitSpec({ id: 'x', every: '5s', maxDurationMs: 60_000 }, 10_000).expiresAt)
      .toBe(70_000)
    expect(() => parseDurableHabitSpec({ id: 'x', every: '5s', expiresAt: 20_000, maxDurationMs: 10_000 }, 0))
      .toThrow('not both')
  })

  it('creates a deterministic logical tick identity', () => {
    expect(tickId('ride', 3, 9, 45_000)).toBe('ride:3:9:45000')
  })
})
