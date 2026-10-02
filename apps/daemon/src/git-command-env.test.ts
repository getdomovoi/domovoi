import { EventEmitter } from "node:events"

import { describe, expect, it, vi } from "vitest"

// The resolver must read the same environment the Git child gets (ruling
// Q305). A caller that derives the child's environment by spreading another
// one drops its inherited keys, so it must hand that derived object, not the
// original, to gitCommand: an inherited PATH and an own Path would otherwise
// name different directories to the resolver and to the child.
const calls = vi.hoisted(() => ({ resolved: [] as NodeJS.ProcessEnv[], spawned: [] as NodeJS.ProcessEnv[] }))

vi.mock("./git-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-command.js")>()
  return {
    ...actual,
    gitCommand: vi.fn((env: NodeJS.ProcessEnv = process.env) => {
      calls.resolved.push(env)
      return "git"
    }),
  }
})

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    execFile: vi.fn((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }, done: (error: Error | null, stdout: string) => void) => {
      calls.spawned.push(options.env)
      // An empty config, then the post-index-change hook path, which is absent.
      done(null, args.includes("--git-path") ? "hooks/post-index-change\n" : "")
    }),
    spawn: vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.spawned.push(options.env)
      const child = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
        kill: () => true,
      })
      setImmediate(() => child.emit("close", 0))
      return child
    }),
  }
})

const { gitReadCanRunProgram } = await import("./git-read-config.js")

describe("git-read-config's Git children", () => {
  it("resolve Git against the environment each child gets, inherited keys and all", async () => {
    const env = Object.assign(Object.create({ PATH: "C:\\GitA\\cmd" }) as NodeJS.ProcessEnv, { Path: "C:\\GitB\\cmd" })

    expect(await gitReadCanRunProgram("/repository", env)).toBe(false)

    // config list, ls-files for gitlinks, rev-parse for the hook.
    expect(calls.spawned).toHaveLength(3)
    expect(calls.resolved).toHaveLength(3)
    for (const [index, spawned] of calls.spawned.entries()) {
      expect(calls.resolved[index], `child ${index}`).toBe(spawned)
      expect(spawned.GIT_NO_LAZY_FETCH).toBe("1")
    }
  })
})
