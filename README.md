# habicron

> Habits, not cronjobs.

A human-like scheduler for **AI agents and applications**. `habicron` runs a
callback on a **randomized recurring interval** — accurate by default (evenly
spaced, anchored to the start time, **no drift**) and optionally **jittered**, so
each fire is nudged earlier or later within bounds. Your jobs run on a human
rhythm instead of robotically on the dot.

```ts
import { createHabit } from 'habicron'

// remind me to drink water roughly every hour
createHabit(drinkWater, { every: '1h ~ 8m' })
```

**Node** · **Browser** · **Vue** · **React** · **CLI** — one tiny,
zero-dependency core behind five entry points.

| Import | For | You get |
| --- | --- | --- |
| `habicron` / `habicron/node` | Node, workers, scripts, agents | a plain controller |
| `habicron/cloudflare` | SQLite Durable Objects | an async durable clock and tick contract |
| `habicron/browser` | Vanilla browser (no framework) | a controller + callbacks |
| `habicron/vue` | Vue 3 | reactive `ref`s |
| `habicron/react` | React 17+ | reactive state |
| `habit` (CLI) | the terminal | runs a shell command |

- **No drift** — fires are anchored to a fixed grid; jitter perturbs *around* the
  grid point and never accumulates, so the long-run rate stays exact.
- **Jitter, bounded** — capped at `0.49 × interval` so adjacent fires can't reorder.
- **Long delays** — months and years are supported (chunked past `setTimeout`'s
  24.8-day ceiling).
- **Resilient** — a throwing or rejecting callback never kills the schedule.
- **SSR-safe** — no timers during server render.
- **Typed** — ships generated `.d.ts`; `every` and `times`/`per` are mutually
  exclusive at compile time.

## Install

```sh
npm i habicron      # or: pnpm add habicron / bun add habicron
```

`vue` and `react` are optional peer dependencies — install only the one you use.
For the `habit` CLI, install globally: `npm i -g habicron`.

Add the agent skills (Claude · OpenClaw):

```sh
npx skills add imrim12/habicron
```

## Quick start

```ts
import { createHabit } from 'habicron'

const job = createHabit(() => syncFeed(), { every: '15m ~ 2m' })

job.counter // times fired
job.nextRun // Date of the next fire, or null
job.pause()
job.resume()
job.stop()
```

Every adapter is the same engine with a platform-shaped surface:

```ts
import { useHabit } from 'habicron/vue'    // reactive refs
import { useHabit } from 'habicron/react'  // reactive values
import { useHabit } from 'habicron/browser' // controller + callbacks
```

```sh
habit start --every "1h ~ 5m" -- npm run sync   # the terminal
```

## Use cases

Give your software a daily rhythm.

| For | Examples |
| --- | --- |
| **AI agents** | review and improve memory `every 2h` · re-read the project goals `every 30m ~ 5m` · summarize repo changes `2× / day` · touch base with the user `every 90m, jittered` |
| **Smart CLI tools** | scout a site for sales `every 1h` · pull and rebuild `3× / day` · back up to object storage `every 6h ~ 30m` · run the test suite `every 45m` |
| **Web apps** | check the camera `every 5m` · refresh a live dashboard `every 20s ~ 4s` · autosave the draft `roughly every 1m` · nudge "drink water" `every 1h ~ 8m` |
| **Servers & workers** | poll a webhook source `every 90s, jittered` · warm the cache `4× / day` · reconcile with an upstream API `every 15m ~ 2m` · sweep stale sessions `every 1h` |

---

# API

A **habit** is an interval (`every`) or a rate (`times` + `per`), with optional
`jitter`. Pass one schedule inline, or several under `habits` for the union.

## Schedule shapes

| Shape | Example | Fires |
| --- | --- | --- |
| `{ every: Duration }` | `{ every: '2h' }` | every 2 hours, exactly |
| `{ every: Duration }` (compound) | `{ every: '1h30m' }` | every 90 minutes |
| `{ every: '<cadence> ~ <jitter>' }` | `{ every: '2h ~ 5m' }` | every 2h, ± up to 5m (packed form) |
| `{ every, jitter: Duration }` | `{ every: '20s', jitter: '5s' }` | every 20s, ± up to 5s |
| `{ every, jitter: [min, max] }` | `{ every: '20s', jitter: ['3s', '5s'] }` | every 20s, ± 3–5s |
| `{ every, jitter: { min, max } }` | `{ every: '1h', jitter: { min: '5m', max: '15m' } }` | every 1h, ± 5–15m |
| `{ times, per }` | `{ times: 2, per: 'day' }` | twice a day, evenly spaced |
| `{ times, per, jitter }` | `{ times: 2, per: 'day', jitter: '2h' }` | twice a day, ± up to 2h |
| `{ habits: Schedule[] }` | `{ habits: [a, b, c] }` | the **union** of several habits |

