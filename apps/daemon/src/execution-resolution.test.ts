import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import { link, mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"
import { resolveExecution } from "./execution-resolution.js"
import { OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"

const scratch: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await removeScratchDirectories(scratch)
})

describe("resolveExecution under a deadline", () => {
  it("ends every filesystem lookup at the request's deadline", async () => {
    const root = await project({ test: "vitest run" })
    vi.useFakeTimers()
    vi.spyOn(fs.realpath, "native").mockImplementation((() => {}) as never)
    const deadline = OperationDeadline.start(2_000)
    const resolution = resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm test", deadline })
    const settled = resolution.then(() => "resolved", (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await settled).toBeInstanceOf(OperationDeadlineExceededError)
  })

  it("reads a relative directory through a link before its '..'", async () => {
    const root = await realpath(await project())
    await mkdir(join(root, "packages", "deep"), { recursive: true })
    await symlink(join(root, "packages", "deep"), join(root, "deep-link"))
    expect(await resolveExecution({ workspaceRoot: root, cwd: `deep-link${sep}..`, command: "git status" }))
      .toMatchObject({ state: "resolved", record: { cwd: "packages" } })
  })
})

async function project(scripts?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-execution-"))
  scratch.push(root)
  if (scripts) await writeFile(join(root, "package.json"), JSON.stringify({ scripts }))
  return root
}

describe("resolveExecution", () => {
  it("never gives a provider tool whose input names a file tool that file tool's record", async () => {
    const root = await project()
    await mkdir(join(root, "src"))
    const filePath = join(root, "src", "index.ts")
    const edit = await resolveExecution({ workspaceRoot: root, cwd: root, command: "Edit", filePath })
    expect(edit.state).toBe("resolved")

    await expect(resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "Edit",
      filePath,
      tool: "mcp__github__create_issue",
    })).resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
  })

  it("normalizes literal argv while preserving command operators", async () => {
    const root = await project()
    const first = await resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "git   status && echo 'tests passed'",
    })
    const second = await resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: 'git status&&echo "tests passed"',
    })

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      state: "resolved",
      record: {
        version: 1,
        coverage: "command-and-script-text",
        cwd: ".",
        kind: "shell",
        entries: [{
          id: 0,
          source: { kind: "request" },
          parts: [
            { operator: null, argv: ["git", "status"], expandsTo: [] },
            { operator: "&&", argv: ["echo", "tests passed"], expandsTo: [] },
          ],
        }],
      },
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    })
  })

  it("binds the digest to canonical project-relative cwd", async () => {
    const root = await project()
    const nested = join(root, "packages", "api")
    await mkdir(nested, { recursive: true })
    const rootExecution = await resolveExecution({ workspaceRoot: root, cwd: root, command: "pwd" })
    const nestedExecution = await resolveExecution({ workspaceRoot: root, cwd: nested, command: "pwd" })

    expect(rootExecution).toMatchObject({ state: "resolved", record: { cwd: "." } })
    expect(nestedExecution).toMatchObject({ state: "resolved", record: { cwd: "packages/api" } })
    expect(rootExecution).not.toMatchObject({ digest: (nestedExecution as { digest?: string }).digest })
  })

  it("rejects a cwd whose real path leaves the worktree", async () => {
    const root = await project()
    const outside = await project()
    await symlink(outside, join(root, "outside"))

    await expect(resolveExecution({
      workspaceRoot: root,
      cwd: join(root, "outside"),
      command: "pwd",
    })).resolves.toEqual({ state: "unresolved", reason: "cwd-outside-project" })
  })

  it("expands lifecycle hooks and recursively called scripts", async () => {
    const root = await project({
      pretest: "eslint .",
      test: "pnpm run unit",
      unit: "vitest run",
      posttest: "node cleanup.js",
    })
    const resolution = await resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "pnpm test -- --reporter=dot",
    })

    expect(resolution).toMatchObject({
      state: "resolved",
      record: {
        kind: "shell",
        entries: [
          {
            id: 0,
            source: { kind: "request" },
            parts: [{
              argv: ["pnpm", "run", "test", "--", "--reporter=dot"],
              expandsTo: [1, 2, 4],
            }],
          },
          { id: 1, source: { name: "pretest", phase: "pre", arguments: [] } },
          { id: 2, source: { name: "test", phase: "main", arguments: ["--reporter=dot"] } },
          { id: 3, source: { name: "unit", phase: "main", arguments: ["--reporter=dot"] } },
          { id: 4, source: { name: "posttest", phase: "post", arguments: [] } },
        ],
      },
    })
  })

  it("changes the digest when a script or lifecycle hook changes", async () => {
    const root = await project({ test: "vitest run" })
    const before = await resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm test" })
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { pretest: "eslint .", test: "vitest run" },
    }))
    const hookAdded = await resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm test" })
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { pretest: "eslint .", test: "vitest run --coverage" },
    }))
    const bodyChanged = await resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm test" })

    expect(hookAdded).not.toMatchObject({ digest: (before as { digest?: string }).digest })
    expect(bodyChanged).not.toMatchObject({ digest: (hookAdded as { digest?: string }).digest })
  })

  it("normalizes package script shortcuts to the explicit run form", async () => {
    const root = await project({ test: "vitest run" })
    const shortcut = await resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm test" })
    const explicit = await resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm run test" })

    expect(shortcut).toEqual(explicit)
  })

  it.each([
    ["a missing script", { test: "pnpm run missing" }, undefined],
    ["a recursive script cycle", { test: "pnpm run unit", unit: "pnpm test" }, undefined],
    ["unsupported package-manager arguments", { test: "vitest run" }, "pnpm --filter api test"],
  ] as const)("leaves %s unresolved", async (_label, scripts, requestedCommand) => {
    const root = await project({ ...scripts })
    const command: string = requestedCommand ?? "pnpm test"
    await expect(resolveExecution({ workspaceRoot: root, cwd: root, command }))
      .resolves.toEqual({ state: "unresolved", reason: "package-script-unresolved" })
  })

  it.each([
    "echo $HOME",
    "echo *.ts",
    "pnpm test > result.txt",
    "node $(find-script)",
    "cd packages/api && pnpm test",
  ])("rejects unsupported shell semantics in %s", async (command) => {
    const root = await project({ test: "vitest run" })
    await expect(resolveExecution({ workspaceRoot: root, cwd: root, command }))
      .resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
  })

  it("makes a compound command unresolved when any one part is unresolved", async () => {
    const root = await project({ test: "vitest run" })
    await expect(resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "pnpm test && echo $HOME",
    })).resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
  })

  it("does not persist an execution record containing a detected secret", async () => {
    const root = await project({ test: "vitest run --api-key secret-value" })
    await expect(resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm test" }))
      .resolves.toEqual({ state: "unresolved", reason: "sensitive-content" })
  })

  it("records a contained file tool by its target file", async () => {
    const root = await project()
    const target = join(root, "src", "new-file.ts")
    await mkdir(join(root, "src"))
    await expect(resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "Write",
      filePath: target,
    })).resolves.toMatchObject({
      state: "resolved",
      record: {
        kind: "workspace-file-tool",
        coverage: "tool-and-file",
        cwd: ".",
        tool: "Write",
        scope: "file",
        path: "src/new-file.ts",
      },
    })
  })

  it("gives each target file its own digest, so a rule for one edit covers no other file", async () => {
    const root = await project()
    const digest = async (filePath: string) => {
      const execution = await resolveExecution({ workspaceRoot: root, cwd: root, command: "Edit", filePath })
      return execution.state === "resolved" ? execution.digest : undefined
    }
    const source = await digest(join(root, "src", "index.ts"))
    expect(source).toBeDefined()
    expect(await digest(join(root, "package.json"))).not.toBe(source)
    expect(await digest(join(root, "vitest.config.ts"))).not.toBe(source)
    expect(await digest(join(root, "src", "index.ts"))).toBe(source)
  })

  it("leaves a file target with more than one link unresolved, since its other names reach the same bytes", async () => {
    const root = await project()
    const outside = await project()
    await mkdir(join(root, "src"))
    await writeFile(join(outside, "credentials.json"), "{}")
    await link(join(outside, "credentials.json"), join(root, "src", "settings.json"))

    for (const command of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      await expect(resolveExecution({
        workspaceRoot: root,
        cwd: root,
        command,
        filePath: join(root, "src", "settings.json"),
      })).resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
    }
  })

  // A directory at the path keeps the path, so a record would keep its digest,
  // while the edit no longer reaches the file the card named.
  it("leaves an existing file target that is a directory unresolved", async () => {
    const root = await project()
    await mkdir(join(root, "src", "settings.json"), { recursive: true })

    for (const command of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      await expect(resolveExecution({
        workspaceRoot: root,
        cwd: root,
        command,
        filePath: join(root, "src", "settings.json"),
      })).resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
    }
  })

  // Windows has no named pipe in the file tree, so there is nothing to make.
  it.skipIf(process.platform === "win32")("leaves an existing file target that is a FIFO unresolved, without opening it", async () => {
    const root = await project()
    await mkdir(join(root, "src"))
    // Opening a FIFO with no writer blocks, so a resolver that read it would
    // time this test out rather than answer.
    execFileSync("mkfifo", [join(root, "src", "settings.json")])

    for (const command of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      await expect(resolveExecution({
        workspaceRoot: root,
        cwd: root,
        command,
        filePath: join(root, "src", "settings.json"),
      })).resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
    }
  })

  it("still resolves an existing file target that has a single link", async () => {
    const root = await project()
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "settings.json"), "{}")

    await expect(resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "Edit",
      filePath: join(root, "src", "settings.json"),
    })).resolves.toMatchObject({
      state: "resolved",
      record: { kind: "workspace-file-tool", scope: "file", path: "src/settings.json" },
    })
  })

  it.each(["WebFetch", "WebSearch", "mcp__github__create_issue", "Task"])(
    "never fingerprints the provider tool %s, whose effect lives in inputs the record cannot hold",
    async (tool) => {
      const root = await project()
      await expect(resolveExecution({ workspaceRoot: root, cwd: root, command: tool, tool }))
        .resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
    },
  )

  it("accepts a contained file target addressed through the worktree alias", async () => {
    const root = await project()
    const aliasParent = await project()
    const alias = join(aliasParent, "worktree-alias")
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir")
    await mkdir(join(root, "src"))

    await expect(resolveExecution({
      workspaceRoot: alias,
      cwd: alias,
      command: "Write",
      filePath: join(alias, "src", "new-file.ts"),
    })).resolves.toMatchObject({
      state: "resolved",
      record: {
        kind: "workspace-file-tool",
        coverage: "tool-and-file",
        cwd: ".",
        tool: "Write",
        scope: "file",
        path: "src/new-file.ts",
      },
    })
  })

  // A file tool aimed at the worktree root itself names no file, so it has no
  // file-scoped record. It stays unresolved, which still raises a card and
  // gives no standing rule, rather than throwing and leaving the request open.
  it.each(["Edit", "Write", "MultiEdit", "NotebookEdit"])("leaves a %s aimed at the worktree root unresolved", async (command) => {
    const root = await project()
    for (const filePath of [root, `${root}/`, join(root, "."), join(root, "src", "..")]) {
      await expect(resolveExecution({ workspaceRoot: root, cwd: root, command, filePath }), filePath)
        .resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
    }
  })

  // The target is read the way the filesystem reads it: each link is followed
  // before the ".." after it applies, a dangling link leads where it points,
  // and a relative path starts at the request's cwd. Every link here is a
  // directory link, made as a junction, which Windows creates without admin
  // rights (ruled 2026-09-24), so the table runs on every platform. A dangling
  // link points at a directory that does not exist yet.
  it.each([
    ["a link then .. leaving the worktree", "link/../src/index.ts", ".", undefined],
    ["the same from a cwd subdirectory", "../link/../src/index.ts", "sub", undefined],
    ["a link in a cwd subdirectory then ..", "sublink/../src/index.ts", "sub", undefined],
    ["a dangling link pointing outside", "dangling-out", ".", undefined],
    ["a dangling link pointing inside", "dangling-in", ".", "src/soon"],
    ["a relative path from a cwd subdirectory", "../src/index.ts", "sub", "src/index.ts"],
    ["a link inside the worktree then ..", "inner/../src/index.ts", ".", "deep/src/index.ts"],
  ] as const)("resolves the edit target through %s", async (_label, filePath, cwd, expected) => {
    const root = await project()
    const outside = await project()
    await mkdir(join(root, "src"))
    await mkdir(join(root, "sub"))
    await mkdir(join(root, "deep", "inner"), { recursive: true })
    await mkdir(join(outside, "nested"))
    await symlink(join(outside, "nested"), join(root, "link"), "junction")
    await symlink(join(outside, "nested"), join(root, "sub", "sublink"), "junction")
    await symlink(join(outside, "missing"), join(root, "dangling-out"), "junction")
    await symlink(join(root, "src", "soon"), join(root, "dangling-in"), "junction")
    await symlink(join(root, "deep", "inner"), join(root, "inner"), "junction")
    await mkdir(join(root, "deep", "src"))
    const execution = await resolveExecution({
      workspaceRoot: root,
      cwd: join(root, cwd),
      command: "Edit",
      filePath,
    })
    if (expected === undefined) expect(execution).toEqual({ state: "unresolved", reason: "cwd-outside-project" })
    else expect(execution).toMatchObject({ state: "resolved", record: { path: expected } })
  })

  // Windows has no FIFO a path can name, so this one stays POSIX only (ruled
  // 2026-09-24).
  it.runIf(process.platform !== "win32")("never hangs on a package.json that is not a regular file, and leaves the run unresolved", async () => {
    const root = await project()
    execFileSync("mkfifo", [join(root, "package.json")])
    const started = Date.now()
    const execution = await resolveExecution({ workspaceRoot: root, cwd: root, command: "pnpm test" })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(execution.state).toBe("unresolved")
  }, 10_000)

  it("rejects blocked, missing, and outside-worktree file targets", async () => {
    const root = await project()
    const outside = await project()
    await expect(resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "Edit",
      filePath: join(outside, "file.ts"),
    })).resolves.toEqual({ state: "unresolved", reason: "cwd-outside-project" })
    await expect(resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "Edit",
    })).resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
    await expect(resolveExecution({
      workspaceRoot: root,
      cwd: root,
      command: "Edit",
      filePath: join(root, "file.ts"),
      blockedPath: join(root, "file.ts"),
    })).resolves.toEqual({ state: "unresolved", reason: "unsupported-syntax" })
  })

  // Ruled by fetzy 2026-09-23: Claude's Read, Glob, Grep and Task never get a
  // standing rule. The Claude adapter names them as provider tools, so each one
  // stays unresolved wherever it points and asks every time.
  it.each(["Read", "Glob", "Grep", "Task"])("never fingerprints Claude's %s, inside or outside the worktree", async (tool) => {
    const root = await project()
    const outside = await project()
    for (const filePath of [join(root, "src", "index.ts"), join(outside, "credentials"), undefined]) {
      await expect(resolveExecution({
        workspaceRoot: root, cwd: root, command: tool, tool, ...(filePath === undefined ? {} : { filePath }),
      }), String(filePath)).resolves.toMatchObject({ state: "unresolved" })
    }
  })

  it.each(["Read", "Glob", "Grep", "LS", "NotebookRead"])(
    "never fingerprints a %s outside the worktree, so no standing rule can cover it",
    async (command) => {
      const root = await project()
      const outside = await project()
      await expect(resolveExecution({
        workspaceRoot: root,
        cwd: root,
        command,
        filePath: join(outside, "credentials"),
      })).resolves.toEqual({ state: "unresolved", reason: "cwd-outside-project" })
    },
  )

  it("rejects a missing command", async () => {
    const root = await project()
    await expect(resolveExecution({ workspaceRoot: root, cwd: root }))
      .resolves.toEqual({ state: "unresolved", reason: "command-missing" })
  })
})
