/**
 * habicron core — the framework-agnostic randomized recurring scheduler.
 *
 * A "habit" is `{ intervalMs, jitter }`. The engine fires a callback on the
 * union of all habits, each habit reschedules itself, and every next fire is
 * computed against a fixed grid (`anchor + count * interval`) so the long-run
 * rate stays exact — accurate by default, optionally jittered with no drift.
 *
 * This module has no framework or platform dependencies. The Vue, React, Node
 * and CLI entry points are thin adapters over {@link createHabit}.
 */

// ---------------------------------------------------------------------------
// Time constants (milliseconds). `MO`/`Y` are averages, not calendar-exact.
// ---------------------------------------------------------------------------
const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H
const W = 7 * D
const MO = 30.436875 * D // average month
const Y = 365.25 * D // average year

const PERIOD: Record<Period, number> = {
  minute: M,
  hour: H,
  day: D,
  week: W,
  month: MO,
  year: Y,
}

/** `setTimeout`'s 32-bit ceiling (~24.8 days). Larger delays fire immediately. */
const MAX_DELAY = 2_147_483_647

// duration units, longest tokens first so the regex never mis-matches
const UNIT: Record<string, number> = { ms: 1, sec: S, min: M, mo: MO, hr: H, w: W, s: S, m: M, h: H, d: D, y: Y }
const TOKEN = /(\d+(?:\.\d+)?)\s*(ms|sec|min|mo|hr|[smhdwy])/g

// Separator for the packed `every` form, e.g. '2h ~ 5m' (cadence then max
// jitter). Canonical form is the typeable '~'; '+/-' and '+-' are also accepted
// (and the ± glyph still works) so the cadence/jitter split is forgiving.
const PACKED = /~|\+\/?-|±/

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Milliseconds, or a duration string: `'2h'`, `'20s'`, `'1h30m'`, `'500ms'`, `'3d'`. */
export type Duration = number | string

/**
 * Jitter magnitude (sign is always random — fires land earlier OR later).
 * - `Duration`      → max magnitude, min 0          e.g. `'5m'`
 * - `[min, max]`    → bounded magnitude             e.g. `['3s', '5s']`
 * - `{ min?, max }` → bounded magnitude, object form
 */
export type Jitter
  = | Duration
    | [min: Duration, max: Duration]
    | { min?: Duration, max: Duration }

export type Period = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

/**
 * One recurring habit. Use `every` (interval between fires) or `times`/`per`
 * ("N times per period") — never both. Jitter lives inline.
 *
 * `every` also accepts a packed form: `'2h ~ 5m'` (cadence ~ max jitter).
 */
export type Schedule
  = | { every: Duration, jitter?: Jitter, times?: never, per?: never }
    | { times: number, per: Period, jitter?: Jitter, every?: never }

export interface ControlFlags {
  /** Stable identifier for the registry. Auto-generated when omitted. */
  id?: string
  /** Human-friendly label shown by management tooling (`listHabits`, the CLI). */
  name?: string
  /** Fire once immediately on start (counts toward `counter`). */
  immediate?: boolean
  /**
   * Start the timers as soon as the controller is created. Default `true`.
   * Adapters set this to `false` to stay inert during SSR.
   */
  autoStart?: boolean
  /**
   * Random source in `[0, 1)`. Defaults to `Math.random`. Injecting a seeded
   * RNG makes jitter deterministic (used by the test-suite and the docs demo).
   */
  random?: () => number
}

/** A single inline schedule, or an explicit list of overlapping habits. */
export type HabitOptions = ControlFlags & (Schedule | { habits: Schedule[] })

