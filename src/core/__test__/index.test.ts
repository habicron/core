import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHabits, createHabit, dur, getHabit, listHabits, longTimeout, nextRuns, normalize, resolveJitter, subscribeHabits } from '../index'

describe('dur', () => {
  it('passes numbers through as milliseconds', () => {
    expect(dur(1500)).toBe(1500)
  })

  it('parses single units', () => {
    expect(dur('500ms')).toBe(500)
    expect(dur('20s')).toBe(20_000)
    expect(dur('2h')).toBe(2 * 60 * 60 * 1000)
    expect(dur('3d')).toBe(3 * 24 * 60 * 60 * 1000)
  })

  it('parses compound and longest-token-first units', () => {
    expect(dur('1h30m')).toBe(90 * 60 * 1000)
    expect(dur('5min')).toBe(5 * 60 * 1000)
    expect(dur('5mo')).toBe(5 * (30.436875 * 24 * 60 * 60 * 1000))
  })
})

describe('resolveJitter', () => {
  it('treats a bare duration as { min: 0, max }', () => {
    expect(resolveJitter('5m')).toEqual({ min: 0, max: 5 * 60 * 1000 })
  })
  it('accepts tuple and object forms', () => {
    expect(resolveJitter(['3s', '5s'])).toEqual({ min: 3000, max: 5000 })
    expect(resolveJitter({ min: '1s', max: '2s' })).toEqual({ min: 1000, max: 2000 })
  })
  it('returns null for empty jitter', () => {
    expect(resolveJitter(undefined)).toBeNull()
    expect(resolveJitter(0)).toBeNull()
  })
})

describe('normalize', () => {
  it('resolves `every`', () => {
    expect(normalize({ every: '20s' })).toEqual({ intervalMs: 20_000, jitter: null })
  })
  it('resolves the packed `2h ~ 5m` form', () => {
    expect(normalize({ every: '2h ~ 5m' })).toEqual({
      intervalMs: 2 * 60 * 60 * 1000,
      jitter: { min: 0, max: 5 * 60 * 1000 },
    })
  })
  it('accepts typeable jitter separators (~, +/-, +-) and the ± glyph', () => {
    const expected = { intervalMs: 2 * 60 * 60 * 1000, jitter: { min: 0, max: 5 * 60 * 1000 } }
    expect(normalize({ every: '2h +/- 5m' })).toEqual(expected)
    expect(normalize({ every: '2h +- 5m' })).toEqual(expected)
    expect(normalize({ every: '2h ± 5m' })).toEqual(expected)
  })
  it('resolves `times`/`per`', () => {
    expect(normalize({ times: 2, per: 'day' })).toEqual({
      intervalMs: (24 * 60 * 60 * 1000) / 2,
      jitter: null,
    })
  })
  it('rejects non-positive intervals', () => {
    expect(normalize({ every: 0 })).toBeNull()
  })
})

