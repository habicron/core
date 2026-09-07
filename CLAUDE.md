# CLAUDE.md

Operating guide for AI coding agents (Claude Code) working in this repository.
Read this fully before editing. It is the source of intent that the code alone
does not convey.

---

## 1. What this is

**habicron** schedules a callback on **randomized recurring intervals** —
"habits" rather than fixed cron. It is accurate (evenly spaced) by default and
optionally jittered (each fire nudged earlier or later within bounds).

- Package name: `habicron`
- Repo: `imrim12/habicron`
- One framework-agnostic engine (`src/core`) with five published entry points:
  **node** (default), **browser**, **vue**, **react**, and a **cli** binary.

The product thesis is the jitter-with-no-drift behavior. Anything that quietly
turns this back into a plain `setInterval`/cron is a regression, even if tests
pass.

**Mental model:** a habit = `{ intervalMs, jitter }`. The engine fires the
callback on the union of all habits, each habit reschedules itself, and the next
fire is always computed against a fixed grid so the long-run rate stays exact.
Everything else (Vue refs, React state, browser callbacks, CLI process) is a
thin adapter over the core controller.

---

## 2. Repository layout

```
src/
  core/    index.ts + __test__/   # the engine — types + scheduler, no deps
  node/    index.ts + __test__/   # default entry: re-exports core, headless
  browser/ index.ts + __test__/   # browser adapter — useHabit (callbacks)
  vue/     index.ts + __test__/   # Vue adapter — useHabit (refs)
  react/   index.ts + __test__/   # React adapter — useHabit (state)
  cli/     index.ts store.ts daemon.ts + __test__/   # `habit` background task manager
skills/habicron-{node,browser,vue,react,cli}/SKILL.md   # one agent skill per platform
public/index.html                # self-contained landing page (no framework)
build.config.ts                  # unbuild — emits minified ESM + CJS + .d.ts
vitest.config.ts                 # node env by default; jsdom via file docblock
eslint.config.mjs                # @antfu/eslint-config, strict, type-aware
tsconfig.json                    # strict typecheck (noEmit)
package.json                     # ESM, multi-entry exports map, bin
wrangler.toml                    # Cloudflare Workers static-assets config
.github/workflows/deploy.yml     # deploys public/ to habit.thecodeorigin.com
```

