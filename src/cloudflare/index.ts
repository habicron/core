import type {
  DurableHabitClaim,
  DurableHabitConditionalResult,
  DurableHabitSnapshot,
  DurableHabitSpec,
  DurableHabitState,
  DurableHabitStorage,
  DurableHabitTick,
  DurableHabitTransaction,
} from './types'
import { chooseNextDeadline, parseDurableHabitSpec, tickId } from './schedule'

export type {
  DurableHabitConditionalResult,
  DurableHabitSnapshot,
  DurableHabitSpec,
  DurableHabitStatus,
  DurableHabitStorage,
  DurableHabitTick,
  DurableHabitTransaction,
} from './types'

const STATE_KEY = '__habicron_durable_habit_v1__'

function requireExpectedGeneration(expectedGeneration: number): void {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
    throw new Error('expectedGeneration must be a positive safe integer')
}

function snapshotOf(state: DurableHabitState): DurableHabitSnapshot {
  return {
    habitId: state.habitId,
    generation: state.generation,
    status: state.status,
    nextSequence: state.nextSequence,
    nextAt: state.nextAt,
    expiresAt: state.expiresAt,
  }
}

async function readState(txn: DurableHabitTransaction): Promise<DurableHabitState | null> {
  return await txn.get<DurableHabitState>(STATE_KEY) ?? null
}

async function writeState(txn: DurableHabitTransaction, state: DurableHabitState): Promise<void> {
  await txn.put(STATE_KEY, state)
}

function expireIfDue(state: DurableHabitState, now: number): boolean {
  if (state.expiresAt == null || now < state.expiresAt || state.status === 'cancelled')
    return false

  state.status = 'expired'
  state.nextAt = null
  state.currentTick = null
  state.updatedAt = now
  return true
}

function boundedAlarm(...values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value))
  return finite.length === 0 ? null : Math.min(...finite)
}

async function reconcileAlarm(
  txn: DurableHabitTransaction,
  state: DurableHabitState,
  now: number,
): Promise<void> {
  if (expireIfDue(state, now))
    await writeState(txn, state)

  if (state.status !== 'active') {
    await txn.deleteAlarm()
    return
  }

  const recoveryAt = state.currentTick == null ? null : now + state.intervalMs
  const alarmAt = boundedAlarm(recoveryAt, state.currentTick == null ? state.nextAt : null, state.expiresAt)
  if (alarmAt == null)
    await txn.deleteAlarm()
  else
    await txn.setAlarm(alarmAt)
}

function claimToTick(state: DurableHabitState, claim: DurableHabitClaim, firedAt: number): DurableHabitTick {
  return {
    habitId: state.habitId,
    generation: claim.generation,
    sequence: claim.sequence,
    scheduledAt: claim.scheduledAt,
    firedAt,
    tickId: claim.tickId,
    expiresAt: state.expiresAt,
  }
}

export class DurableHabitRuntime {
  readonly #storage: DurableHabitStorage
  readonly #now: () => number

  constructor(options: { storage: DurableHabitStorage, now?: () => number }) {
    this.#storage = options.storage
    this.#now = options.now ?? Date.now
  }

