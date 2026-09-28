export type MaybePromise<T> = T | Promise<T>

export type DurableHabitStatus = 'active' | 'paused' | 'expired' | 'cancelled'

export interface DurableHabitSpec {
  id: string
  every: string
  jitter?: string
  /** First logical grid deadline. Defaults to arm time plus the interval. */
  startsAt?: number
  expiresAt?: number
  maxDurationMs?: number
  missedTickPolicy?: 'skip'
}

export interface DurableHabitTick {
  habitId: string
  generation: number
  sequence: number
  scheduledAt: number
  firedAt: number
  tickId: string
  expiresAt: number | null
}

export interface DurableHabitSnapshot {
  habitId: string
  generation: number
  status: DurableHabitStatus
  nextSequence: number
  nextAt: number | null
  expiresAt: number | null
}

export interface DurableHabitConditionalResult {
  applied: boolean
  snapshot: DurableHabitSnapshot
}

export interface DurableHabitTransaction {
  get: <T>(key: string) => MaybePromise<T | undefined>
  put: <T>(key: string, value: T) => MaybePromise<void>
  getAlarm: () => MaybePromise<number | null>
  setAlarm: (timestamp: number | Date) => MaybePromise<void>
  deleteAlarm: () => MaybePromise<void>
}

export interface DurableHabitStorage extends DurableHabitTransaction {
  transaction: <T>(closure: (txn: DurableHabitTransaction) => Promise<T>) => Promise<T>
}

export interface DurableHabitClaim {
  generation: number
  sequence: number
  scheduledAt: number
  tickId: string
}

export interface DurableHabitState {
  version: number
  habitId: string
  generation: number
  status: DurableHabitStatus
  every: string
  intervalMs: number
  jitterMinMs: number
  jitterMaxMs: number
  startedAt: number
  nextSequence: number
  nextAt: number | null
  expiresAt: number | null
  currentTick: DurableHabitClaim | null
  updatedAt: number
}
