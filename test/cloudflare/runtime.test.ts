import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const TEST_EPOCH_MS = 2_000_000_000_000
const at = (offsetMs: number): number => TEST_EPOCH_MS + offsetMs

function fixture(name: string) {
  const id = env.TEST_CLOCKS.idFromName(name)
  return env.TEST_CLOCKS.get(id)
}

describe('habicron/cloudflare in Workerd', () => {
  it('persists state and sets a five-second alarm', async () => {
    const stub = fixture('arm')
    await stub.setNow(at(0))
    await expect(stub.arm({ id: 'ride', every: '5s' })).resolves.toMatchObject({
      generation: 1,
      nextSequence: 1,
      nextAt: at(5_000),
    })
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBe(at(5_000))
    })
  })

  it('claims one logical tick, advances, and rearms', async () => {
    const stub = fixture('advance')
    await stub.setNow(at(0))
    await stub.arm({ id: 'ride', every: '5s' })
    await stub.setNow(at(5_000))
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true)
    await expect(stub.attempts()).resolves.toHaveLength(1)
    await expect(stub.snapshot()).resolves.toMatchObject({ nextSequence: 2, nextAt: at(10_000) })
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBe(at(10_000))
    })
  })

  it('does not turn an early stale alarm into a new tick', async () => {
    const stub = fixture('early')
    await stub.setNow(at(0))
    await stub.arm({ id: 'ride', every: '5s' })
    await stub.setNow(at(1_000))
    await runDurableObjectAlarm(stub)
    await expect(stub.attempts()).resolves.toHaveLength(0)
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBe(at(5_000))
    })
  })

  it('retains one tick ID and a future wake after dispatch failure', async () => {
    const stub = fixture('retry')
    await stub.setNow(at(0))
    await stub.arm({ id: 'ride', every: '5s' })
    await stub.setNow(at(5_000))
    await stub.failNextDispatch()
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true)
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull()
    })
    await stub.setNow(at(10_000))
    await runDurableObjectAlarm(stub)
    const attempts = await stub.attempts()
    expect(attempts).toHaveLength(2)
    expect(attempts[0].tickId).toBe(attempts[1].tickId)
  })

  it('survives eviction with generation, sequence, deadline, and expiry', async () => {
    const stub = fixture('eviction')
    await stub.setNow(at(0))
    await stub.arm({ id: 'ride', every: '5s', expiresAt: at(60_000) })
    await stub.setNow(at(5_000))
    await runDurableObjectAlarm(stub)
    await evictDurableObject(stub)
    await stub.setNow(at(6_000))
    await expect(stub.snapshot()).resolves.toMatchObject({
      habitId: 'ride',
      generation: 1,
      nextSequence: 2,
      nextAt: at(10_000),
      expiresAt: at(60_000),
    })
  })

  it('pause and cancel delete alarms', async () => {
    const paused = fixture('pause')
    await paused.setNow(at(0))
    await paused.arm({ id: 'ride', every: '5s' })
    await paused.pause()
    await runInDurableObject(paused, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })

    const cancelled = fixture('cancel')
    await cancelled.setNow(at(0))
    await cancelled.arm({ id: 'ride', every: '5s' })
    await cancelled.cancel()
    await runInDurableObject(cancelled, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })

  it('conditionally cancels only the current generation', async () => {
    const stub = fixture('conditional-cancel')
    await stub.setNow(at(0))
    const first = await stub.arm({ id: 'ride', every: '5s' })
    const current = await stub.arm({ id: 'ride', every: '3s' })

    await expect(stub.cancelIfGeneration(first.generation)).resolves.toMatchObject({
      applied: false,
      snapshot: { generation: current.generation, status: 'active' },
    })
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBe(at(3_000))
    })

    await expect(stub.cancelIfGeneration(current.generation)).resolves.toMatchObject({
      applied: true,
      snapshot: { generation: current.generation, status: 'cancelled', nextAt: null },
    })
    await expect(stub.cancelIfGeneration(current.generation)).resolves.toMatchObject({
      applied: true,
      snapshot: { status: 'cancelled' },
    })
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })

  it('expires and refuses to rearm', async () => {
    const stub = fixture('expiry')
    await stub.setNow(at(0))
    await stub.arm({ id: 'ride', every: '5s', expiresAt: at(7_000) })
    await stub.setNow(at(7_000))
    await runDurableObjectAlarm(stub)
    await expect(stub.snapshot()).resolves.toMatchObject({ status: 'expired', nextAt: null })
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })

  it('fences completion when a new generation arms during dispatch', async () => {
    const stub = fixture('race')
    await stub.setNow(at(0))
    await stub.arm({ id: 'ride', every: '5s' })
    await stub.blockNextDispatch()
    await stub.setNow(at(5_000))
    const alarm = runDurableObjectAlarm(stub)
    await expect.poll(async () => (await stub.attempts()).length).toBe(1)
    await stub.setNow(at(5_001))
    await stub.arm({ id: 'ride', every: '3s' })
    await stub.releaseDispatch()
    await alarm
    await expect(stub.snapshot()).resolves.toMatchObject({ generation: 2, nextSequence: 1, nextAt: at(8_001) })
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBe(at(8_001))
    })
  })

  it('cannot recall a tick whose dispatch already started', async () => {
    const stub = fixture('cancel-race')
    await stub.setNow(at(0))
    const armed = await stub.arm({ id: 'ride', every: '5s' })
    await stub.blockNextDispatch()
    await stub.setNow(at(5_000))
    const alarm = runDurableObjectAlarm(stub)
    await expect.poll(async () => (await stub.attempts()).length).toBe(1)

    await expect(stub.cancelIfGeneration(armed.generation)).resolves.toMatchObject({
      applied: true,
      snapshot: { status: 'cancelled' },
    })
    await stub.releaseDispatch()
    await alarm

    await expect(stub.attempts()).resolves.toMatchObject([{
      generation: armed.generation,
      tickId: `ride:${armed.generation}:1:${at(5_000)}`,
    }])
    await expect(stub.snapshot()).resolves.toMatchObject({
      generation: armed.generation,
      status: 'cancelled',
      nextAt: null,
    })
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })

  it('explicitly rejects multiple schedules', async () => {
    await expect(fixture('many').armManyError()).resolves.toContain('one habit')
  })
})