describe('longTimeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('chunks delays past the 32-bit ceiling instead of firing immediately', async () => {
    const fn = vi.fn()
    const delay = 2_147_483_647 + 60_000 // just over the ceiling
    longTimeout(fn, delay)
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancels cleanly', async () => {
    const fn = vi.fn()
    const cancel = longTimeout(fn, 1000)
    cancel()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('createHabit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires evenly with no jitter and counts each fire', async () => {
    const cb = vi.fn()
    const job = createHabit(cb, { every: '10s' })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(cb).toHaveBeenCalledTimes(3)
    expect(job.counter).toBe(3)
  })

  it('does not drift over many fires (grid-anchored)', async () => {
    const cb = vi.fn()
    const start = Date.now()
    createHabit(cb, { every: '10s', jitter: '4s', random: () => 0.99 })
    await vi.advanceTimersByTimeAsync(100_000)
    const elapsed = Date.now() - start
    // 10 fires nominally; with bounded jitter the count stays near the grid rate.
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(9)
    expect(cb.mock.calls.length).toBeLessThanOrEqual(11)
    expect(elapsed).toBe(100_000)
  })

  it('fires immediately when requested', async () => {
    const cb = vi.fn()
    const job = createHabit(cb, { every: '10s', immediate: true })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(job.counter).toBe(1)
  })

  it('stays inert when autoStart is false until start()', async () => {
    const cb = vi.fn()
    const job = createHabit(cb, { every: '10s', autoStart: false })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(cb).not.toHaveBeenCalled()
    expect(job.isActive).toBe(false)
    job.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('pauses and resumes', async () => {
    const cb = vi.fn()
    const job = createHabit(cb, { every: '10s' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(cb).toHaveBeenCalledTimes(1)
    job.pause()
    expect(job.isActive).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(cb).toHaveBeenCalledTimes(1)
    job.resume()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('reset zeroes the counter', async () => {
    const cb = vi.fn()
    const job = createHabit(cb, { every: '10s' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(job.counter).toBe(2)
    job.reset()
    expect(job.counter).toBe(0)
  })

  it('caps jitter at 0.49 * interval so fires cannot reorder', async () => {
    const cb = vi.fn()
    // huge jitter, always max magnitude, always negative sign
    const seq = [0.999, /* sign */ 0.1, 0.999, 0.1, 0.999, 0.1]
    let i = 0
    const random = () => seq[i++ % seq.length]
    createHabit(cb, { every: '10s', jitter: '100s', random })
    // first target = anchor + 10s - cap(4.9s) = ~5.1s
    await vi.advanceTimersByTimeAsync(5_000)
    expect(cb).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200) // 5.2s total
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('fires the union of multiple habits', async () => {
    const cb = vi.fn()
    createHabit(cb, { habits: [{ every: '10s' }, { every: '15s' }] })
    await vi.advanceTimersByTimeAsync(30_000)
    // 10,20,30 + 15,30 = 5 fires (two land at 30s)
    expect(cb.mock.calls.length).toBe(5)
  })

  it('survives a throwing callback', async () => {
    const cb = vi.fn(() => {
      throw new Error('boom')
    })
    const job = createHabit(cb, { every: '10s' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(job.counter).toBe(2)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('notifies subscribers on state change', async () => {
    const listener = vi.fn()
    const job = createHabit(() => {}, { every: '10s' })
    const unsub = job.subscribe(listener)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(listener).toHaveBeenCalled()
    unsub()
    const before = listener.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(listener.mock.calls.length).toBe(before)
  })
})

describe('registry', () => {
  beforeEach(() => {
    clearHabits()
    vi.useFakeTimers()
  })
  afterEach(() => {
    clearHabits()
    vi.useRealTimers()
  })

  it('lists and looks up created habits', () => {
    const a = createHabit(() => {}, { id: 'a', name: 'A', every: '10s', autoStart: false })
    const b = createHabit(() => {}, { every: '20s', autoStart: false })
    expect(listHabits()).toHaveLength(2)
    expect(getHabit('a')).toBe(a)
    expect(a.name).toBe('A')
    expect(b.id).toMatch(/^h\d+$/)
  })

  it('destroy removes from the registry and stops timers', async () => {
    const cb = vi.fn()
    const h = createHabit(cb, { every: '10s' })
    expect(getHabit(h.id)).toBe(h)
    h.destroy()
    expect(getHabit(h.id)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('update replaces the schedule in place, keeping id and counter', async () => {
    const cb = vi.fn()
    const h = createHabit(cb, { id: 'x', every: '10s' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.counter).toBe(1)
    h.update({ every: '5s' })
    expect(h.id).toBe('x')
    expect(h.counter).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.counter).toBe(2)
  })

  it('notifies registry subscribers on add and remove', () => {
    const listener = vi.fn()
    const unsub = subscribeHabits(listener)
    const h = createHabit(() => {}, { every: '10s', autoStart: false })
    const added = listener.mock.calls.length
    expect(added).toBeGreaterThan(0)
    h.destroy()
    expect(listener.mock.calls.length).toBeGreaterThan(added)
    unsub()
  })
})

describe('nextRuns', () => {
  it('lists fire times without starting a timer', () => {
    expect(nextRuns({ every: '1m' }, 3, 1000)).toEqual([61_000, 121_000, 181_000])
    expect(listHabits()).toHaveLength(0)
  })

  it('continues a series without drift', () => {
    const all = nextRuns({ every: '1m' }, 4, 0)
    expect([...nextRuns({ every: '1m' }, 2, 0), ...nextRuns({ every: '1m' }, 2, 0, 2)]).toEqual(all)
  })

  it('keeps jittered fires ordered and within the jitter bound', () => {
    const runs = nextRuns({ every: '1m', jitter: '10s' }, 20, 0)
    expect([...runs].sort((a, b) => a - b)).toEqual(runs)
    runs.forEach((at, i) => expect(Math.abs(at - (i + 1) * 60_000)).toBeLessThanOrEqual(10_000))
  })
})