The packed `every` separator is the typeable `~`. `+/-`, `+-`, and the `±` glyph
are also accepted: `'2h +/- 5m'` is the same as `'2h ~ 5m'`.

## Durations

A `Duration` is a number (milliseconds) or a string of `<num><unit>` tokens —
tokens combine, e.g. `'1h30m'`, `'500ms'`, `'2d12h'`.

| Token | Unit | | Token | Unit |
| --- | --- | --- | --- | --- |
| `ms` | milliseconds | | `w` | weeks |
| `s` | seconds | | `mo` | months (average 30.44 d) |
| `m` | minutes | | `y` | years (average 365.25 d) |
| `h` | hours | | | |
| `d` | days | | | |

`month` / `year` are average approximations, not calendar-exact.

## Jitter

Jitter magnitude is always applied with a **random sign** — fires land earlier
**or** later — and is capped at `0.49 × interval` so adjacent fires can't reorder.

| Form | Type | Meaning |
| --- | --- | --- |
| `'5m'` | `Duration` | magnitude from `0` to `5m` |
| `['3s', '5s']` | `[min, max]` | magnitude from `3s` to `5s` |
| `{ min: '5m', max: '15m' }` | `{ min?, max }` | bounded; `min` defaults to `0` |

## Rate (`times` / `per`)

`{ times, per }` fires `times` evenly across one `per` period — `intervalMs` is
`period / times`.

`per` is one of: `minute` · `hour` · `day` · `week` · `month` · `year`.

## Control flags

Any schedule also accepts these flags (`ControlFlags`):

| Flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `immediate` | `boolean` | `false` | fire once on start (counts toward `counter`) |
| `autoStart` | `boolean` | `true` | start timers on creation; adapters gate this for SSR |
| `random` | `() => number` | `Math.random` | RNG in `[0, 1)`; inject a seeded one for determinism |
| `id` | `string` | auto (`h1`, `h2`, …) | stable identifier in the registry |
| `name` | `string` | — | human-friendly label for management tooling |

## `createHabit`

```ts
createHabit(callback: () => void | Promise<void>, options: HabitOptions): HabitController
```

The returned `HabitController`:

| Member | Type | Description |
| --- | --- | --- |
| `id` | `string` (readonly) | stable identifier in the registry |
| `name` | `string \| undefined` (readonly) | the label, if any |
| `counter` | `number` (readonly) | times the callback has fired |
| `isActive` | `boolean` (readonly) | whether timers are running |
| `nextRun` | `Date \| null` (readonly) | earliest upcoming fire, or `null` when stopped |
| `start(immediate?)` | `(boolean?) => void` | (re)start from now; `true` fires once immediately |
| `stop()` | `() => void` | cancel all timers, clear `nextRun`; keeps `counter` |
| `pause()` | `() => void` | `stop`, but no-ops when already stopped |
| `resume()` | `() => void` | restart from now (no immediate fire) |
| `reset()` | `() => void` | zero `counter` and, if active, restart from now |
| `update(options)` | `(HabitOptions) => void` | replace the schedule in place; keeps `id` + `counter` |
| `destroy()` | `() => void` | stop timers and remove from the registry |
| `subscribe(listener)` | `(() => void) => () => void` | notified on every state change; returns unsubscribe |

## Managing habits

Every habit is registered on creation, so you can list, look up, update, and
remove them from anywhere in the process.

```ts
import { createHabit, getHabit, listHabits } from 'habicron'

createHabit(syncFeed, { id: 'feed', name: 'Feed sync', every: '15m ~ 2m' })

listHabits()                   // HabitController[]
getHabit('feed')?.update({ every: '5m' })   // reschedule in place
getHabit('feed')?.destroy()                 // stop + unregister
```

| Function | Returns | Description |
| --- | --- | --- |
| `listHabits()` | `HabitController[]` | every registered habit, in creation order |
| `getHabit(id)` | `HabitController \| undefined` | look up one by id |
| `subscribeHabits(listener)` | `() => void` | notified when a habit is added or removed |
| `clearHabits()` | `void` | destroy every registered habit |

A `HabitSummary` is the plain, serialisable snapshot used by listing UIs:

```ts
interface HabitSummary {
  id: string
  name: string | undefined
  isActive: boolean
  counter: number
  nextRun: Date | null
}
```

The Node entry also re-exports the parser primitives `dur`, `normalize`,
`resolveJitter`, and `longTimeout` for building on top of the engine.

---

# Adapters

## Node

Headless — you drive the controller directly.