**There is a build step.** The package is authored in TypeScript and built
with [unbuild](https://github.com/unjs/unbuild) to `dist/` — both `.mjs` and
`.cjs`, minified, with generated `.d.ts`. `package.json#files` ships only
`dist`, `README.md`, `LICENSE`. `public/` is **not** published — it is the
marketing page, deployed separately.

> habicron is a built, multi-platform package, not a buildless single file.
> Do not introduce a root `index.js` or remove the build.

---

## 3. Architecture: how `src/core/index.ts` works

The engine lives entirely in `src/core`. Read these pieces in order; each is a
small named function.

1. **Time constants** — `S M H D W MO Y` (ms per unit). `MO`/`Y` are *averages*
   (30.436875 d / 365.25 d), not calendar-exact. `PERIOD` maps the `per` keys to
   ms; `UNIT` maps duration-string tokens to ms.
2. **`dur(v)`** — duration parser. Accepts a number (ms) or a string of
   `<num><unit>` tokens (`'1h30m'`, `'500ms'`). Uses the `TOKEN` regex. **Token
   alternation is longest-first on purpose** (`ms|sec|min|mo|hr|s|m|h|d|w|y`) so
   `'5mo'`, `'5min'`, `'500ms'` don't mis-match against `m`/`s`. Touch this
   ordering and you will silently corrupt parsing.
3. **`resolveJitter(j)`** — normalizes `Duration | [min,max] | {min,max}` into a
   `{ min, max }` magnitude range in ms, or `null`. A bare duration means
   `{ min: 0, max }`. Sign is applied later, not here.
4. **`normalize(s)`** — reduces one schedule spec to `{ intervalMs, jitter }` or
   `null`. Resolves `every` (including the packed `'2h ~ 5m'` form, split on the
   `PACKED` regex — canonical `~`, plus `+/-`/`+-` and the legacy `±` glyph) or
   `times`/`per`. Returns `null` for non-positive/`NaN` intervals, which are then
   filtered out.
5. **`longTimeout(fn, delay)`** — `setTimeout` that chunks delays past
   `MAX_DELAY` (2^31-1 ms ≈ 24.8 days). Returns a cancel function. Exists because
   a raw `setTimeout` with a larger delay **fires immediately** — the `month`,
   `year`, and long-interval habits depend on this.
6. **`createHabit(callback, options)`** — the engine/controller:
   - Builds `specs` from `options.habits ?? [options]` → `normalize` → filter.
   - Each `task` carries `{ intervalMs, jitter, anchor, count, nextTs, cancel }`.
   - **`schedule(t)`**: `target = t.anchor + t.count * t.intervalMs + offset(t)`.
     This is the no-drift core — fires anchor to a fixed grid; jitter perturbs
     *around* the grid point and never accumulates.
   - **`offset(t)`**: random magnitude in `[jitter.min, jitter.max]`, random
     sign, **capped at `0.49 * intervalMs`** so adjacent fires can't reorder.
   - **`fire()`**: increments `counter`, calls the callback, swallows sync
     throws and async rejections so a bad run never kills the schedule.
   - **`start/stop/pause/resume/reset`**: lifecycle. `reset()` zeroes `counter`
     and restarts from now. `start()` no-ops if already active.
   - **`autoStart`** (default `true`): the engine starts itself on creation.
     Adapters pass `autoStart: false` to stay inert (SSR).
   - **`subscribe(listener)`**: the engine notifies listeners on every state
     change (`counter`/`nextRun`/`isActive`). This is how adapters stay reactive
     without the engine knowing about any framework.
   - **`random`**: injectable RNG (`() => number`) threaded through jitter, for
     deterministic tests and a reproducible docs demo.
   - **registry + `id`/`name`**: every habit is registered on creation. The
     in-process management surface is `listHabits` / `getHabit` /
     `subscribeHabits` / `clearHabits`, plus `controller.update(options)`
     (reschedule in place, keep id + counter) and `controller.destroy()` (stop
     and unregister). `HabitSummary` is the plain snapshot used by listing UIs.

### Adapters

- **`src/node`** — re-exports the core surface (`createHabit`, `dur`,
  `normalize`, `resolveJitter`, `longTimeout`). Headless; the caller drives the
  controller.
- **`src/browser`** — `useHabit` for vanilla browser apps. No refs/state, so
  reactivity is delivered via callbacks (`onActive`, `onFire`, `onChange`);
  wires them through `subscribe` and gates `autoStart` on `window` (SSR-safe).
- **`src/vue`** — `useHabit`. Creates a controller with
  `autoStart: typeof window !== 'undefined'`, mirrors its state into `readonly`
  refs via `subscribe`, and disposes on scope teardown.
- **`src/react`** — `useHabit`. Creates the controller inside `useEffect` (so
  it's SSR-safe), mirrors state into `useState`, and stops it on unmount.
  Returns **plain values**, not refs.
- **`src/cli`** — the `habit` binary, a background task manager. `index.ts` is the
  subcommand client (`run` attached; `start`/`list`/`stop`/`restart`/`update`/
  `delete`/`logs`/`kill` managed). `store.ts` is the durable store: definitions
  in `~/.habit/habits.json` (CLI-owned) and runtime state in `state.json`
  (daemon-owned) — split so the two never clobber each other's writes;
  `HABIT_HOME` relocates it. `daemon.ts` is the detached `habit __daemon`
  process that schedules `running` records with the core engine, runs their
  commands (logging to `~/.habit/logs/<id>.log`), and **polls** the store,
  re-creating a habit's controller when its `rev` bumps (update/restart). The
  pure pieces (`parseArgs`/`toOptions`, the store CRUD, `formatList`,
  `recordToOptions`) are unit-tested; the daemon is verified by hand.

---

## 4. Public API contract

Types now live **in the TypeScript source** (no separate hand-written `.d.ts`);
unbuild generates the `.d.ts` per entry. When the public API changes, write the
types first, then make the implementation conform.

- **Core** (`src/core`) is the type source of truth: `Duration`, `Jitter`,
  `Period`, `Schedule`, `ControlFlags`, `HabitOptions`, `HabitController`,
  `HabitSummary`.
- **`Schedule`** is a discriminated union with `never` guards so `every` and
  `times`/`per` are mutually exclusive at compile time. Preserve that.
- **Adapters** define their own return types because their shapes differ:
  - Vue returns `Readonly<Ref<…>>`; React/browser return plain values.
  - They gate control members (`pause`/`resume`/`reset`/`isActive`) behind
    `controls: true` via **function overloads** (one signature for
    `options: … & { controls: true }` → `HabitBase & HabitControls`, one for the
    rest → `HabitBase`). This keeps the return type exact **without any casting**.
  - The browser adapter has no refs/state, so it surfaces reactivity through
    **callbacks** (`onActive`/`onFire`/`onChange`) instead of a return shape.
- Keep the export surface small. Each adapter exports a single `useHabit` (plus
  `useHabits` where reactive); do not add aliases or extra exports without reason.
- **Type-strict, no casting.** Lint bans `as` assertions, non-null assertions
  (`!`), and `any` across `src` (`ts/consistent-type-assertions: never`,
  `ts/no-non-null-assertion`, `ts/no-explicit-any`). Narrow with `in`/type
  guards and overloads instead. The single allowed exception is the JSON
  deserialization boundary in `cli/store.ts`, marked with an inline
  eslint-disable.

---

## 5. Invariants — do not break

These are load-bearing. Each maps to a real failure if removed.

- **One engine.** All scheduling logic lives in `src/core`. Adapters must not
  reimplement `dur`/`normalize`/`longTimeout`/the grid math.
- **No drift.** Keep grid anchoring (`anchor + count*interval`). Never collapse
  into `setTimeout(base ± jitter, …)` recursion — that reintroduces drift.
- **Jitter cap at `0.49 * interval`.** Stops fires from reordering.
- **Long delays chunk** via `longTimeout`. Never a bare `setTimeout` for the
  reschedule.
- **SSR-safe.** No timers during server render (Vue gates on `window`; React
  creates the controller in an effect).
- **Resilient callbacks.** `fire()` swallows throws/rejections by design.
- **Optional peer deps.** `vue` and `react` are optional peers, externalised in
  the build — never bundled. The core and node entries must import neither.
- **Types lead the implementation**, not the reverse.

---

## 6. Conventions

- **Lint:** `@antfu/eslint-config`, strict, with **type-aware** rules enabled
  (`tsconfigPath`). `pnpm lint` must be clean (zero warnings) before commit.
  Config lives in `eslint.config.mjs`.
- **Vue vs React are scoped, never global.** Framework auto-detection is off.
  React rules (`react-hooks`, `@eslint-react`) apply only to `src/react/**`
  (they matter on the plain-`.ts` hook file). The `eslint-plugin-vue` config is
  scoped to `**/*.vue` SFCs; the current Vue adapter is a `.ts` composable and
  is covered by the strict type-aware TS rules instead — do **not** route `.ts`
  through `vue-eslint-parser`, that disables type-aware linting. The core, node
  and cli code is framework-free.
- Style: 2-space indent, no semicolons, single quotes, `const`-first. Match the
  existing files. Do not reformat unrelated code.
- Source is TypeScript (`strict`). Keep `dur`, `resolveJitter`, `normalize`,
  `longTimeout` inline in `src/core` — no extra runtime dependencies.
- Duration units: `ms s m h d w mo y`. If you extend the parser, keep the
  longest-token-first regex ordering and add a test for the new unit.
- Keep `month`/`year` as average approximations. If exact calendar boundaries
  are ever needed, isolate the date math in a `nextBoundary` helper inside
  `normalize()` — do not scatter it through the engine.
- Naming mirrors the domain: `habit`, `every`, `jitter`, `nextRun`, `counter`.
  Keep user-facing names in product terms, not implementation terms.
- `useHabit` is the composable/hook name in Vue and React, and `createHabit` is
  the core/Node factory. These are the single canonical names — there are no
  legacy aliases (no `createHabicron`/`useHabicron`/`useRandomCronjob`). Don't
  add backward-compat aliases; this is a clean, pre-release API.

---

## 7. Commands

```sh
pnpm install        # deps (vue/react/unbuild/vitest are dev/peer only)
pnpm lint           # eslint . --max-warnings 0  — must pass before commit
pnpm lint:fix       # eslint . --fix
pnpm typecheck      # tsc --noEmit  — must pass before commit
pnpm test           # vitest run
pnpm test:watch     # vitest
pnpm build          # unbuild → dist/ (minified ESM + CJS + .d.ts)
```

`pnpm` is the package manager for this repo. Do not commit a different
lockfile. `esbuild` needs its postinstall build script — it's allowlisted in
`package.json#pnpm.onlyBuiltDependencies`.

---

## 8. Testing strategy

Tests live next to each entry in `__test__/index.test.ts` and run under Vitest.
The engine is timer-driven, so tests must control time and randomness.

- **Fake timers:** `vi.useFakeTimers()`, drive with `vi.advanceTimersByTimeAsync`.
  Assert on `counter`, `nextRun`, `isActive`, and call order.
- **Determinism:** inject `options.random` rather than globally stubbing
  `Math.random` (the engine accepts a seeded RNG for exactly this).
- **Environment:** Vitest defaults to the `node` environment. Vue/React suites
  opt into jsdom with a file docblock: `// @vitest-environment jsdom`. React
  uses `@testing-library/react` (`renderHook` + `act`).
- **CLI:** test the pure `parseArgs`/`toOptions` exports — do not spawn processes
  in unit tests.
- **Cases worth covering:** accurate spacing (no jitter); bounded jitter never
  exits `[min,max]`; jitter cap holds at small intervals; `immediate` fires once
  and counts; `pause`/`resume`/`reset` semantics; union of multiple habits;
  `longTimeout` chunking for `> MAX_DELAY` delays; SSR path (no `window`) starts
  nothing; `times`/`per` interval math; the `'2h ~ 5m'` packed form.

---

## 9. Change recipes

- **Add a duration unit:** add to `UNIT`, insert into the `TOKEN` alternation in
  the correct longest-first position, add a parser test in `src/core/__test__`.
- **Add a scheduling option:** edit the types in `src/core` (extend `Schedule`
  or `ControlFlags`), implement in `createHabit`, then surface through the
  adapters if user-facing.
- **Add a returned value to an adapter:** add it to that adapter's return type
  and back it from the controller via `subscribe`.
- **Touch scheduling math:** re-run the no-drift reasoning in §3 and add a test
  asserting the k-th fire stays near `anchor + k*interval`.
- **Add a new platform entry:** add `src/<name>/index.ts`, register it in
  `build.config.ts#entries` and `package.json#exports`, and add a test folder.

---

## 10. Release / publish

- Built package: `pnpm build` then `npm publish` ships `dist/` per
  `package.json#files`. `prepublishOnly` runs the build automatically.
- `publishConfig.access` is `public`.
- Bump `version` (semver). Public API change → minor pre-1.0, breaking →
  document in the README and bump accordingly.
- Before publishing: `pnpm typecheck && pnpm test && pnpm build`, confirm `files`
  ships only `dist`/`README.md`/`LICENSE`, and that `public/` is **not** packed.
- `public/index.html` is the marketing page; it is **not** part of the npm
  package. It deploys to **https://habit.thecodeorigin.com** on Cloudflare
  Workers (static assets) via `.github/workflows/deploy.yml` — triggered on
  pushes to `main` that touch `public/**`, `wrangler.toml`, or the workflow.
  The deploy needs only repository secret `THECODEORIGIN_VAULT_TOKEN`; Cloudflare
  credentials come from Vault `habicron-library/production`. Config lives in
  `wrangler.toml` (an assets-only Worker, no server script).

---

## 11. Backlog (not yet implemented)

- **`nextRuns(n)`:** return the next `n` fire times without executing — powers a
  live timeline in `public/`.
- **Seeded docs demo:** wire `options.random` into `public/index.html` for a
  reproducible live ticker.
- **CLI config file:** allow `habit --config habits.json` for multi-habit
  runs.
- **Shiki highlighting** in `public/index.html` if code samples start changing
  often (replaces the hand-spanned `<span>`s).

---

## 12. Scope

The **engine and adapters** (`core`/`node`/`vue`/`react`) are a **runtime
scheduler**: in-process only, no persistence across reloads, no at-least-once
delivery, no distributed coordination; browser timers may be throttled when a
tab is backgrounded. Keep them that way — don't add persistence or a daemon to
the core/adapters.

The **`habit` CLI is the exception**: it is a background task manager and *does*
persist habit definitions to `~/.habit/` and run them via a background daemon.
That durability lives entirely in `src/cli` (store + daemon) and must not leak
into the engine. The CLI is still a single-host process manager — not a
distributed scheduler, queue, or at-least-once system. For those, reach for a
real service (e.g. Cloudflare Durable Object alarms / a queue). When the CLI
needs the "next jittered fire time" without running (e.g. to feed an external
scheduler), add a pure `nextRuns(n)` to the core rather than reaching into the
daemon.
