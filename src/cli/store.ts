import type { HabitOptions, Period } from '../core'
/**
 * habicron CLI — durable store.
 *
 * pm2-style management needs habits to outlive a single command, so their
 * definitions* live in `~/.habit/habits.json` (the CLI owns this) and their
 * runtime state* in `~/.habit/state.json` (the daemon owns this). Splitting
 * the two files keeps the CLI and the daemon from clobbering each other's
 * writes. Set `HABIT_HOME` to relocate everything (used by the tests).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'

export interface HabitRecord {
  id: string
  name: string
  /** What the habit runs each fire, as argv (the "what is it running" column). */
  command: string[]
  every?: string
  times?: number
  per?: Period
  jitter?: string
  immediate?: boolean
  status: 'running' | 'stopped'
  /** Bumped on update/restart so the daemon re-creates the controller. */
  rev: number
  createdAt: string
}

export interface HabitRuntime {
  counter: number
  lastRun: string | null
  lastExit: number | null
  nextRun: string | null
  startedAt: string | null
}

export interface DaemonInfo {
  pid: number
  startedAt: string
}

// --- paths -----------------------------------------------------------------

export function habitHome(): string {
  return process.env.HABIT_HOME ?? join(homedir(), '.habit')
}
const habitsFile = () => join(habitHome(), 'habits.json')
const stateFile = () => join(habitHome(), 'state.json')
const daemonFile = () => join(habitHome(), 'daemon.json')
export const logFile = (id: string) => join(habitHome(), 'logs', `${id}.log`)

function readJson<T>(file: string, fallback: T): T {
  try {
    // The one deserialization boundary: JSON.parse is `any`. Files are written
    // only by this module, so we trust their shape here rather than re-validate.
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }
  catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(habitHome(), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

// --- habit definitions (CLI-owned) -----------------------------------------

export function loadHabits(): HabitRecord[] {
  return readJson<HabitRecord[]>(habitsFile(), [])
}

export function saveHabits(list: HabitRecord[]): void {
  writeJson(habitsFile(), list)
}

export function findHabit(list: HabitRecord[], ref: string): HabitRecord | undefined {
  return list.find(r => r.id === ref) ?? list.find(r => r.name === ref)
}

function nextId(list: HabitRecord[]): string {
  const max = list.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)
  return String(max + 1)
}

/** Derive a pm2-like default name from the command (script filename if any). */
export function defaultName(command: string[]): string {
  const script = command.find(t => /\.(?:[cm]?js|ts|sh|py|rb)$/.test(t)) ?? command[0] ?? 'habit'
  return basename(script).replace(/\.[^.]+$/, '')
}

export interface NewHabit {
  name?: string
  command: string[]
  every?: string
  times?: number
  per?: Period
  jitter?: string
  immediate?: boolean
}

export function addHabit(input: NewHabit): HabitRecord {
  const list = loadHabits()
  const id = nextId(list)
  const record: HabitRecord = {
    id,
    name: input.name ?? defaultName(input.command),
    command: input.command,
    every: input.every,
    times: input.times,
    per: input.per,
    jitter: input.jitter,
    immediate: input.immediate,
    status: 'running',
    rev: 0,
    createdAt: new Date().toISOString(),
  }
  list.push(record)
  saveHabits(list)
  return record
}

export function patchHabit(ref: string, patch: Partial<HabitRecord>): HabitRecord | undefined {
  const list = loadHabits()
  const record = findHabit(list, ref)
  if (!record)
    return undefined
  Object.assign(record, patch)
  saveHabits(list)
  return record
}

export function removeHabit(ref: string): HabitRecord | undefined {
  const list = loadHabits()
  const record = findHabit(list, ref)
  if (!record)
    return undefined
  saveHabits(list.filter(r => r !== record))
  const state = loadState()
  delete state[record.id]
  saveState(state)
  return record
}

// --- runtime state (daemon-owned) ------------------------------------------

export function loadState(): Record<string, HabitRuntime> {
  return readJson<Record<string, HabitRuntime>>(stateFile(), {})
}

export function saveState(state: Record<string, HabitRuntime>): void {
  writeJson(stateFile(), state)
}

const EMPTY_RUNTIME: HabitRuntime = {
  counter: 0,
  lastRun: null,
  lastExit: null,
  nextRun: null,
  startedAt: null,
}

export function patchState(id: string, patch: Partial<HabitRuntime>): void {
  const state = loadState()
  state[id] = { ...EMPTY_RUNTIME, ...state[id], ...patch }
  saveState(state)
}

// --- daemon registration ---------------------------------------------------

export function readDaemon(): DaemonInfo | null {
  return readJson<DaemonInfo | null>(daemonFile(), null)
}

export function writeDaemon(info: DaemonInfo): void {
  writeJson(daemonFile(), info)
}

export function clearDaemon(): void {
  if (existsSync(daemonFile()))
    writeJson(daemonFile(), null)
}

/** Is a daemon process currently alive? */
export function daemonAlive(): boolean {
  const info = readDaemon()
  if (info?.pid == null)
    return false
  try {
    process.kill(info.pid, 0) // signal 0 = liveness probe
    return true
  }
  catch {
    return false
  }
}

// --- mapping & presentation ------------------------------------------------

/** Turn a stored record into {@link HabitOptions} for the core engine. */
export function recordToOptions(record: HabitRecord): HabitOptions {
  const base = { id: record.id, name: record.name, immediate: record.immediate, autoStart: false }
  if (record.every != null)
    return { ...base, every: record.every, ...(record.jitter != null ? { jitter: record.jitter } : {}) }
  if (record.times != null && record.per != null)
    return { ...base, times: record.times, per: record.per, ...(record.jitter != null ? { jitter: record.jitter } : {}) }
  throw new Error(`habit "${record.id}" has no schedule (every, or times + per)`)
}

/** Human-readable schedule, e.g. `every 10m ~ 2m` or `3×/day ~ 90m`. */
export function scheduleLabel(record: HabitRecord): string {
  if (record.every != null)
    return `every ${record.every}`
  const base = `${record.times}×/${record.per}`
  return record.jitter != null ? `${base} ~ ${record.jitter}` : base
}

function ago(iso: string | null): string {
  if (iso == null)
    return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0)
    return `in ${rel(-ms)}`
  return `${rel(ms)} ago`
}

function rel(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60)
    return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60)
    return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24)
    return `${h}h`
  return `${Math.round(h / 24)}d`
}

function nextLabel(iso: string | null, status: HabitRecord['status']): string {
  if (status === 'stopped')
    return '—'
  if (iso == null)
    return '—'
  const ms = new Date(iso).getTime() - Date.now()
  return ms <= 0 ? 'now' : `in ${rel(ms)}`
}

/** Render the `habit list` table. Pure, so it's easy to test. */
export function formatList(records: HabitRecord[], state: Record<string, HabitRuntime>): string {
  if (records.length === 0)
    return 'No habits yet. Create one with:  habit start --every "1h ~ 5m" -- <command>'

  const header = ['id', 'name', 'status', 'schedule', 'command', 'runs', 'next', 'last']
  const rows = records.map((r) => {
    const rt = state[r.id]
    return [
      r.id,
      r.name,
      r.status,
      scheduleLabel(r),
      r.command.join(' '),
      String(rt?.counter ?? 0),
      nextLabel(rt?.nextRun ?? null, r.status),
      ago(rt?.lastRun ?? null),
    ]
  })

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)))
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  return [line(header), line(widths.map(w => '─'.repeat(w))), ...rows.map(line)].join('\n')
}