```ts
import { createHabit } from 'habicron'

const job = createHabit(() => syncFeed(), { every: '15m ~ 2m' })

process.on('SIGINT', () => { job.stop(); process.exit(0) })
```

## Browser (no framework)

Vanilla JS has no refs or state, so reactivity arrives through callbacks.
`useHabit` returns the `HabitController`; SSR-safe (timers start only when a
`window` is present).

```ts
import { useHabit } from 'habicron/browser'

const job = useHabit(() => refreshWidget(), {
  every: '20s ~ 4s',
  onFire: count => (badge.textContent = String(count)),
  onActive: active => dot.classList.toggle('live', active),
  onChange: ({ nextRun }) => (label.textContent = nextRun?.toLocaleTimeString() ?? ''),
})

job.pause() // or resume / update / destroy
```

| Callback | Fires |
| --- | --- |
| `onActive(isActive)` | when running state flips, and once on creation — the framework-free stand-in for a reactive `isActive` |
| `onFire(counter)` | after each fire, with the new total |
| `onChange(summary)` | on any state change, with a `HabitSummary` snapshot |

## Vue

`useHabit` returns reactive, **readonly** refs and disposes on scope teardown.

```vue
<script setup lang="ts">
import { useHabit } from 'habicron/vue'

const { counter, nextRun, pause, resume } = useHabit(post, {
  controls: true,
  every: '20s ~ 4s',
})
</script>

<template>
  <p>fired {{ counter }}× · next at {{ nextRun?.toLocaleTimeString() }}</p>
  <button @click="pause">Pause</button>
</template>
```

| Member | Type | When |
| --- | --- | --- |
| `counter` | `Readonly<Ref<number>>` | always |
| `nextRun` | `Readonly<Ref<Date \| null>>` | always |
| `isActive` | `Readonly<Ref<boolean>>` | only with `controls: true` |
| `pause` / `resume` / `reset` | `() => void` | only with `controls: true` |

`useHabits()` returns a reactive `Readonly<Ref<HabitSummary[]>>` — a ready-made
management view that updates as habits fire or come and go.

## React

`useHabit` returns **plain values** (not refs) that re-render on change. The
controller is created inside an effect, so it is SSR-safe; the callback is always
read fresh, so closing over changing props is safe.

```tsx
import { useHabit } from 'habicron/react'

function Reminder() {
  const { counter, nextRun, pause } = useHabit(
    () => notify('Drink water'),
    { controls: true, every: '1h ~ 8m' },
  )
  return (
    <p>
      fired {counter}× · next at {nextRun?.toLocaleTimeString()}
      <button onClick={pause}>Pause</button>
    </p>
  )
}
```

| Member | Type | When |
| --- | --- | --- |
| `counter` | `number` | always |
| `nextRun` | `Date \| null` | always |
| `isActive` | `boolean` | only with `controls: true` |
| `pause` / `resume` / `reset` | `() => void` | only with `controls: true` |

`useHabits()` returns `HabitSummary[]`, re-rendering as habits change.

In both Vue and React, control members appear only when `controls: true` — the
return type is exact, expressed through overloads with no casting.

## Multiple habits

The callback fires on the **union** of all habits in the list.

```ts
useHabit(runAgent, {
  controls: true,
  habits: [
    { every: '2h ~ 20m' },                   // check the cat
    { times: 2, per: 'day', jitter: '90m' }, // twice a day
    { every: '3d', jitter: ['3h', '5h'] },   // every few days
  ],
})
```

---

# CLI (`habit`)

The `habit` command runs any shell command on a randomized schedule — a
lightweight process manager for habits. It works attached, or managed by a
background daemon.

```sh
npm i -g habicron   # provides the `habit` command
```

**Attached** — fires in your terminal until you Ctrl-C:

```sh
habit run --every "10s ~ 2s" -- echo "stretch"
```

**Managed** — a background daemon keeps habits firing; manage them like processes:

```sh
habit start --name sync --every "1h ~ 5m" -- npm run sync   # create + run in background
habit start --times 3 --per day --jitter 2h -- ./backup.sh
habit list           # id, name, status, schedule, command, runs, next/last
habit logs sync      # recent output
habit stop sync      # pause   ·   habit start sync resumes it
habit restart sync
habit update sync --every 30m    # change the schedule live (or -- <new command>)
habit delete sync    # remove (alias: rm)
habit kill           # stop the daemon
```

`habit list` shows what each habit runs:

```
id  name  status   schedule     command       runs  next    last
1   sync  running  every 1h~5m   npm run sync  4     in 52m  8m ago
```

## Commands