  async arm(spec: DurableHabitSpec): Promise<DurableHabitSnapshot> {
    return (await this.#arm(spec)).snapshot
  }

  async armIfGeneration(
    spec: DurableHabitSpec,
    expectedGeneration: number | null,
  ): Promise<DurableHabitConditionalResult> {
    if (expectedGeneration !== null)
      requireExpectedGeneration(expectedGeneration)
    return this.#arm(spec, expectedGeneration)
  }

  async #arm(
    spec: DurableHabitSpec,
    expectedGeneration?: number | null,
  ): Promise<DurableHabitConditionalResult> {
    const now = this.#now()
    const parsed = parseDurableHabitSpec(spec, now)
    return this.#storage.transaction(async (txn) => {
      const previous = await readState(txn)

      if (previous != null && previous.habitId !== parsed.id)
        throw new Error('A Durable Object cannot change durable habit id')

      if (expectedGeneration !== undefined) {
        if (previous != null && expireIfDue(previous, now)) {
          await writeState(txn, previous)
          await txn.deleteAlarm()
          return { applied: false, snapshot: snapshotOf(previous) }
        }
        if (previous == null && expectedGeneration !== null)
          throw new Error('Durable habit has not been armed')
        if (previous != null && (expectedGeneration === null || previous.generation !== expectedGeneration))
          return { applied: false, snapshot: snapshotOf(previous) }
        if (previous?.status === 'cancelled' || previous?.status === 'expired')
          return { applied: false, snapshot: snapshotOf(previous) }
      }

      const generation = (previous?.generation ?? 0) + 1
      const state: DurableHabitState = {
        version: 1,
        habitId: parsed.id,
        generation,
        status: 'active',
        every: parsed.every,
        intervalMs: parsed.intervalMs,
        jitterMinMs: parsed.jitterMinMs,
        jitterMaxMs: parsed.jitterMaxMs,
        startedAt: parsed.startedAt,
        nextSequence: 1,
        nextAt: null,
        expiresAt: parsed.expiresAt,
        currentTick: null,
        updatedAt: now,
      }
      const next = chooseNextDeadline(state, 1, now - 1)
      state.nextSequence = next.sequence
      state.nextAt = parsed.expiresAt != null && next.scheduledAt >= parsed.expiresAt
        ? null
        : next.scheduledAt
      await writeState(txn, state)
      await reconcileAlarm(txn, state, now)
      return { applied: true, snapshot: snapshotOf(state) }
    })
  }

  async pause(): Promise<DurableHabitSnapshot> {
    return (await this.#pause()).snapshot
  }

  async pauseIfGeneration(expectedGeneration: number): Promise<DurableHabitConditionalResult> {
    requireExpectedGeneration(expectedGeneration)
    return this.#pause(expectedGeneration)
  }

  async #pause(expectedGeneration?: number): Promise<DurableHabitConditionalResult> {
    return this.#storage.transaction(async (txn) => {
      const state = await this.#requiredState(txn)
      const now = this.#now()
      if (expireIfDue(state, now)) {
        await writeState(txn, state)
        await txn.deleteAlarm()
        return { applied: false, snapshot: snapshotOf(state) }
      }
      if (expectedGeneration !== undefined && state.generation !== expectedGeneration)
        return { applied: false, snapshot: snapshotOf(state) }
      if (expectedGeneration !== undefined && state.status === 'cancelled')
        return { applied: false, snapshot: snapshotOf(state) }
      if (state.status === 'active') {
        if (state.currentTick != null)
          state.nextSequence = Math.max(state.nextSequence, state.currentTick.sequence + 1)
        state.status = 'paused'
        state.currentTick = null
        state.nextAt = null
        state.updatedAt = now
      }
      await writeState(txn, state)
      await txn.deleteAlarm()
      return { applied: true, snapshot: snapshotOf(state) }
    })
  }

  async resume(): Promise<DurableHabitSnapshot> {
    return (await this.#resume()).snapshot
  }

  async resumeIfGeneration(expectedGeneration: number): Promise<DurableHabitConditionalResult> {
    requireExpectedGeneration(expectedGeneration)
    return this.#resume(expectedGeneration)
  }

  async #resume(expectedGeneration?: number): Promise<DurableHabitConditionalResult> {
    return this.#storage.transaction(async (txn) => {
      const state = await this.#requiredState(txn)
      const now = this.#now()

      if (expireIfDue(state, now)) {
        await writeState(txn, state)
        await txn.deleteAlarm()
        return { applied: false, snapshot: snapshotOf(state) }
      }

      if (expectedGeneration !== undefined && state.generation !== expectedGeneration)
        return { applied: false, snapshot: snapshotOf(state) }

      if (state.status === 'cancelled') {
        if (expectedGeneration !== undefined)
          return { applied: false, snapshot: snapshotOf(state) }
        throw new Error('Cannot resume a cancelled durable habit')
      }

      if (state.status === 'paused') {
        const next = chooseNextDeadline(state, state.nextSequence, now)

        state.status = 'active'

        state.nextSequence = next.sequence

        state.nextAt = state.expiresAt != null && next.scheduledAt >= state.expiresAt
          ? null
          : next.scheduledAt
        state.updatedAt = now
        await writeState(txn, state)
      }

      await reconcileAlarm(txn, state, now)
      return { applied: true, snapshot: snapshotOf(state) }
    })
  }

  async cancel(): Promise<DurableHabitSnapshot> {
    return this.#storage.transaction(async (txn) => {
      const state = await this.#requiredState(txn)
      const now = this.#now()
      expireIfDue(state, now)
      if (state.status !== 'expired')
        state.status = 'cancelled'
      state.currentTick = null
      state.nextAt = null
      state.updatedAt = now
      await writeState(txn, state)
      await txn.deleteAlarm()
      return snapshotOf(state)
    })
  }

  // This function helps to cancel the habit if the current generation matches the expected generation. Otherwise, it will return the current generation and snapshot. Due to the network latency, the cancellation command from an old run (or old configuration) may arrive late, accidentally killing a NEW run just created on the same ID.
  async cancelIfGeneration(expectedGeneration: number): Promise<DurableHabitConditionalResult> {
    requireExpectedGeneration(expectedGeneration)

    return this.#storage.transaction(async (txn) => {
      const state = await this.#requiredState(txn)
      const now = this.#now()
      if (expireIfDue(state, now)) {
        await writeState(txn, state)
        await txn.deleteAlarm()
        return { applied: false, snapshot: snapshotOf(state) }
      }
      if (state.generation !== expectedGeneration)
        return { applied: false, snapshot: snapshotOf(state) }

      state.status = 'cancelled'
      state.currentTick = null
      state.nextAt = null
      state.updatedAt = now
      await writeState(txn, state)
      await txn.deleteAlarm()
      return { applied: true, snapshot: snapshotOf(state) }
    })
  }

  async snapshot(): Promise<DurableHabitSnapshot | null> {
    return this.#storage.transaction(async (txn) => {
      const state = await readState(txn)
      if (state == null)
        return null
      const now = this.#now()
      if (expireIfDue(state, now)) {
        await writeState(txn, state)
        await txn.deleteAlarm()
      }
      return snapshotOf(state)
    })
  }

  async handleAlarm(dispatch: (tick: DurableHabitTick) => Promise<void>): Promise<DurableHabitSnapshot> {
    const firedAt = this.#now()
    const claimed = await this.#storage.transaction(async (txn) => {
      const state = await this.#requiredState(txn)

      if (expireIfDue(state, firedAt) || state.status !== 'active') {
        await writeState(txn, state)
        await reconcileAlarm(txn, state, firedAt)
        return { tick: null, snapshot: snapshotOf(state) }
      }

      if (state.currentTick == null) {
        if (state.nextAt == null || state.nextAt > firedAt) {
          await reconcileAlarm(txn, state, firedAt)
          return { tick: null, snapshot: snapshotOf(state) }
        }

        state.currentTick = {
          generation: state.generation,
          sequence: state.nextSequence,
          scheduledAt: state.nextAt,
          tickId: tickId(state.habitId, state.generation, state.nextSequence, state.nextAt),
        }

        state.updatedAt = firedAt
        await writeState(txn, state)
      }

      await reconcileAlarm(txn, state, firedAt)
      return { tick: claimToTick(state, state.currentTick, firedAt), snapshot: snapshotOf(state) }
    })

    const claimedTick = claimed.tick
    if (claimedTick == null)
      return claimed.snapshot

    let dispatchError: unknown
    try {
      await dispatch(claimedTick)
    }
    catch (error) {
      dispatchError = error
    }

    const completedAt = this.#now()
    const snapshot = await this.#storage.transaction(async (txn) => {
      const state = await this.#requiredState(txn)
      const sameClaim = state.status === 'active'
        && state.generation === claimedTick.generation
        && state.currentTick?.tickId === claimedTick.tickId

      if (sameClaim && dispatchError == null) {
        const next = chooseNextDeadline(state, claimedTick.sequence + 1, completedAt)
        state.currentTick = null
        state.nextSequence = next.sequence
        state.nextAt = state.expiresAt != null && next.scheduledAt >= state.expiresAt
          ? null
          : next.scheduledAt
        state.updatedAt = completedAt
        await writeState(txn, state)
      }

      await reconcileAlarm(txn, state, completedAt)
      return snapshotOf(state)
    })

    return snapshot
  }

  async #requiredState(txn: DurableHabitTransaction): Promise<DurableHabitState> {
    const state = await readState(txn)
    if (state == null)
      throw new Error('Durable habit has not been armed')
    if (state.version !== 1)
      throw new Error(`Unsupported durable habit state version: ${String(state.version)}`)
    return state
  }
}
