import type { DurableHabitSpec, DurableHabitState } from './types'
import { normalize } from '../core/index'

export interface ParsedDurableHabitSpec {
  id: string
  every: string
  intervalMs: number
  jitterMinMs: number
  jitterMaxMs: number
  startedAt: number
  expiresAt: number | null
}

export function parseDurableHabitSpec(spec: DurableHabitSpec, now: number): ParsedDurableHabitSpec {
  // eslint-disable-next-line ts/strict-boolean-expressions -- JavaScript callers can violate the declared runtime boundary.
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    throw new Error('Durable habit spec must be an object')

  if ('habits' in spec)
    throw new Error('DurableHabitRuntime supports one habit per Durable Object')

  if (!spec.id?.trim())
    throw new Error('Durable habit id is required')

  if (spec.missedTickPolicy != null && spec.missedTickPolicy !== 'skip')
    throw new Error('Only missedTickPolicy "skip" is supported')

  if (spec.expiresAt != null && spec.maxDurationMs != null)
    throw new Error('Use expiresAt or maxDurationMs, not both')

  const normalized = normalize({
    every: spec.every,
    ...(spec.jitter == null ? {} : { jitter: spec.jitter }),
  })

  if (!normalized || !Number.isFinite(normalized.intervalMs) || normalized.intervalMs <= 0)
    throw new Error('every must be a positive duration')

  const jitterMinMs = normalized.jitter?.min ?? 0
  const jitterMaxMs = normalized.jitter?.max ?? 0

  if (jitterMinMs < 0 || jitterMaxMs < jitterMinMs)
    throw new Error('jitter must be a valid non-negative range')

  if (jitterMaxMs * 2 >= normalized.intervalMs)
    throw new Error('jitter must be less than half of every')

  const startedAt = spec.startsAt ?? now + normalized.intervalMs
  if (!Number.isFinite(startedAt))
    throw new Error('startsAt must be a finite epoch-millisecond timestamp')

  let expiresAt: number | null = null
  if (spec.maxDurationMs != null) {
    if (!Number.isFinite(spec.maxDurationMs) || spec.maxDurationMs <= 0)
      throw new Error('maxDurationMs must be positive')
    expiresAt = now + spec.maxDurationMs
  }
  else if (spec.expiresAt != null) {
    if (!Number.isFinite(spec.expiresAt) || spec.expiresAt <= now)
      throw new Error('expiresAt must be in the future')
    expiresAt = spec.expiresAt
  }

  return {
    id: spec.id,
    every: spec.every,
    intervalMs: normalized.intervalMs,
    jitterMinMs,
    jitterMaxMs,
    startedAt,
    expiresAt,
  }
}

function randomUnit(random: () => number): number {
  const value = random()
  if (!Number.isFinite(value) || value < 0 || value >= 1)
    throw new Error('Random source must return a number in [0, 1)')
  return value
}

function jitterOffset(state: Pick<DurableHabitState, 'jitterMinMs' | 'jitterMaxMs'>, random: () => number): number {
  if (state.jitterMaxMs === 0)
    return 0
  const magnitude = state.jitterMinMs
    + randomUnit(random) * (state.jitterMaxMs - state.jitterMinMs)
  return randomUnit(random) < 0.5 ? -magnitude : magnitude
}

export function chooseNextDeadline(
  state: Pick<DurableHabitState, 'startedAt' | 'intervalMs' | 'jitterMinMs' | 'jitterMaxMs'>,
  fromSequence: number,
  after: number,
  random: () => number = Math.random,
): { sequence: number, scheduledAt: number } {
  const gridFloor = Math.floor((after - state.startedAt) / state.intervalMs) + 1
  let sequence = Math.max(1, fromSequence, gridFloor + 1)
  while (true) {
    const nominal = state.startedAt + (sequence - 1) * state.intervalMs
    const scheduledAt = nominal + jitterOffset(state, random)
    if (scheduledAt > after)
      return { sequence, scheduledAt }
    sequence++
  }
}

export function tickId(habitId: string, generation: number, sequence: number, scheduledAt: number): string {
  return `${habitId}:${generation}:${sequence}:${scheduledAt}`
}