| Command | Description |
| --- | --- |
| `habit run <schedule> -- <cmd…>` | run attached in this terminal (Ctrl-C to stop) |
| `habit start <schedule> -- <cmd…>` | create + run in the background |
| `habit start <id\|name>` | resume a paused habit |
| `habit stop <id\|name\|all>` | pause |
| `habit restart <id\|name\|all>` | restart |
| `habit update <id\|name> [flags \| -- <cmd…>]` | change the schedule, name, or command live |
| `habit delete <id\|name\|all>` | remove (alias: `rm`) |
| `habit list` | list habits and what they run (alias: `ls`) |
| `habit logs <id\|name> [-n <lines>]` | show recent output |
| `habit kill` | stop the background daemon |

## Schedule flags

| Flag | Meaning |
| --- | --- |
| `--every <dur>` | interval between fires, e.g. `"2h"`, `"10s ~ 2s"`, `"1h30m"` |
| `--times <n> --per <period>` | N times per `minute`…`year` |
| `--jitter <dur>` | max random nudge per fire, e.g. `"5m"` |
| `-i`, `--immediate` | fire once immediately on start |
| `--name <n>` | label for `list` / `logs` / `stop` / etc. |

Habit definitions persist in `~/.habit/` (set `HABIT_HOME` to relocate); logs in
`~/.habit/logs/<id>.log`. The CLI is a single-host process manager — not a
distributed or at-least-once scheduler.

---

## Cloudflare Durable Objects

The default `createHabit()` runtime remains an in-process `setTimeout()` scheduler. Use the opt-in asynchronous adapter when a schedule must survive Worker eviction:

```ts
import { DurableObject } from 'cloudflare:workers'
import { DurableHabitRuntime } from 'habicron/cloudflare'

interface Env {
  DELIVERY_QUEUE: Queue
}

export class TrackingClock extends DurableObject<Env> {
  private readonly habit = new DurableHabitRuntime({ storage: this.ctx.storage })

  async arm() {
    return await this.habit.arm({
      id: 'example',
      every: '5s',
      maxDurationMs: 60 * 60 * 1000,
      missedTickPolicy: 'skip',
    })
  }

  async cancel(generation: number) {
    return await this.habit.cancelIfGeneration(generation)
  }

  async alarm(): Promise<void> {
    await this.habit.handleAlarm(async (tick) => {
      await this.env.DELIVERY_QUEUE.send({
        tickId: tick.tickId,
        generation: tick.generation,
        sequence: tick.sequence,
        scheduledAt: tick.scheduledAt,
      })
    })
  }
}
```

Use one immutable habit identity per Durable Object and let the runtime exclusively own its alarm. Re-arming that identity increments its generation; attempting to replace it with another habit ID is rejected. Lifecycle methods are promises because storage and alarm transitions are durable operations.

Deadlines use a fixed grid. Late alarms skip missed grid points rather than creating a burst. Jitter is persisted before arming and must be less than half the interval.

Alarms and Queues are at least once. `tickId` is stable across retries, but Queue messages may duplicate after a crash. Deduplicate downstream work and keep `alarm()` limited to a short awaited durable handoff. Do not call arbitrary partner APIs or launch an unawaited `fetch()` inside the alarm.

Use `cancelIfGeneration(expectedGeneration)` when cancellation is based on an earlier snapshot. It atomically refuses to cancel a newer generation and is retry-safe for the matching cancelled generation. It fences stored clock state only: a handoff that already started may still complete, so downstream consumers must also fence by generation and deduplicate `tickId`.

`maxDurationMs` becomes an immutable absolute expiry during `arm()`. Pause and resume never extend it. Pause deletes the alarm, so a paused expiry becomes visible lazily on the next method call. For permanent deletion of a dedicated object, call both `deleteAlarm()` and `deleteAll()` outside the adapter and never reuse that object identity.

See [`docs/cloudflare-runtime.md`](./docs/cloudflare-runtime.md) for the architecture and failure model.

## Scope

The **engine and adapters** (`node` / `browser` / `vue` / `react`) are a
**runtime scheduler**: in-process only, no persistence across reloads, no
at-least-once delivery, no distributed coordination. Browser timers may be
throttled in backgrounded tabs.

The opt-in **`habicron/cloudflare` adapter is the distributed durable exception**:
it coordinates one habit through transactional Durable Object storage and alarms.
Consumers remain responsible for a short durable handoff and downstream
idempotency.

The **`habit` CLI is the single-host durable exception**: it persists habit definitions to
`~/.habit/` and runs them with a background daemon — but still as a single-host
process manager.

## Develop

```sh
pnpm install
pnpm lint           # eslint . --max-warnings 0
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm build          # unbuild → dist/ (minified ESM + CJS + .d.ts)
```

## License

[MIT](./LICENSE) © thecodeorigin
