import type { DurableHabitSnapshot, DurableHabitSpec, DurableHabitTick } from '../../src/cloudflare/index'
import { DurableObject } from 'cloudflare:workers'
import { DurableHabitRuntime } from '../../src/cloudflare/index'

export interface Env {
  TEST_CLOCKS: DurableObjectNamespace<TestClock>
}

export class TestClock extends DurableObject<Env> {
  #now = 0
  #failNext = false
  #gate: Promise<void> | null = null
  #releaseGate: (() => void) | null = null
  readonly #habit: DurableHabitRuntime

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#habit = new DurableHabitRuntime({ storage: ctx.storage, now: () => this.#now })
  }

  setNow(now: number): void {
    this.#now = now
  }

  async arm(spec: DurableHabitSpec): Promise<DurableHabitSnapshot> {
    return this.#habit.arm(spec)
  }

  async pause(): Promise<DurableHabitSnapshot> {
    return this.#habit.pause()
  }

  async resume(): Promise<DurableHabitSnapshot> {
    return this.#habit.resume()
  }

  async cancel(): Promise<DurableHabitSnapshot> {
    return this.#habit.cancel()
  }

  async snapshot(): Promise<DurableHabitSnapshot | null> {
    return this.#habit.snapshot()
  }

  async armManyError(): Promise<string> {
    try {
      await this.#habit.arm({ id: 'x', habits: [] } as never)
      return ''
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  async attempts(): Promise<DurableHabitTick[]> {
    return await this.ctx.storage.get<DurableHabitTick[]>('test:attempts') ?? []
  }

  failNextDispatch(): void {
    this.#failNext = true
  }

  blockNextDispatch(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#releaseGate = resolve
    })
  }

  releaseDispatch(): void {
    this.#releaseGate?.()
    this.#gate = null
    this.#releaseGate = null
  }

  async alarm(): Promise<void> {
    await this.#habit.handleAlarm(async (tick) => {
      const attempts = await this.attempts()
      await this.ctx.storage.put('test:attempts', [...attempts, tick])
      if (this.#gate != null)
        await this.#gate
      if (this.#failNext) {
        this.#failNext = false
        throw new Error('test dispatch failure')
      }
    })
  }
}

export default { fetch: () => new Response('ok') }
