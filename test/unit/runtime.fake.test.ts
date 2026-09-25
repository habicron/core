import type { DurableHabitState, DurableHabitStorage, DurableHabitTransaction } from '../../src/cloudflare/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DurableHabitRuntime } from '../../src/cloudflare/index'

class FakeStorage implements DurableHabitStorage {
  data = new Map<string, unknown>()
  alarm: number | null = null
  failNextTransaction = false
  #tail: Promise<void> = Promise.resolve()

  async transaction<T>(closure: (txn: DurableHabitTransaction) => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      if (this.failNextTransaction) {
        this.failNextTransaction = false
        throw new Error('storage unavailable')
      }
      const draft = new Map([...this.data].map(([key, value]) => [key, structuredClone(value)]))
      let draftAlarm = this.alarm
      const txn: DurableHabitTransaction = {
        get: async <T>(key: string) => draft.get(key) as T | undefined,
        put: async <T>(key: string, value: T) => { draft.set(key, structuredClone(value)) },
        getAlarm: async () => draftAlarm,
        setAlarm: async (value) => { draftAlarm = value instanceof Date ? value.getTime() : value },
        deleteAlarm: async () => { draftAlarm = null },
      }
      const result = await closure(txn)
      this.data = draft
      this.alarm = draftAlarm
      return result
    }
    finally {
      release()
    }
  }

  get<T>(key: string): T | undefined { return this.data.get(key) as T | undefined }
  put<T>(key: string, value: T): void { this.data.set(key, structuredClone(value)) }
  getAlarm(): number | null { return this.alarm }
  setAlarm(value: number | Date): void { this.alarm = value instanceof Date ? value.getTime() : value }
  deleteAlarm(): void { this.alarm = null }

  state(): DurableHabitState {
    const state = [...this.data.values()].find(value => (value as DurableHabitState)?.version === 1)
    if (state == null)
      throw new Error('state not found')
    return state as DurableHabitState
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('durableHabitRuntime with transactional fake storage', () => {
  let storage: FakeStorage
  let now: number
  let runtime: DurableHabitRuntime

  beforeEach(() => {
    storage = new FakeStorage()
    now = 0
    runtime = new DurableHabitRuntime({ storage, now: () => now })
  })

  it('is unarmed initially and rejects lifecycle changes', async () => {
    await expect(runtime.snapshot()).resolves.toBeNull()
    await expect(runtime.pause()).rejects.toThrow('has not been armed')
  })

  it('increments generation for every explicit arm', async () => {
    await expect(runtime.arm({ id: 'ride', every: '5s' })).resolves.toMatchObject({ generation: 1 })
    await expect(runtime.arm({ id: 'ride', every: '3s' })).resolves.toMatchObject({ generation: 2 })
  })

  it('retries one claim and retains a recovery alarm after failure', async () => {
    await runtime.arm({ id: 'ride', every: '5s' })
    now = 5_000
    const seen: Array<{ id: string, firedAt: number }> = []
    await runtime.handleAlarm(async (tick) => {
      seen.push({ id: tick.tickId, firedAt: tick.firedAt })
      throw new Error('queue unavailable')
    })
    expect(storage.alarm).toBe(10_000)
    now = 10_000
    await runtime.handleAlarm(async (tick) => {
      seen.push({ id: tick.tickId, firedAt: tick.firedAt })
    })
    expect(seen[0].id).toBe(seen[1].id)
    expect(seen[0].firedAt).not.toBe(seen[1].firedAt)
  })

  it('keeps the claim after a post-send storage failure', async () => {
    await runtime.arm({ id: 'ride', every: '5s' })
    now = 5_000
    const alarm = runtime.handleAlarm(async () => {
      storage.failNextTransaction = true
    })
    await expect(alarm).rejects.toThrow('storage unavailable')
    expect(storage.state().currentTick?.tickId).toBe('ride:1:1:5000')
    expect(storage.alarm).toBe(10_000)
  })

  it('fences a stale completion after rearm', async () => {
    const gate = deferred()
    await runtime.arm({ id: 'ride', every: '5s' })
    now = 5_000
    const oldAlarm = runtime.handleAlarm(async () => gate.promise)
    await vi.waitFor(() => expect(storage.state().currentTick).not.toBeNull())
    now = 5_001
    await runtime.arm({ id: 'ride', every: '3s' })
    gate.resolve()
    await oldAlarm
    expect(await runtime.snapshot()).toMatchObject({ generation: 2, nextSequence: 1 })
    expect(storage.alarm).toBe(8_001)
  })

  it('does not dispatch an early duplicate alarm', async () => {
    await runtime.arm({ id: 'ride', every: '5s' })
    now = 2_000
    const dispatch = vi.fn()
    await runtime.handleAlarm(dispatch)
    expect(dispatch).not.toHaveBeenCalled()
    expect(storage.alarm).toBe(5_000)
  })

  it('pause abandons a claim and resume skips to a future grid point', async () => {
    await runtime.arm({ id: 'ride', every: '5s' })
    now = 5_000
    await runtime.handleAlarm(async () => {
      throw new Error('failed')
    })
    await runtime.pause()
    expect(storage.alarm).toBeNull()
    expect(storage.state().currentTick).toBeNull()
    now = 21_000
    await expect(runtime.resume()).resolves.toMatchObject({ generation: 1, nextSequence: 5, nextAt: 25_000 })
  })

  it('cancel is terminal for the generation', async () => {
    await runtime.arm({ id: 'ride', every: '5s' })
    await expect(runtime.cancel()).resolves.toMatchObject({ status: 'cancelled', nextAt: null })
    expect(storage.alarm).toBeNull()
    await expect(runtime.resume()).rejects.toThrow('Cannot resume')
  })

  it('expires at the immutable ceiling and never rearms', async () => {
    await runtime.arm({ id: 'ride', every: '5s', maxDurationMs: 12_000 })
    now = 12_000
    const dispatch = vi.fn()
    await expect(runtime.handleAlarm(dispatch)).resolves.toMatchObject({ status: 'expired', nextAt: null })
    expect(dispatch).not.toHaveBeenCalled()
    expect(storage.alarm).toBeNull()
  })

  it('rejects the in-process multiple-habit shape at runtime', async () => {
    await expect(runtime.arm({ id: 'x', habits: [] } as never)).rejects.toThrow('one habit')
  })
})
