import { execFile, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { maximumEvidenceStagingBytes, maximumEvidenceStagingPaths } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { openIsolatedGit, type IsolatedGit } from "./isolated-checkout.js"
import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { projectRootRead } from "./repository-trust-apply.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { GitWorkspaceService, SessionCommitRefusedError, WorkspaceEvidenceUnstableError, type GitWorkspaceServiceOptions } from "./workspace.js"

// Walk finding F10 (ruled 2026-10-18): the agent's sandbox cannot write a
// linked worktree's Git metadata, so Domovoi commits the session's work when
// a person asks. It commits on the session branch and nowhere else, through
// the isolated Git directory checkpoints use (no repository hook, no program
// from repository config), and refuses a file that looks like a secret.

const execute = promisify(execFile)
const scratchDirectories: string[] = []

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return { ...original, lstat: vi.fn(original.lstat) }
})

vi.mock("./isolated-checkout.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./isolated-checkout.js")>()
  return { ...original, openIsolatedGit: vi.fn(original.openIsolatedGit) }
})

afterEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await removeScratchDirectories(scratchDirectories)
})

const person = ["-c", "user.name=Test User", "-c", "user.email=test@example.invalid"]
const git = async (path: string, ...args: string[]) => (await execute("git", ["-C", path, ...person, ...args])).stdout.trim()

async function sessionWorktree(prefix: string, sessionId = "session-commit", options: GitWorkspaceServiceOptions = {}) {
  const scratch = await mkdtemp(join(tmpdir(), prefix))
  scratchDirectories.push(scratch)
  const repositoryPath = join(scratch, "project")
  await execute("git", ["init", "--initial-branch=main", repositoryPath])
  await git(repositoryPath, "config", "core.autocrlf", "false")
  await writeFile(join(repositoryPath, "README.md"), "before\n")
  await writeFile(join(repositoryPath, "old.txt"), "old\n")
  await writeFile(join(repositoryPath, ".gitignore"), "ignored.log\n")
  await git(repositoryPath, "add", ".")
  await git(repositoryPath, "commit", "-m", "initial")
  const service = new GitWorkspaceService(join(scratch, "worktrees"), options)
  const workspace = await service.createSessionWorkspace(repositoryPath, sessionId)
  return { scratch, repositoryPath, service, workspace, sessionId }
}

async function refusal(promise: Promise<unknown>): Promise<SessionCommitRefusedError> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(SessionCommitRefusedError)
  return error as SessionCommitRefusedError
}

