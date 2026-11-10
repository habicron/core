import type { HabitSummary, Schedule } from '../core'
/**
 * habicron — React adapter.
 *
 * Wraps the core engine in React state. Unlike the Vue adapter (which exposes
 * refs), this returns plain values that re-render the component on each change.
 * The controller is created inside `useEffect`, so it is naturally SSR-safe.
 * The hook is `useHabit`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createHabit, listHabits, subscribeHabits } from '../core'

export type { Duration, HabitSummary, Jitter, Period, Schedule } from '../core'

export interface ReactControlFlags {
  /** Fire once immediately on start (counts toward `counter`). */
  immediate?: boolean
  /** Expose `pause`, `resume`, `reset`, `isActive` on the return value. */
  controls?: boolean
  /** Random source in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number
}

/** A single inline schedule, or an explicit list of overlapping habits. */
export type UseHabitOptions = ReactControlFlags & (Schedule | { habits: Schedule[] })

export interface HabitBase {
  /** Total number of times the callback has fired. */
  counter: number
  /** Earliest upcoming fire across all habits, or `null` when stopped. */
  nextRun: Date | null
}

export interface HabitControls {
  isActive: boolean
  pause: () => void
  resume: () => void
  /** Reset `counter` to 0 and, if active, restart all habits from now. */
  reset: () => void
}

interface State {
  counter: number
  isActive: boolean
  nextRun: Date | null
}

/**
 * Schedule a callback on randomized recurring intervals — a "habit" engine.
 *
 * Accurate by default (evenly spaced, anchored to start time, no drift).
 * Add `jitter` to perturb each fire by a bounded random amount.
 *
 * The schedule is captured once when the component mounts; the callback is
 * always read fresh, so closing over changing props is safe. Control members
 * (`pause`/`resume`/`reset`/`isActive`) are returned only with `controls: true`
 * — expressed via overloads, so the return type is exact with no casting.
 *
 * @example
 * const { counter, nextRun, pause } = useHabit(act, {
 *   controls: true,
 *   every: '20s ~ 4s',
 * })
 */
export function useHabit(
  callback: () => void | Promise<void>,
  options: UseHabitOptions & { controls: true },
): HabitBase & HabitControls
export function useHabit(
  callback: () => void | Promise<void>,
  options: UseHabitOptions,
): HabitBase
export function useHabit(
  callback: () => void | Promise<void>,
  options: UseHabitOptions,
): HabitBase | (HabitBase & HabitControls) {
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  // Snapshot options once — re-runs only when the serialised schedule changes.
  const optionsKey = JSON.stringify(options, (_k: string, v: unknown) =>
    typeof v === 'function' ? undefined : v)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [state, setState] = useState<State>({ counter: 0, isActive: false, nextRun: null })
  const controlRef = useRef<ReturnType<typeof createHabit> | null>(null)

  useEffect(() => {
    const ctrl = createHabit(async () => callbackRef.current(), {
      ...optionsRef.current,
      autoStart: true,
    })
    controlRef.current = ctrl
    const sync = () => {
      // Intentional: this is an external-store subscription. The controller is
      // the source of truth; we mirror its state into React on every change and
      // once on mount (it has already started before we subscribed).
      setState({ counter: ctrl.counter, isActive: ctrl.isActive, nextRun: ctrl.nextRun })
    }
    const unsubscribe = ctrl.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      ctrl.destroy()
      controlRef.current = null
    }
  }, [optionsKey])

  const pause = useCallback(() => controlRef.current?.pause(), [])
  const resume = useCallback(() => controlRef.current?.resume(), [])
  const reset = useCallback(() => controlRef.current?.reset(), [])

  const base: HabitBase = { counter: state.counter, nextRun: state.nextRun }
  if (!options.controls)
    return base

  return {
    ...base,
    isActive: state.isActive,
    pause,
    resume,
    reset,
  }
}

/**
 * Reactively list every registered habit (from `createHabit` / `useHabit`).
 * Re-renders as habits are added, removed, or change state — a ready-made
 * management view.
 *
 * @example
 * const habits = useHabits() // [{ id, name, isActive, counter, nextRun }, …]
 */
export function useHabits(): HabitSummary[] {
  const [habits, setHabits] = useState<HabitSummary[]>([])

  useEffect(() => {
    let perHabit: Array<() => void> = []
    const refresh = () => {
      setHabits(listHabits().map(h => ({
        id: h.id,
        name: h.name,
        isActive: h.isActive,
        counter: h.counter,
        nextRun: h.nextRun,
      })))
    }
    const resubscribe = () => {
      for (const u of perHabit) u()
      perHabit = listHabits().map(h => h.subscribe(refresh))
      refresh()
    }
    resubscribe()
    const unsubscribeRegistry = subscribeHabits(resubscribe)
    return () => {
      unsubscribeRegistry()
      for (const u of perHabit) u()
    }
  }, [])

  return habits
}
