import childProcess from "node:child_process"
import { afterEach, beforeEach, expect } from "vitest"

type Spawned = { command: string; args: string; ms: number }
const now = () => Number(process.hrtime.bigint() / 1_000_000n)
let spawned: Spawned[] = []
let started = now()

function describeCall(file: unknown, args: unknown): { command: string; args: string } {
  const list = Array.isArray(args) ? args.map(String) : []
  const skipped = list[0] === "-C" ? list.slice(2).filter((value) => !value.startsWith("-c") && !value.includes("=")) : list
  return { command: String(file).split(/[\\/]/).pop() ?? String(file), args: skipped.slice(0, 2).join(" ") }
}

const prototype = childProcess.ChildProcess.prototype as unknown as { spawn: (options: { file: string; args: string[] }) => unknown }
const originalSpawn = prototype.spawn
prototype.spawn = function (this: childProcess.ChildProcess, options: { file: string; args: string[] }) {
  const begin = now()
  const described = describeCall(options.file, options.args.slice(1))
  const result = originalSpawn.call(this, options)
  this.once("close", () => { spawned.push({ ...described, ms: now() - begin }) })
  return result
}

beforeEach(() => {
  spawned = []
  started = now()
})

afterEach(() => {
  const byCommand = new Map<string, { count: number; ms: number; max: number }>()
  for (const entry of spawned) {
    const key = `${entry.command} ${entry.args}`.trim()
    const current = byCommand.get(key) ?? { count: 0, ms: 0, max: 0 }
    current.count += 1
    current.ms += entry.ms
    current.max = Math.max(current.max, entry.ms)
    byCommand.set(key, current)
  }
  const top = [...byCommand.entries()].sort((left, right) => right[1].ms - left[1].ms).slice(0, 12)
  console.info(`MEASURE ${JSON.stringify({
    test: expect.getState().currentTestName,
    wallMs: now() - started,
    spawns: spawned.length,
    spawnMs: spawned.reduce((sum, entry) => sum + entry.ms, 0),
    spawnMaxMs: spawned.reduce((max, entry) => Math.max(max, entry.ms), 0),
    top: Object.fromEntries(top),
  })}`)
})