describe("GitWorkspaceService.commit", () => {
  it("lists an oversized untracked file without authorizing a commit", async () => {
    const { service, workspace } = await sessionWorktree("domovoi-evidence-large-")
    const file = join(workspace.path, "large.bin")
    await writeFile(file, "")
    await truncate(file, maximumEvidenceStagingBytes + 1)
    const shown = await service.evidence(workspace.path)
    expect(shown.files.map((entry) => entry.path)).toEqual(["large.bin"])
    expect(shown.changesDigest).toBeUndefined()
    expect(shown.commitUnavailableReason).toEqual({ kind: "staging-limit", limit: "size" })
    const common = await git(workspace.path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    expect((await readdir(common)).filter((name) => name.startsWith("domovoi-checkout-"))).toEqual([])
  })

  it("bounds the number of changed paths before staging", async () => {
    const { service, workspace } = await sessionWorktree("domovoi-evidence-many-", "session-commit", { evidenceStagingBudgetMs: 30_000 })
    const changedPaths = maximumEvidenceStagingPaths + 1
    for (let start = 0; start < changedPaths; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, changedPaths - start) }, (_, offset) =>
        writeFile(join(workspace.path, `new-${start + offset}.txt`), "small\n")))
    }
    const shown = await service.evidence(workspace.path)
    expect(shown.totalChangedFiles).toBe(changedPaths)
    expect(shown.changesDigest).toBeUndefined()
    expect(shown.commitUnavailableReason).toEqual({ kind: "staging-limit", limit: "paths" })
    const common = await git(workspace.path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    expect((await readdir(common)).filter((name) => name.startsWith("domovoi-checkout-"))).toEqual([])
  }, 30_000)

  it("does not stat unchanged tracked files to reuse staged evidence", async () => {
    const { service, workspace } = await sessionWorktree("domovoi-evidence-stat-cost-")
    await writeFile(join(workspace.path, "new.txt"), "new\n")
    vi.mocked(lstat).mockClear()
    expect((await service.evidence(workspace.path)).changesDigest).toBeDefined()
    const paths = vi.mocked(lstat).mock.calls.map(([path]) => path.toString())
    expect(paths).toContain(join(workspace.path, "new.txt"))
    expect(paths).not.toContain(join(workspace.path, "README.md"))
    expect(paths).not.toContain(join(workspace.path, "old.txt"))
  })

  it.each([false, true])("streams large index listings and split gitlink entries (gitlink: %s)", async (gitlink) => {
    const { service, workspace } = await sessionWorktree("domovoi-evidence-index-stream-")
    await writeFile(join(workspace.path, "new.txt"), "new\n")
    const original = await vi.importActual<typeof import("./isolated-checkout.js")>("./isolated-checkout.js")
    let stages = 0
    const stopped: boolean[] = []
    vi.mocked(openIsolatedGit).mockImplementationOnce(async (input) => {
      const isolated = await original.openIsolatedGit(input)
      const run = isolated.run.bind(isolated)
      const stream = isolated.stream.bind(isolated)
      const scan: IsolatedGit["stream"] = async (args, onStdout, options) => {
        if (args[0] !== "ls-files" || !args.includes("--stage")) return stream(args, onStdout, options)
        let stop = false
        const emit = (chunk: Buffer) => { if (!stop) onStdout(chunk, () => { stop = true }) }
        // A path containing the mode text must not count as a gitlink.
        const entry = `100644 ${"a".repeat(40)} 0\t160000 ordinary-file\0`
        if (gitlink) {
          // Every boundary, including the mode prefix and NUL, splits a chunk.
          for (const byte of Buffer.from(`${entry}160000 ${"b".repeat(40)} 0\tmodule\0`)) emit(Buffer.from([byte]))
        } else {
          const chunk = Buffer.from(entry.repeat(16_384))
          for (let i = 0; i < 33; i += 1) emit(chunk)
        }
        stopped.push(stop)
        return { code: stop ? null : 0, signal: stop ? "SIGTERM" : null, stderr: "" }
      }
      return { ...isolated, stream: scan, run: async (args, options) => {
        if (args[0] === "add") stages += 1
        return run(args, options)
      } }
    })
    expect((await service.evidence(workspace.path)).changesDigest).toBeDefined()
    expect(stages).toBe(gitlink ? 2 : 1)
    expect(stopped).toEqual([gitlink, gitlink])
  })

  it("keeps the canonical digest identical to fresh staging", async () => {
    const { service, workspace } = await sessionWorktree("domovoi-evidence-canonical-")
    await writeFile(join(workspace.path, "README.md"), "modified\n")
    await writeFile(join(workspace.path, "new.txt"), "new\n")
    await rm(join(workspace.path, "old.txt"))
    const shown = await service.evidence(workspace.path)
    await git(workspace.path, "add", "--all")
    const raw = spawnSync("git", ["-C", workspace.path, "diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", shown.baseCommit, "--"])
    expect(raw.status).toBe(0)
    const expected = createHash("sha256").update("domovoi.commit-changes.v1\0").update(shown.baseCommit).update("\0").update(raw.stdout).digest("hex")
    expect(shown.changesDigest).toBe(`sha256:${expected}`)
    expect((await service.evidence(workspace.path)).changesDigest).toBe(shown.changesDigest)
  })

  it("keeps untracked evidence readable when a clean filter exceeds the staging budget", async () => {
    const { scratch, repositoryPath, workspace } = await sessionWorktree("domovoi-evidence-budget-")
    const home = join(scratch, "home")
    await mkdir(home)
    vi.stubEnv("HOME", home)
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"))
    const script = join(scratch, "slow-clean.sh").replaceAll("\\", "/")
    await writeFile(script, "sleep 2\ncat\n")
    await git(repositoryPath, "config", "--global", "filter.slow.clean", `sh "${script}"`)
    await writeFile(join(workspace.path, ".gitattributes"), "new.txt filter=slow\n")
    await writeFile(join(workspace.path, "new.txt"), "untracked\n")
    const service = new GitWorkspaceService(join(scratch, "worktrees"), { evidenceStagingBudgetMs: 1_000 })
    const shown = await service.evidence(workspace.path)
    expect(shown.files.map((file) => file.path)).toContain("new.txt")
    expect(shown.changesDigest).toBeUndefined()
    expect(shown.commitUnavailableReason).toEqual({ kind: "staging-limit", limit: "time" })
    const common = await git(workspace.path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    expect((await readdir(common)).filter((name) => name.startsWith("domovoi-checkout-"))).toEqual([])
  })

  it.each(["global", "reviewed repository"])("withholds a digest when a %s clean filter changes output on every run", async (scope) => {
    const { scratch, repositoryPath, workspace } = await sessionWorktree("domovoi-evidence-filter-state-")
    const home = join(scratch, "home")
    await mkdir(home)
    vi.stubEnv("HOME", home)
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"))
    const script = join(scratch, "changing-clean.sh").replaceAll("\\", "/")
    const counter = join(scratch, "counter").replaceAll("\\", "/")
    await writeFile(script, [
      'set -eu',
      'count=0',
      'if test -f "$1"; then read -r count < "$1"; fi',
      'count=$((count + 1))',
      'printf "%s\\n" "$count" > "$1"',
      'cat',
      'printf "%s\\n" "$count"',
      '',
    ].join("\n"))
    await git(repositoryPath, "config", ...(scope === "global" ? ["--global"] : []), "filter.changing.clean", `sh "${script}" "${counter}"`)
    const config = await readRepositoryProviderConfig(repositoryPath, projectRootRead)
    const grant = {
      projectId: "project-changing-filter", trustedDigest: config.configDigest, trustedAt: "2026-10-19T00:00:00.000Z",
      trustedBy: { client: "desktop" as const },
      ...(config.gitFilters?.reviewDigest === undefined ? {} : { gitFilterReviewDigest: config.gitFilters.reviewDigest }),
    }
    const service = new GitWorkspaceService(join(scratch, "worktrees"), scope === "global" ? {} : {
      repositoryTrust: () => ({ projectId: grant.projectId, projectPath: repositoryPath, grant: () => grant, generation: () => 0 }),
    })
    await writeFile(join(workspace.path, ".gitattributes"), "new.txt filter=changing\n")
    await writeFile(join(workspace.path, "new.txt"), "unchanged bytes\n")
    const shown = await service.evidence(workspace.path)
    expect(shown.files.map((file) => file.path)).toContain("new.txt")
    expect(shown.changesDigest).toBeUndefined()
    expect(shown.commitUnavailableReason).toBeUndefined()
    expect(Number(await readFile(counter, "utf8"))).toBeGreaterThanOrEqual(2)
    expect(await readFile(join(workspace.path, "new.txt"), "utf8")).toBe("unchanged bytes\n")
  })

  it.each(["clean", "process"])("reuses staging with an unused global %s driver", async (command) => {
    const { scratch, repositoryPath, service, workspace } = await sessionWorktree("domovoi-evidence-filter-driver-")
    const home = join(scratch, "home")
    await mkdir(home)
    vi.stubEnv("HOME", home)
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"))
    await git(repositoryPath, "config", "--global", `filter.unused.${command}`, "unused-filter-must-not-run")
    await writeFile(join(workspace.path, "new.txt"), "new\n")
    const original = await vi.importActual<typeof import("./isolated-checkout.js")>("./isolated-checkout.js")
    let stages = 0
    vi.mocked(openIsolatedGit).mockImplementationOnce(async (input) => {
      const isolated = await original.openIsolatedGit(input)
      const run = isolated.run.bind(isolated)
      return { ...isolated, run: async (args, options) => {
        if (args[0] === "add") stages += 1
        return run(args, options)
      } }
    })
    expect((await service.evidence(workspace.path)).changesDigest).toBeDefined()
    expect(stages).toBe(1)
  })

  it.each([
    ["", 1], ["-filter", 1], ["filter", 2], ["filter=", 2], ["filter=unknown", 2],
  ] as const)("uses the changed path's filter attribute %s to choose %s staging passes", async (attribute, expected) => {
    const { service, workspace } = await sessionWorktree("domovoi-evidence-filter-attribute-")
    const path = "new file.txt"
    if (attribute) await writeFile(join(workspace.path, ".gitattributes"), `"${path}" ${attribute}\n`)
    await writeFile(join(workspace.path, path), "new\n")
    const original = await vi.importActual<typeof import("./isolated-checkout.js")>("./isolated-checkout.js")
    let stages = 0
    vi.mocked(openIsolatedGit).mockImplementationOnce(async (input) => {
      const isolated = await original.openIsolatedGit(input)
      const run = isolated.run.bind(isolated)
      return { ...isolated, run: async (args, options) => {
        if (args[0] === "add") stages += 1
        return run(args, options)
      } }
    })
    expect((await service.evidence(workspace.path)).changesDigest).toBeDefined()
    expect(stages).toBe(expected)
  })

  it.each(["failed", "truncated", "wrong path"])("withholds the digest after a %s filter attribute query", async (failure) => {
    const { service, workspace } = await sessionWorktree("domovoi-evidence-filter-query-")
    await writeFile(join(workspace.path, "new.txt"), "new\n")
    const original = await vi.importActual<typeof import("./isolated-checkout.js")>("./isolated-checkout.js")
    vi.mocked(openIsolatedGit).mockImplementationOnce(async (input) => {
      const isolated = await original.openIsolatedGit(input)
      const stream = isolated.stream.bind(isolated)
      return { ...isolated, stream: async (args, onStdout, options) => {
        if (args[0] !== "check-attr") return stream(args, onStdout, options)
        if (failure === "truncated") onStdout(Buffer.from("new.txt\0filter\0"), () => {})
        if (failure === "wrong path") onStdout(Buffer.from("other.txt\0filter\0unspecified\0"), () => {})
        return { code: failure === "failed" ? 1 : 0, signal: null, stderr: "" }
      } }
    })
    const evidence = await service.evidence(workspace.path)
    expect(evidence.files.some((file) => file.path === "new.txt")).toBe(true)
    expect(evidence.changesDigest).toBeUndefined()
  })

  it("does not turn caller cancellation into readable evidence", async () => {
    const { service, workspace } = await sessionWorktree("domovoi-evidence-cancel-")
    const controller = new AbortController()
    controller.abort(new Error("caller cancelled"))
    await expect(service.evidence(workspace.path, controller.signal)).rejects.toThrow()
  })

  it("does not reuse a digest after same-size bytes change with restored mtime", async () => {
    let path = ""
    let observations = 0
    const { service, workspace } = await sessionWorktree("domovoi-evidence-stat-race-", "session-commit", {
      afterEvidenceObservation: async () => {
        if (++observations !== 1) return
        const file = join(path, "new.txt")
        const before = await lstat(file)
        await writeFile(file, "later\n")
        await utimes(file, before.atime, before.mtime)
      },
    })
    path = workspace.path
    await writeFile(join(path, "new.txt"), "prior\n")
    const shown = await service.evidence(path)
    expect(observations).toBe(2)
    expect(shown.changesDigest).toBe((await service.evidence(path)).changesDigest)
  })

  it("does not retain file contents in the repository object store when reading evidence", async () => {
    const { service, workspace } = await sessionWorktree("domovoi-commit-private-objects-")
    const contents = "uncommitted evidence fixture\n"
    await writeFile(join(workspace.path, "new.txt"), contents)
    const blob = spawnSync("git", ["-C", workspace.path, "hash-object", "--stdin"], { input: contents, encoding: "utf8" }).stdout.trim()
    await expect(git(workspace.path, "cat-file", "-e", blob)).rejects.toThrow()
    expect((await service.evidence(workspace.path)).changesDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    await expect(git(workspace.path, "cat-file", "-e", blob)).rejects.toThrow()
  })

  it.each([
    ["checkpoint", "default"], ["commit", "default"],
    ["checkpoint", "custom"], ["commit", "custom"],
  ] as const)("discards evidence LFS payloads but retains %s payloads in the %s store", async (operation, store) => {
    const { scratch, repositoryPath, workspace, sessionId } = await sessionWorktree("domovoi-commit-lfs-storage-")
    const home = join(scratch, "home")
    await mkdir(home)
    vi.stubEnv("HOME", home)
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"))
    const script = join(scratch, "fake-clean.sh").replaceAll("\\", "/")
    const observations = join(scratch, "storage-observations").replaceAll("\\", "/")
    await writeFile(script, [
      'set -eu',
      'lfs_store=$(git config --get lfs.storage)',
      'mkdir -p "$lfs_store"',
      'cat > "$lfs_store/payload"',
      'printf "%s\\n" "$lfs_store" >> "$1"',
      'cat "$lfs_store/payload"',
      '',
    ].join("\n"))
    // Checkpoints can run reviewed repository filters. A person's commit
    // accepts only filters from the person's global/system configuration.
    const scope = operation === "commit" ? ["--global"] : []
    await git(repositoryPath, "config", ...scope, "filter.fixture.clean", `sh "${script}" "${observations}"`)
    await git(repositoryPath, "config", ...scope, "filter.fixture.required", "true")
    const common = await git(workspace.path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    const persistentStore = store === "custom" ? join(scratch, "custom-lfs") : join(common, "lfs")
    if (store === "custom") await git(repositoryPath, "config", "--global", "lfs.storage", persistentStore)
    const config = await readRepositoryProviderConfig(repositoryPath, projectRootRead)
    if (operation === "checkpoint") expect(config.gitFilters?.reviewDigest).toBeDefined()
    const grant = {
      projectId: "project-lfs", trustedDigest: config.configDigest, trustedAt: "2026-10-19T00:00:00.000Z",
      trustedBy: { client: "desktop" as const },
      ...(config.gitFilters?.reviewDigest === undefined ? {} : { gitFilterReviewDigest: config.gitFilters.reviewDigest }),
    }
    const service = new GitWorkspaceService(join(scratch, "worktrees"), {
      repositoryTrust: () => ({ projectId: grant.projectId, projectPath: repositoryPath, grant: () => grant, generation: () => 0 }),
    })
    await writeFile(join(workspace.path, ".gitattributes"), "object.bin filter=fixture\n")
    await writeFile(join(workspace.path, "object.bin"), "payload bytes\n")
    const shown = await service.evidence(workspace.path)
    expect(shown.changesDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const seen = (await readFile(observations, "utf8")).trim().split("\n")
    // Filters may depend on external state, so Git must stage both observations.
    expect(seen).toHaveLength(2)
    await expect(lstat(persistentStore)).rejects.toMatchObject({ code: "ENOENT" })
    for (const storage of seen) {
      expect(storage).toContain("domovoi-checkout-")
      await expect(lstat(storage)).rejects.toMatchObject({ code: "ENOENT" })
    }
    const made = operation === "checkpoint"
      ? await service.checkpoint(workspace.path, "retain LFS payload")
      : await service.commit(workspace.path, {
          repositoryPath, sessionId, message: "feat: retain payload", expectedHead: shown.baseCommit, expectedChangesDigest: shown.changesDigest!,
        })
    expect(await readFile(join(persistentStore, "payload"), "utf8")).toBe("payload bytes\n")
    expect((await readFile(observations, "utf8")).trim().split("\n").at(-1)).toBe(persistentStore)
    expect(await git(workspace.path, "show", `${made.commit}:object.bin`)).toBe("payload bytes")
  })

  it("keeps evidence readable without a commit digest when submodule config makes staging unsafe", async () => {
    const { repositoryPath, service, workspace } = await sessionWorktree("domovoi-commit-submodule-filter-")
    await git(workspace.path, "-c", "protocol.file.allow=always", "submodule", "add", repositoryPath, "library")
    await git(join(workspace.path, "library"), "config", "filter.unsafe.clean", "domovoi-test-filter-must-not-run")
    const shown = await service.evidence(workspace.path)
    expect(shown.files.some((file) => file.path === "library")).toBe(true)
    expect(shown.changesDigest).toBeUndefined()
    expect(shown.commitUnavailableReason).toBeUndefined()
  })

  it.each(["depth", "unreadable-config"])("withholds the digest when the submodule guard fails for %s", async (reason) => {
    const { repositoryPath, service, workspace } = await sessionWorktree("domovoi-commit-submodule-guard-")
    let parent = workspace.path
    for (let depth = 0; depth < (reason === "depth" ? 9 : 2); depth += 1) {
      const child = join(parent, "library")
      await git(parent, "clone", "--local", repositoryPath, child)
      await git(parent, "update-index", "--add", "--cacheinfo", `160000,${workspace.baseCommit},library`)
      parent = child
    }
    if (reason === "unreadable-config") await writeFile(join(parent, ".git", "config"), "[invalid\n")
    const shown = await service.evidence(workspace.path)
    expect(shown.files.some((file) => file.path === "library")).toBe(true)
    expect(shown.changesDigest).toBeUndefined()
  })

  it("keeps evidence readable without a digest when sparse staging refuses a path", async () => {
    const { service, workspace } = await sessionWorktree("domovoi-commit-sparse-evidence-")
    await git(workspace.path, "sparse-checkout", "set", "--no-cone", "/README.md")
    await writeFile(join(workspace.path, "outside.txt"), "outside\n")
    const shown = await service.evidence(workspace.path)
    expect(shown.files.some((file) => file.path === "outside.txt")).toBe(true)
    expect(shown.changesDigest).toBeUndefined()
    expect(shown.commitUnavailableReason).toBeUndefined()
  })

  it("binds all files beyond the displayed 200", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-many-")
    await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(join(workspace.path, `file-${String(index).padStart(3, "0")}.txt`), "shown\n")))
    const shown = await service.evidence(workspace.path)
    expect(shown.files).toHaveLength(200)
    expect(shown.totalChangedFiles).toBe(201)
    await writeFile(join(workspace.path, "file-200.txt"), "not shown\n")
    expect((await refusal(service.commit(workspace.path, {
      repositoryPath, sessionId, message: "feat: all", expectedHead: shown.baseCommit, expectedChangesDigest: shown.changesDigest!,
    }))).reason).toBe("changes-moved")
    expect(await git(workspace.path, "rev-parse", "HEAD")).toBe(shown.baseCommit)
  })

  it("does not accept a missing digest from an internal caller", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-missing-")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const error = await refusal(service.commit(workspace.path, {
      repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit,
      expectedChangesDigest: undefined as unknown as string,
    }))
    expect(error.reason).toBe("changes-moved")
    expect(await git(workspace.path, "rev-parse", "HEAD")).toBe(workspace.baseCommit)
  })

  it.skipIf(process.platform === "win32")("binds executable modes and symlink targets", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-modes-")
    await git(repositoryPath, "config", "core.filemode", "true")
    await writeFile(join(workspace.path, "README.md"), "shown\n")
    await symlink("README.md", join(workspace.path, "link"))
    const shown = await service.evidence(workspace.path)
    await chmod(join(workspace.path, "README.md"), 0o755)
    const mode = await service.evidence(workspace.path)
    expect(mode.changesDigest).not.toBe(shown.changesDigest)
    await rm(join(workspace.path, "link"))
    await symlink("old.txt", join(workspace.path, "link"))
    const target = await service.evidence(workspace.path)
    expect(target.changesDigest).not.toBe(mode.changesDigest)
    expect((await refusal(service.commit(workspace.path, {
      repositoryPath, sessionId, message: "feat: mode", expectedHead: shown.baseCommit, expectedChangesDigest: mode.changesDigest!,
    }))).reason).toBe("changes-moved")
  })

  it("hashes raw path bytes even when decoded names look identical", async () => {
    const { service, workspace } = await sessionWorktree("domovoi-commit-raw-")
    const digest = async (byte: number) => {
      await git(workspace.path, "read-tree", workspace.baseCommit)
      const name = Buffer.concat([Buffer.from("library-"), Buffer.from([byte])])
      const record = Buffer.concat([Buffer.from(`160000 ${workspace.baseCommit}\t`), name, Buffer.from([0])])
      expect(spawnSync("git", ["-C", workspace.path, "update-index", "-z", "--index-info"], { input: record }).status).toBe(0)
      expect(spawnSync("git", ["-C", workspace.path, "update-index", "--skip-worktree", "-z", "--stdin"], { input: Buffer.concat([name, Buffer.from([0])]) }).status).toBe(0)
      return service.evidence(workspace.path)
    }
    const first = await digest(0xff)
    const second = await digest(0xfe)
    expect(first.files.map((file) => file.path)).toEqual(second.files.map((file) => file.path))
    expect(first.changesDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(second.changesDigest).not.toBe(first.changesDigest)
  })

  it("retries evidence when only untracked content changes during the read", async () => {
    let path = ""
    let observations = 0
    const { service, workspace } = await sessionWorktree("domovoi-commit-read-race-", "session-commit", {
      afterEvidenceObservation: async () => {
        observations += 1
        if (observations === 1) await writeFile(join(path, "new.txt"), "later\n")
      },
    })
    path = workspace.path
    await writeFile(join(path, "new.txt"), "earlier\n")
    const shown = await service.evidence(path)
    expect(observations).toBe(2)
    expect(shown.changesDigest).toBe((await service.evidence(path)).changesDigest)
  })

  it("keeps evidence readable without a digest when only untracked bytes never stabilize", async () => {
    let path = ""
    let observations = 0
    const { service, workspace } = await sessionWorktree("domovoi-commit-unstable-", "session-commit", {
      afterEvidenceObservation: async () => { await writeFile(join(path, "new.txt"), `change ${++observations}\n`) },
    })
    path = workspace.path
    await writeFile(join(path, "new.txt"), "earlier\n")
    const shown = await service.evidence(path)
    expect(observations).toBe(3)
    expect(shown.files.map((file) => file.path)).toEqual(["new.txt"])
    expect(shown.changesDigest).toBeUndefined()
  })

  it("still refuses evidence when tracked content never stabilizes", async () => {
    let path = ""
    let observations = 0
    const { service, workspace } = await sessionWorktree("domovoi-commit-tracked-unstable-", "session-commit", {
      afterEvidenceObservation: async () => { await writeFile(join(path, "README.md"), `change ${++observations}\n`) },
    })
    path = workspace.path
    await expect(service.evidence(path)).rejects.toBeInstanceOf(WorkspaceEvidenceUnstableError)
    expect(observations).toBe(3)
  })

  it("compares the staged contents, not a later worktree write", async () => {
    let path = ""
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-staged-race-", "session-commit", {
      afterCheckpointStaging: async () => { if (path) await writeFile(join(path, "README.md"), "later\n") },
    })
    path = workspace.path
    await writeFile(join(path, "README.md"), "shown\n")
    const shown = await service.evidence(path)
    const made = await service.commit(path, {
      repositoryPath, sessionId, message: "feat: shown", expectedHead: shown.baseCommit, expectedChangesDigest: shown.changesDigest!,
    })
    expect(await git(path, "show", `${made.commit}:README.md`)).toBe("shown")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("later\n")
  })

  it("commits an unchanged staged gitlink even when the submodule is unpopulated and configured to be ignored", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-gitlink-")
    await writeFile(join(workspace.path, ".gitmodules"), '[submodule "library"]\n path = library\n url = ./library\n ignore = all\n')
    await git(workspace.path, "add", ".gitmodules")
    await git(workspace.path, "update-index", "--add", "--cacheinfo", `160000,${workspace.baseCommit},library`)
    await mkdir(join(workspace.path, "library"))
    const shown = await service.evidence(workspace.path)
    expect(shown.files.some((file) => file.path === "library")).toBe(true)
    const made = await service.commit(workspace.path, {
      repositoryPath, sessionId, message: "feat: library", expectedHead: shown.baseCommit, expectedChangesDigest: shown.changesDigest!,
    })
    expect(made.changedFiles).toContain("library")
  })

  it.each(["content", "add", "delete", "rename", "untracked-content"])("refuses %s changed after the card read without writing the index or refs", async (change) => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-stale-")
    await writeFile(join(workspace.path, "README.md"), "shown\n")
    await git(workspace.path, "add", "README.md")
    await writeFile(join(workspace.path, "new.txt"), "shown new\n")
    const shown = await service.evidence(workspace.path)
    if (change === "content") await writeFile(join(workspace.path, "README.md"), "not shown\n")
    if (change === "add") await writeFile(join(workspace.path, "extra.txt"), "not shown\n")
    if (change === "delete") await rm(join(workspace.path, "old.txt"))
    if (change === "rename") await rename(join(workspace.path, "old.txt"), join(workspace.path, "renamed.txt"))
    if (change === "untracked-content") await writeFile(join(workspace.path, "new.txt"), "not shown\n")
    const indexPath = await git(workspace.path, "rev-parse", "--path-format=absolute", "--git-path", "index")
    const beforeIndex = await readFile(indexPath)
    const beforeStatus = await git(workspace.path, "status", "--porcelain=v2")
    const beforeDiff = await git(workspace.path, "diff", "HEAD")
    const error = await refusal(service.commit(workspace.path, {
      repositoryPath, sessionId, message: "feat: reviewed", expectedHead: shown.baseCommit,
      expectedChangesDigest: shown.changesDigest!,
    }))
    expect(error.reason).toBe("changes-moved")
    expect(error.message).toContain("Refresh and review the changes again")
    expect(await readFile(indexPath)).toEqual(beforeIndex)
    expect(await git(workspace.path, "rev-parse", "HEAD")).toBe(shown.baseCommit)
    expect(await git(workspace.path, "status", "--porcelain=v2")).toBe(beforeStatus)
    expect(await git(workspace.path, "diff", "HEAD")).toBe(beforeDiff)
  })

  it("commits every change in the worktree on the session branch with the person's message", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-")
    await git(repositoryPath, "config", "user.name", "Dana Person")
    await git(repositoryPath, "config", "user.email", "dana@example.invalid")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    await writeFile(join(workspace.path, "new.txt"), "new\n")
    await writeFile(join(workspace.path, "ignored.log"), "never committed\n")
    await rm(join(workspace.path, "old.txt"))
    const mainBefore = await git(repositoryPath, "rev-parse", "main")

    const made = await service.commit(workspace.path, {
      repositoryPath, sessionId, message: "feat(readme): say after\n\nThe body stays.", expectedHead: workspace.baseCommit, expectedChangesDigest: (await service.evidence(workspace.path)).changesDigest!,
    })

    expect(made.branch).toBe(`domovoi/${sessionId}`)
    expect(made.commit).toMatch(/^[a-f0-9]{40}$/u)
    expect(made.changedFiles).toEqual(["README.md", "new.txt", "old.txt"])
    expect(await git(workspace.path, "rev-parse", `refs/heads/domovoi/${sessionId}`)).toBe(made.commit)
    expect(await git(workspace.path, "rev-parse", `${made.commit}^`)).toBe(workspace.baseCommit)
    expect(await git(workspace.path, "log", "-1", "--format=%B", made.commit)).toBe("feat(readme): say after\n\nThe body stays.")
    // The person is the author, as the design draws it; Domovoi made it.
    expect(await git(workspace.path, "log", "-1", "--format=%an <%ae>|%cn <%ce>", made.commit))
      .toBe("Dana Person <dana@example.invalid>|Domovoi <domovoi@localhost>")
    expect(await git(workspace.path, "cat-file", "commit", made.commit)).not.toContain("gpgsig")
    expect(await git(workspace.path, "show", `${made.commit}:README.md`)).toBe("after")
    await expect(git(workspace.path, "show", `${made.commit}:ignored.log`)).rejects.toThrow()
    // The commit restores and transfers like a checkpoint.
    expect(await git(workspace.path, "rev-parse", `refs/domovoi/checkpoints/${made.commit}^{commit}`)).toBe(made.commit)
    // The worktree reads as clean afterwards, but for the ignored file.
    expect(await git(workspace.path, "status", "--porcelain")).toBe("")
    // No other branch moved and the person's own checkout was not written.
    expect(await git(repositoryPath, "rev-parse", "main")).toBe(mainBefore)
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("before\n")
  })

  it("refuses with nothing written when the worktree is on another branch", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-branch-")
    await git(workspace.path, "switch", "-q", "-c", "elsewhere")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const mainBefore = await git(repositoryPath, "rev-parse", "main")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("not-session-branch")
    expect(error.message).toContain(`domovoi/${sessionId}`)
    expect(await git(workspace.path, "rev-parse", "elsewhere")).toBe(workspace.baseCommit)
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
    expect(await git(repositoryPath, "rev-parse", "main")).toBe(mainBefore)
    expect(await git(workspace.path, "status", "--porcelain")).toBe("M README.md")
  })

  it("refuses a detached HEAD", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-detached-")
    await git(workspace.path, "switch", "-q", "--detach")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("not-session-branch")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  it("refuses when the session branch moved since the person read the changes", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-moved-")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const moved = (await service.checkpoint(workspace.path, "in between")).commit
    await writeFile(join(workspace.path, "README.md"), "later\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("head-moved")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(moved)
  })

  it("refuses a worktree that is not this session's own", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-other-")
    const other = await service.createSessionWorkspace(repositoryPath, "session-other")
    await writeFile(join(other.path, "README.md"), "after\n")
    await writeFile(join(repositoryPath, "README.md"), "after\n")

    // Another session's worktree under this session's id.
    expect((await refusal(service.commit(other.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))).reason)
      .toBe("not-session-worktree")
    // The person's own checkout, as an adopted session would record it.
    expect((await refusal(service.commit(repositoryPath, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))).reason)
      .toBe("not-session-worktree")
    expect(await git(repositoryPath, "rev-parse", "main")).toBe(workspace.baseCommit)
    expect(await git(repositoryPath, "rev-parse", "domovoi/session-other")).toBe(other.baseCommit)
  })

  it("refuses a session ref that points at another branch, and never moves that branch", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-symref-")
    await git(repositoryPath, "branch", "elsewhere", workspace.baseCommit)
    // HEAD still names the session ref, and the ref resolves to expectedHead,
    // but through elsewhere: a plain update-ref would move elsewhere.
    await git(workspace.path, "symbolic-ref", `refs/heads/domovoi/${sessionId}`, "refs/heads/elsewhere")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("not-session-branch")
    expect(await git(repositoryPath, "rev-parse", "refs/heads/elsewhere")).toBe(workspace.baseCommit)
  })

  it("refuses a checkout at the session's path that is not a worktree of the session's repository", async () => {
    const { scratch, repositoryPath, service } = await sessionWorktree("domovoi-commit-clone-")
    // An ordinary clone where the session's worktree would be, on the branch
    // a session worktree would be on.
    const sessionId = "session-clone"
    const path = join(scratch, "worktrees", sessionId)
    await execute("git", ["clone", "-q", repositoryPath, path])
    await git(path, "switch", "-q", "-c", `domovoi/${sessionId}`)
    const head = await git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "README.md"), "after\n")

    // Against the repository it was cloned from, and against itself.
    for (const project of [repositoryPath, path]) {
      const error = await refusal(service.commit(path, { repositoryPath: project, sessionId, message: "feat: x", expectedHead: head, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))
      expect(error.reason).toBe("not-session-worktree")
    }
    expect(await git(path, "rev-parse", `domovoi/${sessionId}`)).toBe(head)
  })

  it("keeps the commit's checkpoint ref from carrying it onto another branch", async () => {
    // Fixed dates make the commit's id the same on a second try.
    vi.stubEnv("GIT_AUTHOR_DATE", "2026-10-18T12:00:00Z")
    vi.stubEnv("GIT_COMMITTER_DATE", "2026-10-18T12:00:00Z")
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-checkpoint-symref-")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const request = { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: (await service.evidence(workspace.path)).changesDigest! }
    const first = await service.commit(workspace.path, request)
    // Back to the start with the same files, and the ref the same commit
    // will be retained under made a symbolic ref to another branch.
    await git(workspace.path, "update-ref", `refs/heads/domovoi/${sessionId}`, workspace.baseCommit)
    await git(workspace.path, "read-tree", workspace.baseCommit)
    await git(repositoryPath, "branch", "elsewhere", workspace.baseCommit)
    await git(repositoryPath, "update-ref", "-d", `refs/domovoi/checkpoints/${first.commit}`)
    await git(repositoryPath, "symbolic-ref", `refs/domovoi/checkpoints/${first.commit}`, "refs/heads/elsewhere")

    const second = await service.commit(workspace.path, request)

    expect(second.commit).toBe(first.commit)
    expect(await git(repositoryPath, "rev-parse", "refs/heads/elsewhere")).toBe(workspace.baseCommit)
  })

  it("refuses a worktree whose .git is a link to another worktree's", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-git-link-")
    const other = await service.createSessionWorkspace(repositoryPath, "session-other")
    // The other worktree takes the session branch, which the session's own
    // worktree gives up first, and the session's .git then points at it.
    await git(workspace.path, "switch", "-q", "--detach")
    await git(other.path, "switch", "-q", `domovoi/${sessionId}`)
    await rm(join(workspace.path, ".git"))
    await symlink(join(other.path, ".git"), join(workspace.path, ".git"))
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const otherIndex = await git(other.path, "ls-files", "--stage")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("not-session-worktree")
    expect(await git(other.path, "ls-files", "--stage")).toBe(otherIndex)
  })

  it("leaves the index alone when the worktree switches branch while Domovoi commits", async () => {
    let worktree = ""
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-switch-", "session-commit", {
      // A switch to another branch at the same start: the index Git keeps
      // for it is the one Domovoi read, so only HEAD tells them apart.
      afterSessionCommit: async () => { await git(worktree, "switch", "-q", "-c", "other", "HEAD~1") },
    })
    worktree = workspace.path
    await writeFile(join(workspace.path, "README.md"), "after\n")
    const indexBefore = await git(workspace.path, "ls-files", "--stage")

    const made = await service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: (await service.evidence(workspace.path)).changesDigest! })

    expect(made.afterCommitError).toContain("left domovoi/session-commit")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(made.commit)
    expect(await git(workspace.path, "symbolic-ref", "HEAD")).toBe("refs/heads/other")
    expect(await git(workspace.path, "ls-files", "--stage")).toBe(indexBefore)
  })

  it("does not name a secret-named submodule it refuses for its own config", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-secret-submodule-")
    const submodule = join(workspace.path, "private", ".env")
    await execute("git", ["init", "-q", "--initial-branch=main", submodule])
    await writeFile(join(submodule, "keys.txt"), "k\n")
    await git(submodule, "add", ".")
    await git(submodule, "commit", "-q", "-m", "keys")
    await git(submodule, "config", "remote.origin.promisor", "true")
    await git(workspace.path, "update-index", "--add", "--cacheinfo", `160000,${await git(submodule, "rev-parse", "HEAD")},private/.env`)

    const error = await service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` })
      .then(() => undefined, (cause: unknown) => cause as Error)

    expect(error).toBeInstanceOf(Error)
    expect(error!.message).not.toContain(".env")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  // Walk finding F10, reviews R4.2 and R5.1, ruling Q140: the isolated Git
  // directory reads none of the repository's own config but what it carries.
  // Whatever it holds back from that config (a filter driver it blanks, a Git
  // LFS group it leaves out, any key it drops) could make a commit store
  // something other than Git would, so a person's commit refuses whenever the
  // directory reads a repository value other than the worktree does, decided
  // from the one config read the directory is built from and again once
  // staging is done. Only keys that change nothing a commit stores or runs
  // are let through.
  describe("repository config the isolated directory holds back", () => {
    // The seams run `armed.<seam>` once armed, after the setup below.
    async function heldBack(prefix: string) {
      const armed: { gate?: () => Promise<void>, staged?: () => Promise<void> } = {}
      const made = await sessionWorktree(prefix, "session-commit", {
        afterRepositoryFilterGate: async () => { await armed.gate?.() },
        afterCheckpointStaging: async () => { await armed.staged?.() },
      })
      const marker = join(made.scratch, "program-ran").replaceAll("\\", "/")
      const script = join(made.scratch, "encrypt.sh").replaceAll("\\", "/")
      await writeFile(script, `echo ran >> "${marker}"\ntr a-z n-za-m\n`)
      await writeFile(join(made.workspace.path, ".gitattributes"), "notes.txt filter=crypt\n")
      await writeFile(join(made.workspace.path, "notes.txt"), "plain words\n")
      const config = join(made.repositoryPath, ".git", "config")
      const append = async (lines: string) => { await writeFile(config, `${await readFile(config, "utf8")}${lines}`) }
      const commit = () => refusal(made.service.commit(made.workspace.path, {
        repositoryPath: made.repositoryPath, sessionId: made.sessionId, message: "feat: notes", expectedHead: made.workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}`,
      }))
      const untouched = async () => {
        await expect(readFile(marker, "utf8")).rejects.toThrow()
        expect(await git(made.workspace.path, "rev-parse", `domovoi/${made.sessionId}`)).toBe(made.workspace.baseCommit)
      }
      return { ...made, armed, script, config, append, commit, untouched }
    }

    it("refuses when an included config file gains a filter between the gate and the isolated directory", async () => {
      const { repositoryPath, scratch, armed, script, commit, untouched } = await heldBack("domovoi-commit-late-include-")
      const included = join(scratch, "included.gitconfig")
      await writeFile(included, "")
      await git(repositoryPath, "config", "include.path", included)
      armed.gate = () => writeFile(included, `[filter "crypt"]\n\tclean = sh ${script}\n\tsmudge = sh ${script}\n\trequired = true\n`)

      const error = await commit()

      expect(error.reason).toBe("held-back-config")
      expect(error.message).toContain("filter.crypt.clean")
      await untouched()
    })

    it("refuses when the repository's config gains a filter after the isolated directory staged", async () => {
      const { armed, append, script, commit, untouched } = await heldBack("domovoi-commit-late-config-")
      armed.staged = () => append(`[filter "crypt"]\n\tclean = sh ${script}\n\trequired = true\n`)

      expect((await commit()).reason).toBe("held-back-config")
      await untouched()
    })

    // R5.1: present when the directory is built, gone before the second read.
    it("refuses a Git LFS extension present when the directory opens, even when it is gone after staging", async () => {
      const { config, armed, append, script, commit, untouched } = await heldBack("domovoi-commit-lfs-extension-")
      const before = await readFile(config, "utf8")
      armed.gate = () => append(`[lfs "extension.crypt"]\n\tclean = sh ${script}\n\tsmudge = sh ${script}\n\tpriority = 0\n`)
      armed.staged = () => writeFile(config, before)

      const error = await commit()

      expect(error.reason).toBe("held-back-config")
      expect(error.message).toContain("lfs.extension.crypt.clean")
      await untouched()
    })

    it("refuses a Git LFS custom transfer that appears after the gate", async () => {
      const { armed, append, script, commit, untouched } = await heldBack("domovoi-commit-lfs-transfer-")
      armed.gate = () => append(`[lfs "customtransfer.crypt"]\n\tpath = sh ${script}\n`)

      expect((await commit()).reason).toBe("held-back-config")
      await untouched()
    })

    // Fail closed: a key Domovoi has never classified refuses, named, so a
    // setting a later Git or git-lfs reads cannot slip past.
    it.each([
      ["a key Domovoi does not know", "[domovoi-test]\n\tunknown = 1\n", "domovoi-test.unknown"],
      ["a request to sign commits, which Domovoi does not do", "[commit]\n\tgpgsign = true\n", "commit.gpgsign"],
      // The key is shown as repository config text always is, redacted.
      ["a URL rewrite the directory does not carry", "[url \"https://mirror.invalid/\"]\n\tinsteadOf = https://example.invalid/\n", "url.https://mirror.invalid/"],
    ])("refuses %s, set from the start", async (_name, lines, key) => {
      const { append, commit, untouched } = await heldBack("domovoi-commit-unknown-key-")
      await append(lines)

      const error = await commit()

      expect(error.reason).toBe("held-back-config")
      expect(error.message).toContain(key)
      await untouched()
    })

    it("refuses a key that appears after the isolated directory staged", async () => {
      const { armed, append, commit, untouched } = await heldBack("domovoi-commit-late-key-")
      armed.staged = () => append("[domovoi-test]\n\tunknown = 1\n")

      expect((await commit()).reason).toBe("held-back-config")
      await untouched()
    })

    // T126b review R1.2: a repository override removed after staging falls
    // back to the person's global value, which the staging did not use.
    it("refuses when a repository override is removed after staging and the global value differs", async () => {
      const home = await mkdtemp(join(tmpdir(), "domovoi-commit-home-"))
      scratchDirectories.push(home)
      await writeFile(join(home, ".gitconfig"), "[core]\n\tautocrlf = true\n")
      vi.stubEnv("HOME", home)
      vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"))
      const { repositoryPath, workspace, sessionId, service, armed } = await heldBack("domovoi-commit-removed-override-")
      await git(repositoryPath, "config", "core.autocrlf", "false")
      await writeFile(join(workspace.path, "README.md"), "after\r\nwith crlf\r\n")
      armed.staged = async () => { await git(repositoryPath, "config", "--unset", "core.autocrlf") }

      const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

      expect(error.reason).toBe("held-back-config")
      expect(error.message).toContain("core.autocrlf")
      expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
    })

    // T126b review R1.1: Git reads core.sparseCheckout as a boolean, so "1"
    // turns it on; a file outside the patterns is never committed.
    it("keeps the sparse-checkout patterns when core.sparseCheckout is written as 1", async () => {
      const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-sparse-")
      await writeFile(join(workspace.path, "README.md"), "after\n")
      await writeFile(join(workspace.path, "new-outside.txt"), "outside\n")
      // Authorize the full set first, so this test still detects staging
      // outside sparse patterns rather than merely a digest mismatch.
      const shown = await service.evidence(workspace.path)
      await git(workspace.path, "sparse-checkout", "set", "--no-cone", "/README.md", "/old.txt", "/.gitignore")
      await git(workspace.path, "config", "--worktree", "core.sparseCheckout", "1")
      const head = await git(workspace.path, "rev-parse", "HEAD")

      await service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: head, expectedChangesDigest: shown.changesDigest! }).catch(() => undefined)

      expect(await git(workspace.path, "ls-tree", "-r", "--name-only", `domovoi/${sessionId}`)).not.toContain("new-outside.txt")
    })

    it("commits past dropped settings that change nothing a commit stores or runs", async () => {
      const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-inert-keys-")
      for (const [key, value] of [
        ["core.hooksPath", ".husky"], ["remote.origin.url", "ext::sh -c true"], ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ["branch.main.remote", "origin"], ["branch.main.merge", "refs/heads/main"], ["pull.rebase", "true"], ["gc.auto", "0"],
        ["user.name", "Dana Person"], ["user.email", "dana@example.invalid"], ["lfs.repositoryformatversion", "0"],
        ["lfs.https://example.invalid/repo.git/info/lfs.access", "basic"], ["gui.wmstate", "normal"],
      ] as const) await git(repositoryPath, "config", key, value)
      await writeFile(join(workspace.path, "README.md"), "after\n")

      const made = await service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: (await service.evidence(workspace.path)).changesDigest! })

      expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(made.commit)
    })
  })

  it("checks a secret-named submodule entry that the repository asks Git to ignore", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-ignored-submodule-")
    await writeFile(join(workspace.path, ".gitmodules"), "[submodule \"keys\"]\n\tpath = id_rsa\n\turl = ./keys\n\tignore = all\n")
    await git(workspace.path, "add", ".gitmodules")
    await git(workspace.path, "update-index", "--add", "--cacheinfo", `160000,${workspace.baseCommit},id_rsa`)
    // An unpopulated submodule: staging keeps its entry, and a plain diff,
    // told to ignore it, does not list it.
    await mkdir(join(workspace.path, "id_rsa"))
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("secret-paths")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  it.each([
    [".env", "API_KEY=1\n"],
    ["config/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\n"],
    ["deploy/server.pem", "-----BEGIN CERTIFICATE-----\n"],
  ])("refuses the whole commit when %s would enter it, and never names the file", async (path, contents) => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-secret-")
    await writeFile(join(workspace.path, "README.md"), "after\n")
    await mkdir(join(workspace.path, path, ".."), { recursive: true })
    await writeFile(join(workspace.path, path), contents)
    const indexBefore = await git(workspace.path, "ls-files", "--stage")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("secret-paths")
    expect(error.message).toContain("1 file")
    expect(error.message).not.toContain(path.split("/").at(-1)!)
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
    expect(await git(workspace.path, "ls-files", "--stage")).toBe(indexBefore)
    await expect(readFile(join(workspace.path, path), "utf8")).resolves.toBe(contents)
  })

  it("refuses a message that holds a secret, which would stay in the branch's history", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-secret-message-")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, {
      repositoryPath, sessionId, message: "chore: rotate\n\nNPM_TOKEN=message-secret-fixture", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}`,
    }))

    expect(error.reason).toBe("secret-message")
    expect(error.message).not.toContain("message-secret-fixture")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  // PR #883 review: a deleted path is checked as bytes too, so a path that is
  // not UTF-8 is refused rather than recorded under a replacement character.
  it("refuses deleting a tracked path that is not UTF-8", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-deleted-bytes-")
    const blob = spawnSync("git", ["-C", workspace.path, "hash-object", "-w", "--stdin"], { input: "bytes\n", encoding: "utf8" }).stdout.trim()
    // The entry exists in the index and HEAD only: no file name on disk, so
    // the test runs where the filesystem refuses such names.
    const name = Buffer.concat([Buffer.from("bad-"), Buffer.from([0xff]), Buffer.from(".txt")])
    const info = Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.from("\n")])
    const indexed = spawnSync("git", ["-C", workspace.path, "update-index", "--index-info"], { input: info })
    expect(indexed.status).toBe(0)
    await git(workspace.path, "commit", "-q", "-m", "track a name that is not UTF-8")
    const head = await git(workspace.path, "rev-parse", "HEAD")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: head, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("unreadable-paths")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(head)
  })

  it("lets a commit delete a secret file the branch already tracked", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-delete-secret-")
    await writeFile(join(workspace.path, ".env"), "API_KEY=1\n")
    await service.checkpoint(workspace.path, "tracked a secret")
    const head = await git(workspace.path, "rev-parse", "HEAD")
    await rm(join(workspace.path, ".env"))

    const made = await service.commit(workspace.path, { repositoryPath, sessionId, message: "chore: drop the env file", expectedHead: head, expectedChangesDigest: (await service.evidence(workspace.path)).changesDigest! })

    expect(made.changedFiles).toEqual([".env"])
    await expect(git(workspace.path, "show", `${made.commit}:.env`)).rejects.toThrow()
  })

  it("refuses when there is nothing to commit", async () => {
    const { repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-empty-")
    await writeFile(join(workspace.path, "ignored.log"), "ignored\n")

    const error = await refusal(service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: workspace.baseCommit, expectedChangesDigest: `sha256:${"0".repeat(64)}` }))

    expect(error.reason).toBe("nothing-to-commit")
    expect(await git(workspace.path, "rev-parse", `domovoi/${sessionId}`)).toBe(workspace.baseCommit)
  })

  it("never runs a hook the worktree or the repository sets", async () => {
    const { scratch, repositoryPath, service, workspace, sessionId } = await sessionWorktree("domovoi-commit-hooks-")
    await git(repositoryPath, "config", "core.hooksPath", ".githooks")
    const markerPath = join(scratch, "hook-ran").replaceAll("\\", "/")
    const hooks = join(workspace.path, ".githooks")
    await mkdir(hooks)
    await writeFile(join(hooks, "pre-commit"), `#!/bin/sh\necho "$(basename "$0")" >> "${markerPath}"\n`, { mode: 0o755 })
    for (const hook of ["prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction", "pre-push"]) {
      await link(join(hooks, "pre-commit"), join(hooks, hook))
    }
    // The control: Git itself runs them in this worktree.
    await git(workspace.path, "commit", "--allow-empty", "-q", "-m", "control")
    await expect(readFile(markerPath, "utf8")).resolves.toContain("pre-commit")
    await rm(markerPath)
    const head = await git(workspace.path, "rev-parse", "HEAD")
    await writeFile(join(workspace.path, "README.md"), "after\n")

    await service.commit(workspace.path, { repositoryPath, sessionId, message: "feat: x", expectedHead: head, expectedChangesDigest: (await service.evidence(workspace.path)).changesDigest! })

    await expect(readFile(markerPath, "utf8")).rejects.toThrow()
  })
})
