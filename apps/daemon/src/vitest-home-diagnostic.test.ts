import { execFile, fork } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createEmptyWorkspace, demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"
import { creationTestRuntime } from "./session-creation-recovery.fixture.js"
import { SqliteWorkspaceStore } from "./store.js"

// ONE-OFF CI-2 diagnostic. Remove after the macOS CI measurements are collected.
// These bounds only let the probe report slow operations; recovery tests keep
// their existing deadlines. Never print command output or inherited env values.
const execute = promisify(execFile)
const realHome = userInfo().homedir
type Arm = "real" | "scratch"

function report(measurement: object) {
  console.log("T18_HOME_DIAGNOSTIC", JSON.stringify(measurement))
}

async function withHome(arm: Arm, run: (root: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-home-diagnostic-"))
  try {
    const home = arm === "real" ? realHome : join(root, "home")
    if (arm === "scratch") await mkdir(home)
    await run(root, { ...process.env, HOME: home, USERPROFILE: home })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 20 })
  }
}

async function timedGit(root: string, env: NodeJS.ProcessEnv, label: string, args: string[], context: object) {
  const started = performance.now()
  let status: string | number = 0
  try {
    return await execute("git", args, { cwd: root, env, timeout: 20_000 })
  } catch (error) {
    status = (error as { code?: string | number }).code ?? "unknown"
    // Missing default identity is itself useful data, not a probe failure.
    if (label !== "default-ident") throw new Error(`Diagnostic ${label} failed (status ${status})`)
    return undefined
  } finally {
    report({ ...context, operation: label, ms: Math.round(performance.now() - started), status })
  }
}

describe.skipIf(process.platform !== "darwin")("one-off macOS HOME diagnostic", () => {
  it("reports real-home global Git config names with all values redacted", async () => {
    await withHome("real", async (root, env) => {
      let stdout: string
      try {
        ;({ stdout } = await execute("git", ["config", "--global", "--list", "--show-origin", "--null"], {
          cwd: root, env, timeout: 20_000,
        }))
      } catch (error) {
        report({ operation: "global-config", status: (error as { code?: string | number }).code ?? "unknown" })
        return
      }
      // -z emits alternating origin and key\nvalue records. Redact every value
      // and subsection, since URL subsections can themselves carry credentials.
      const records = stdout.split("\0")
      for (let index = 0; index + 1 < records.length; index += 2) {
        const origin = records[index]!.replaceAll(realHome, "<real-home>")
        const key = records[index + 1]!.split("\n", 1)[0]!.replace(/\..*\./u, ".[subsection].")
        report({ operation: "global-config", origin, key, value: "[redacted]" })
      }
      report({ operation: "environment", present: [
        "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT",
        "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
        "EMAIL", "XDG_CONFIG_HOME", "TMPDIR", "NODE_COMPILE_CACHE", "TSX_DISABLE_CACHE",
      ].filter((key) => env[key] !== undefined) })
    })
  })

  // Reverse the second pair so one HOME does not always get the warm caches.
  for (const [round, arms] of [[1, ["real", "scratch"]], [2, ["scratch", "real"]]] as const) {
    for (const arm of arms) {
      it(`times Git with ${arm} HOME, round ${round}`, async () => {
        await withHome(arm, async (root, env) => {
          const repository = join(root, "repository")
          const context = { arm, round }
          await timedGit(root, env, "init", ["init", "--initial-branch=main", repository], context)
          await timedGit(repository, env, "default-ident", ["var", "GIT_COMMITTER_IDENT"], context)
          for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.test"], ["core.autocrlf", "false"]]) {
            await execute("git", ["-C", repository, "config", key!, value!], { env, timeout: 20_000 })
          }
          await timedGit(repository, env, "configured-ident", ["var", "GIT_COMMITTER_IDENT"], context)
          await writeFile(join(repository, "README.md"), "diagnostic fixture\n")
          await execute("git", ["-C", repository, "add", "README.md"], { env, timeout: 20_000 })
          await timedGit(repository, env, "commit", ["commit", "-m", "fixture"], context)
          await timedGit(repository, env, "status", ["status", "--porcelain"], context)
        })
      }, 120_000)

      for (const mode of ["create", "fork"] as const) {
        it(`times tsx ${mode} before-receipt with ${arm} HOME, round ${round}`, async () => {
          await withHome(arm, async (root, env) => {
            const repository = join(root, "repository")
            const git = (args: string[]) => execute("git", ["-C", repository, ...args], { env, timeout: 20_000 })
            await execute("git", ["init", "--initial-branch=main", repository], { env, timeout: 20_000 })
            await git(["config", "user.name", "Fixture"])
            await git(["config", "user.email", "fixture@example.test"])
            await git(["config", "core.autocrlf", "false"])
            await writeFile(join(repository, "README.md"), "preserved repository\n")
            await git(["add", "README.md"])
            await git(["commit", "-m", "fixture"])
            const seed = createEmptyWorkspace(structuredClone(demoWorkspace.machine))
            seed.machine.providers = []
            seed.project = { ...demoWorkspace.project!, id: "project-recovery", path: repository, branch: "main" }
            if (mode === "fork") {
              const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim()
              const source = join(root, "worktrees", "session-source")
              await git(["update-ref", `refs/domovoi/checkpoints/${baseCommit}`, baseCommit])
              await git(["worktree", "add", "-b", "domovoi/session-source", source, baseCommit])
              seed.sessions.push({ id: "session-source", projectId: seed.project.id, title: "Source", state: "idle",
                runtime: creationTestRuntime, changedFiles: 0, testsPassed: 0, testsFailed: 0,
                updatedAt: "2026-09-12T12:00:00.000Z", workspacePath: source, baseCommit })
              seed.activeSessionId = "session-source"
              seed.thread.push({ id: "checkpoint-source", sessionId: "session-source", kind: "checkpoint", reason: "session-start",
                label: "Source checkpoint", commit: baseCommit, createdAt: "2026-09-12T12:00:00.000Z" })
            }
            await writeFile(join(root, "seed.json"), JSON.stringify(seed))
            const tsconfig = join(root, "fixture-tsconfig.json")
            await writeFile(tsconfig, JSON.stringify({ compilerOptions: { paths: {} } }))
            new SqliteWorkspaceStore(join(root, "state.sqlite"), seed).close()
            const started = performance.now()
            // The existing fixture passes homeDirectory: root into production
            // setup, so all Domovoi state stays disposable even in the real arm.
            const child = fork(new URL("./session-creation-recovery.fixture.ts", import.meta.url), ["--creation-crash-fixture", root, mode, "before-receipt"], {
              execArgv: ["--import", import.meta.resolve("tsx")],
              env: { ...env, TSX_TSCONFIG_PATH: tsconfig },
              stdio: ["ignore", "ignore", "ignore", "ipc"],
            })
            const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await new Promise<void>((resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Diagnostic fixture exceeded 20 seconds")), 20_000)
                child.once("error", () => reject(new Error("Diagnostic fixture could not start")))
                child.once("exit", (code, signal) => reject(new Error(`Diagnostic fixture exited: ${code}, ${signal}`)))
                child.on("message", (message: { state?: string }) => { if (message.state === "created") resolve() })
              })
              report({ arm, round, operation: `tsx-${mode}-before-receipt`, ms: Math.round(performance.now() - started), status: 0 })
              expect(child.connected).toBe(true)
            } finally {
              clearTimeout(timer)
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
              await exited
            }
          })
        }, 120_000)
      }
    }
  }
})
