import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CommandResult } from "./providers.js"
import { resolveCommandPath, resolveToolPath } from "./tool-path.js"

// ONE-OFF CI-2 probe. HOME changes only in explicit child environments.
// Never emit shell output, Git output, or arbitrary environment values.
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, env, timeout: 20_000, ...(signal ? { signal } : {}) }, (error, stdout) => {
      resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : -1) : 0,
        stdout: error ? "" : stdout, stderr: "" })
    })
  })
}

describe.skipIf(process.platform !== "darwin")("one-off macOS login-shell Git diagnostic", () => {
  it.each(["real", "scratch"] as const)("measures Git selected with %s HOME", async (arm) => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-toolpath-diagnostic-"))
    const inherited = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH }
    try {
      const account = userInfo()
      const home = arm === "real" ? account.homedir : join(root, "home")
      if (arm === "scratch") await mkdir(home)
      const shell = process.env.SHELL ?? account.shell ?? undefined
      if (!shell) throw new Error("Tool PATH diagnostic requires the account login shell")
      const env = { ...process.env, HOME: home, USERPROFILE: home }
      let loginShell: string | undefined
      let loginExitCode: number | undefined
      const started = performance.now()
      const resolved = await resolveToolPath({
        // The recovery fixture supplies no tool-path override. Match its
        // inherited PATH/SHELL fallback and keep tools.json under this root.
        environment: { PATH: process.env.PATH, SHELL: shell },
        platform: "darwin", profileDirectory: join(root, "profile"),
        run: async (command, args, signal) => {
          loginShell = command
          const result = await run(command, args, root, env, signal)
          loginExitCode = result.exitCode
          return result
        },
      })
      const git = await resolveCommandPath("git", resolved.path, "darwin")
      console.log("T18_TOOLPATH_DIAGNOSTIC", JSON.stringify({
        arm, operation: "resolve", loginShell, git, loginExitCode,
        ms: Math.round(performance.now() - started),
      }))
      expect(loginExitCode).toBe(0)
      expect(resolved.loginShellPath).toBeDefined()
      if (!git) throw new Error("Tool PATH diagnostic could not resolve Git")

      const gitEnvironment = { ...env, PATH: resolved.path }
      const repository = join(root, "repository")
      expect((await run(git, ["init", "--initial-branch=main", repository], root, gitEnvironment)).exitCode).toBe(0)
      await writeFile(join(repository, "README.md"), "tool path diagnostic\n")
      for (const [operation, args] of [
        ["version", ["--version"]],
        ["status", ["-C", repository, "status"]],
      ] as const) {
        const samplesMs: number[] = []
        const batchStarted = performance.now()
        for (let index = 0; index < 20; index++) {
          const callStarted = performance.now()
          const result = await run(git, [...args], root, gitEnvironment)
          samplesMs.push(Math.round(performance.now() - callStarted))
          expect(result.exitCode, `${arm} Git ${operation}, sample ${index + 1}`).toBe(0)
        }
        console.log("T18_TOOLPATH_DIAGNOSTIC", JSON.stringify({
          arm, operation, loginShell, git, runs: samplesMs.length,
          totalMs: Math.round(performance.now() - batchStarted), samplesMs,
        }))
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 20 })
      expect({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH }).toEqual(inherited)
    }
  }, 60_000)
})
