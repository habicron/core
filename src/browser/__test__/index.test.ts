import type { HabitSummary } from '../index'
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHabits } from '../../core'
import { useHabit } from '../index'

describe('useHabit (browser)', () => {
  beforeEach(() => {
    clearHabits()
    vi.useFakeTimers()
  })
  afterEach(() => {
    clearHabits()
    vi.useRealTimers()
  })

  it('calls onActive once with the initial state, then on flips', async () => {
    const onActive = vi.fn()
    const job = useHabit(() => {}, { every: '10s', onActive })
    expect(onActive).toHaveBeenCalledTimes(1)
    expect(onActive).toHaveBeenLastCalledWith(true)
    job.pause()
    expect(onActive).toHaveBeenLastCalledWith(false)
    job.resume()
    expect(onActive).toHaveBeenLastCalledWith(true)
  })

  it('calls onFire after each fire with the new count', async () => {
    const cb = vi.fn()
    const onFire = vi.fn()
    useHabit(cb, { every: '10s', onFire })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(cb).toHaveBeenCalledTimes(2)
    expect(onFire).toHaveBeenLastCalledWith(2)
  })

  it('onChange receives a plain summary snapshot', async () => {
    const snapshots: HabitSummary[] = []
    const onChange = (summary: HabitSummary) => snapshots.push(summary)
    const job = useHabit(() => {}, { id: 'b', name: 'B', every: '10s', onChange })
    const last = snapshots.length === 0 ? undefined : snapshots[snapshots.length - 1]
    expect(last).toMatchObject({ id: 'b', name: 'B', isActive: true, counter: 0 })
    expect(last?.nextRun).toBeInstanceOf(Date)
    job.destroy()
  })

  it('does not start timers during SSR (no window)', async () => {
    const original = globalThis.window
    // @ts-expect-error simulate a server environment
    delete globalThis.window
    try {
      const cb = vi.fn()
      const onActive = vi.fn()
      useHabit(cb, { every: '10s', onActive })
      expect(onActive).toHaveBeenLastCalledWith(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(cb).not.toHaveBeenCalled()
    }
    finally {
      globalThis.window = original
    }
  })
})
