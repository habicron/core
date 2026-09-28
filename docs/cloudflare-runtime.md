# Cloudflare durable runtime architecture

## Decision

Habicron exposes Cloudflare scheduling through `habicron/cloudflare`, not through a `preset` on `createHabit()`.

The runtime is an asynchronous coordinator for one SQLite-backed Durable Object. It exclusively owns that object's alarm. The consumer owns the Durable Object class and its durable handoff.

## Compared designs

| Design | Advantages | Rejected cost |
|---|---|---|
| `createHabit(callback, { preset: 'cloudflare' })` | Familiar call shape | Synchronous controller methods cannot honestly model asynchronous storage and alarms. Closures cannot survive eviction. |
| `DurableHabitObject extends DurableObject` | Enforces alarm ownership | Leaks Cloudflare runtime imports and prevents composition with another base class. |
| Extract hosted scheduler engine | Reuses deployed code | Imports organization, quota, billing, webhook, lease, and API assumptions into a general library. |
| `DurableHabitRuntime` adapter | Explicit async lifecycle, composable, bundle-safe | Consumers must forward `alarm()` and respect exclusive ownership. |

## Storage model

The adapter uses the transactional key-value methods on `DurableObjectStorage`. For a SQLite-backed Durable Object these values live in the object's SQLite database and are strongly consistent.

One versioned blob is deliberate. It keeps a one-habit state transition and its alarm update atomic without exposing Cloudflare imports. It sacrifices queryability and schema-level constraints that a multi-habit SQL scheduler would need.

Persisted fields include the normalized schedule, immutable expiry, generation, next sequence/deadline, and current logical claim. New `arm()` calls for the same immutable habit identity increment the retained generation. Reusing one object for another habit ID is rejected.

## Alarm and delivery guarantees

- Cloudflare supports one pending alarm per object.
- Alarms are at least once and can be late.
- A claimed tick uses `habitId:generation:sequence:scheduledAt` as its stable identity.
- A crash after Queue acceptance can publish that identity more than once.
- The Queue consumer must deduplicate or make downstream effects idempotent.
- The adapter persists a recovery wake before dispatch and contains callback failure after safely retaining the claim. Storage or reconciliation failures still propagate.
- Completion re-reads generation, status, and tick ID after awaited I/O.

The callback must only perform a short awaited durable handoff. Do not wait for arbitrary partner HTTP calls and do not use an unawaited `fetch()`.

## Scheduling

Deadlines stay on `startedAt + (sequence - 1) * interval`. A late alarm emits at most its one persisted due tick, then advances to the first future grid deadline. It never sends a catch-up burst.

Jitter is chosen before arming and persisted. A retry does not resample a claimed deadline. Jitter at or above half the interval is rejected because it can reorder adjacent ticks.

## Lifecycle and expiry

- `pause()` abandons any pending claim, records `paused`, and deletes the alarm.
- An already accepted handoff cannot be recalled.
- `resume()` keeps the same generation and immutable expiry, then selects the first future grid point.
- `cancel()` is terminal for the generation and deletes the alarm.
- `cancelIfGeneration(expectedGeneration)` atomically compares and cancels, returning `{ applied: false, snapshot }` if the object expired or a newer generation exists. Repeating it for the matching cancelled generation returns `applied: true`.
- Generation-fenced cancellation cannot recall a handoff whose dispatch already started. Consumers must reject stale generations and deduplicate `tickId`.
- Active schedules wake at the earlier of the next tick or expiry.
- Paused schedules expose expiry lazily on the next public call because pause promises no alarm.
- `destroy()` is omitted. A caller that permanently deletes a dedicated object must call `deleteAlarm()` and `deleteAll()`, then use a new object identity. Deleting state can reset generation history.

## Limitations

- Logical 3s or 5s cadence is not a wake-up SLA. Maintenance and failover can cause much larger delays.
- One runtime cannot share the alarm with other features in the same object.
- Arm idempotency is not provided. Callers must reconcile uncertain arm results through their own persisted lifecycle rather than blindly retrying a stale request.
- There is no multi-habit heap, catch-up mode, exactly-once Queue publication, or partner-specific policy.
