import childProcess from "node:child_process"
import fs from "node:fs"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { afterEach, beforeEach, expect } from "vitest"

type Spawned = { command: string; args: string; startMs: number; ms: number }
type Timed = { count: number; ms: number; max: number }
const now = () => Number(process.hrtime.bigint() / 1_000_000n)
let spawned: Spawned[] = []
let fsOps = new Map<string, Timed>()
let started = now()
const loop = monitorEventLoopDelay({ resolution: 10 })
loop.enable()

function describeCall(file: unknown, args: unknown): { command: string; args: string } {
  const list = Array.isArray(args) ? args.map(String) : []
  const skipped = list[0] === "-C" ? list.slice(2).filter((value) => !value.startsWith("-c") && !value.includes("=")) : list
  return { command: String(file).split(/[\\/]/).pop() ?? String(file), args: skipped.slice(0, 2).join(" ").slice(0, 60) }
}

const prototype = childProcess.ChildProcess.prototype as unknown as { spawn: (options: { file: string; args: string[] }) => unknown }
const originalSpawn = prototype.spawn
prototype.spawn = function (this: childProcess.ChildProcess, options: { file: string; args: string[] }) {
  const begin = now()
  const described = describeCall(options.file, options.args.slice(1))
  const result = originalSpawn.call(this, options)
  this.once("close", () => { spawned.push({ ...described, startMs: begin - started, ms: now() - begin }) })
  return result
}

function record(name: string, ms: number) {
  const current = fsOps.get(name) ?? { count: 0, ms: 0, max: 0 }
  current.count += 1
  current.ms += ms
  current.max = Math.max(current.max, ms)
  fsOps.set(name, current)
}

const promises = fs.promises as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>
for (const name of ["open", "readFile", "writeFile", "rename", "rm", "mkdir", "mkdtemp", "stat", "lstat", "realpath", "unlink", "readdir", "copyFile", "cp", "access"]) {
  const original = promises[name]
  if (typeof original !== "function") continue
  promises[name] = async function (this: unknown, ...values: unknown[]) {
    const begin = now()
    try { return await original.apply(this, values) } finally { record(`promises.${name}`, now() - begin) }
  }
}
const sync = fs as unknown as Record<string, (...values: unknown[]) => unknown>
for (const name of ["fsyncSync", "renameSync", "rmSync", "realpathSync", "writeFileSync", "readFileSync", "openSync", "closeSync", "mkdirSync", "statSync", "existsSync"]) {
  const original = sync[name]
  if (typeof original !== "function") continue
  sync[name] = function (this: unknown, ...values: unknown[]) {
    const begin = now()
    try { return original.apply(this, values) } finally { record(name, now() - begin) }
  }
}

beforeEach(() => {
  spawned = []
  fsOps = new Map()
  loop.reset()
  started = now()
})

afterEach(() => {
  const byCommand = new Map<string, Timed>()
  for (const entry of spawned) {
    const key = `${entry.command} ${entry.args}`.trim()
    const current = byCommand.get(key) ?? { count: 0, ms: 0, max: 0 }
    current.count += 1
    current.ms += entry.ms
    current.max = Math.max(current.max, entry.ms)
    byCommand.set(key, current)
  }
  const wallMs = now() - started
  const summary = {
    test: expect.getState().currentTestName,
    wallMs,
    spawns: spawned.length,
    spawnMs: spawned.reduce((sum, entry) => sum + entry.ms, 0),
    spawnMaxMs: spawned.reduce((max, entry) => Math.max(max, entry.ms), 0),
    loopMaxMs: Math.round(loop.max / 1e6),
    loopMeanMs: Math.round(loop.mean / 1e6),
    spawnsByCommand: Object.fromEntries([...byCommand.entries()].sort((left, right) => right[1].ms - left[1].ms).slice(0, 15)),
    fs: Object.fromEntries([...fsOps.entries()].sort((left, right) => right[1].ms - left[1].ms).slice(0, 10)),
    slowestSpawns: [...spawned].sort((left, right) => right.ms - left.ms).slice(0, 8),
  }
  if (wallMs >= 2_000) console.info(`MEASURE ${JSON.stringify(summary)}`)
})