/** The reactive surface every adapter maps onto its own primitives. */
export interface HabitController {
  /** Stable identifier in the registry. */
  readonly id: string
  /** Human-friendly label, or `undefined`. */
  readonly name: string | undefined
  /** Total number of times the callback has fired. */
  readonly counter: number
  /** Whether timers are currently running. */
  readonly isActive: boolean
  /** Earliest upcoming fire across all habits, or `null` when stopped. */
  readonly nextRun: Date | null
  /** (Re)start every habit from now. Pass `true` to fire once immediately. */
  start: (immediate?: boolean) => void
  /** Cancel all timers and clear `nextRun`. `counter` is preserved. */
  stop: () => void
  /** Pause if active (alias of `stop` that no-ops when already stopped). */
  pause: () => void
  /** Resume if stopped (restarts from now without an immediate fire). */
  resume: () => void
  /** Reset `counter` to 0 and, if active, restart all habits from now. */
  reset: () => void
  /** Replace the schedule (and optionally the `name`); reschedules in place. */
  update: (options: HabitOptions) => void
  /** Stop all timers and remove this habit from the registry. */
  destroy: () => void
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

/** A plain, serialisable snapshot of a habit's state (for listing UIs). */
export interface HabitSummary {
  id: string
  name: string | undefined
  isActive: boolean
  counter: number
  nextRun: Date | null
}

// ---------------------------------------------------------------------------
// Parsing & normalisation
// ---------------------------------------------------------------------------

/** Parse a duration: number (ms) or string like `'2h'`, `'1h30m'`, `'500ms'`. */
export function dur(v: Duration): number {
  if (typeof v === 'number')
    return v
  if (typeof v !== 'string')
    return 0
  let total = 0
  let match: RegExpExecArray | null
  TOKEN.lastIndex = 0
  match = TOKEN.exec(v)
  while (match != null) {
    total += Number.parseFloat(match[1]) * UNIT[match[2]]
    match = TOKEN.exec(v)
  }
  return total
}

interface JitterRange {
  min: number
  max: number
}

/** Normalise a jitter spec into a `{ min, max }` magnitude range in ms, or null. */
export function resolveJitter(j?: Jitter): JitterRange | null {
  if (j == null)
    return null
  if (typeof j === 'number' || typeof j === 'string') {
    const max = dur(j)
    return max > 0 ? { min: 0, max } : null
  }
  if (Array.isArray(j))
    return { min: dur(j[0]), max: dur(j[1]) }
  return { min: dur(j.min ?? 0), max: dur(j.max) }
}

interface Spec {
  intervalMs: number
  jitter: JitterRange | null
}

/** Reduce one schedule spec to `{ intervalMs, jitter }`, or null when invalid. */
export function normalize(s: Schedule): Spec | null {
  let intervalMs = 0
  let jitter = resolveJitter(s.jitter)
  if ('every' in s && s.every != null) {
    if (typeof s.every === 'string' && PACKED.test(s.every)) {
      const [cadence, j] = s.every.split(PACKED)
      intervalMs = dur(cadence.trim())
      if (!jitter)
        jitter = resolveJitter(j.trim())
    }
    else {
      intervalMs = dur(s.every)
    }
  }
  else if ('times' in s && s.times && s.per && PERIOD[s.per]) {
    intervalMs = PERIOD[s.per] / s.times
  }
  return intervalMs > 0 && Number.isFinite(intervalMs) ? { intervalMs, jitter } : null
}

/** `setTimeout` that survives delays beyond the 32-bit ceiling. Returns a cancel. */
export function longTimeout(fn: () => void, delay: number): () => void {
  let handle: ReturnType<typeof setTimeout>
  let remaining = Math.max(0, delay)
  let cancelled = false
  const step = () => {
    if (cancelled)
      return
    if (remaining <= MAX_DELAY) {
      handle = setTimeout(fn, remaining)
    }
    else {
      remaining -= MAX_DELAY
      handle = setTimeout(step, MAX_DELAY)
    }
  }
  step()
  return () => {
    cancelled = true
    clearTimeout(handle)
  }
}

/** Signed random offset for one fire; jitter never reorders adjacent fires (capped below half an interval). */
function jitterOffset(spec: Spec, random: () => number): number {
  if (!spec.jitter)
    return 0
  const magnitude = Math.min(spec.jitter.min + random() * (spec.jitter.max - spec.jitter.min), spec.intervalMs * 0.49)
  return (random() < 0.5 ? -1 : 1) * magnitude
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface Task extends Spec {
  anchor: number
  count: number
  nextTs: number | null
  cancel: (() => void) | null
}

function buildTasks(o: HabitOptions): Task[] {
  const list = 'habits' in o ? o.habits : [o]
  const specs = list.map(normalize).filter((s): s is Spec => s != null)
  return specs.map(spec => ({ ...spec, anchor: 0, count: 0, nextTs: null, cancel: null }))
}

// ---------------------------------------------------------------------------
// Registry — track live habits so they can be listed / updated / removed.
// This is the in-process management surface (the CLI has its own durable store).
// ---------------------------------------------------------------------------

let seq = 0
const registry = new Map<string, HabitController>()
const registryListeners = new Set<() => void>()

function notifyRegistry() {
  for (const l of registryListeners) l()
}

/** Every registered habit (active or paused), in creation order. */
export function listHabits(): HabitController[] {
  return [...registry.values()]
}

/** Look up a registered habit by its id. */
export function getHabit(id: string): HabitController | undefined {
  return registry.get(id)
}

/** Subscribe to registry changes (a habit added or removed). Returns unsubscribe. */
export function subscribeHabits(listener: () => void): () => void {
  registryListeners.add(listener)
  return () => {
    registryListeners.delete(listener)
  }
}

/** Destroy every registered habit (stops timers and empties the registry). */
export function clearHabits(): void {
  for (const h of [...registry.values()]) h.destroy()
}

/**
 * Create a framework-agnostic habit scheduler. The returned controller is
 * registered so it can be found via {@link listHabits} / {@link getHabit}, and
 * removed with `controller.destroy()`.
 *
 * @example
 * const job = createHabit(() => console.log('tick'), { every: '2h ~ 5m' })
 * job.pause()
 */
export function createHabit(
  callback: () => void | Promise<void>,
  options: HabitOptions,
): HabitController {
  const opts = options
  const { immediate = false, autoStart = true, random = Math.random } = opts
  const id = opts.id ?? `h${++seq}`
  let name = opts.name

  let tasks: Task[] = buildTasks(opts)

  let counter = 0
  let isActive = false
  let nextRun: Date | null = null

  const listeners = new Set<() => void>()
  const notify = () => {
    for (const l of listeners) l()
  }

  const recomputeNext = () => {
    let min: number | null = null
    for (const t of tasks) {
      if (t.nextTs != null && (min == null || t.nextTs < min))
        min = t.nextTs
    }
    nextRun = min == null ? null : new Date(min)
  }

  const fire = () => {
    counter++
    notify()
    try {
      const r = callback()
      if (r && typeof (r).then === 'function')
        (r).catch(() => {})
    }
    catch {
      // swallow so a throwing callback never kills the schedule
    }
  }

  const schedule = (t: Task) => {
    t.count++
    const target = t.anchor + t.count * t.intervalMs + jitterOffset(t, random)
    t.nextTs = target
    recomputeNext()
    notify()
    t.cancel = longTimeout(() => {
      fire()
      if (isActive)
        schedule(t)
    }, target - Date.now())
  }

  const start = (runImmediate = false) => {
    if (isActive)
      return
    const now = Date.now()
    for (const t of tasks) {
      t.anchor = now
      t.count = 0
    }
    isActive = true
    notify()
    if (runImmediate)
      fire()
    for (const t of tasks) schedule(t)
  }

  const stop = () => {
    for (const t of tasks) {
      t.cancel?.()
      t.cancel = null
      t.nextTs = null
    }
    isActive = false
    recomputeNext()
    notify()
  }

  const pause = () => {
    if (isActive)
      stop()
  }
  const resume = () => {
    if (!isActive)
      start(false)
  }
  const reset = () => {
    counter = 0
    notify()
    if (isActive) {
      stop()
      start(false)
    }
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const update = (next: HabitOptions) => {
    const wasActive = isActive
    if (isActive)
      stop()
    if (next.name !== undefined)
      name = next.name
    tasks = buildTasks(next)
    if (wasActive) {
      start(false)
    }
    else {
      recomputeNext()
      notify()
    }
    notifyRegistry()
  }

  const destroy = () => {
    stop()
    registry.delete(id)
    notifyRegistry()
  }

  const controller: HabitController = {
    id,
    get name() {
      return name
    },
    get counter() {
      return counter
    },
    get isActive() {
      return isActive
    },
    get nextRun() {
      return nextRun
    },
    start,
    stop,
    pause,
    resume,
    reset,
    update,
    destroy,
    subscribe,
  }

  registry.set(id, controller)
  notifyRegistry()

  if (autoStart)
    start(immediate)

  return controller
}

/**
 * The next `count` fire times (epoch ms) after `anchor`, in order, skipping the first `skip` fires of each
 * habit. Pure: no timers. Continue a series without drift by passing the same `anchor` and the fires already used.
 */
export function nextRuns(options: HabitOptions, count: number, anchor = Date.now(), skip = 0): number[] {
  const random = options.random ?? Math.random
  return buildTasks(options)
    .flatMap(task => Array.from({ length: count }, (_, i) => anchor + (skip + i + 1) * task.intervalMs + jitterOffset(task, random)))
    .sort((a, b) => a - b)
    .slice(0, count)
}
