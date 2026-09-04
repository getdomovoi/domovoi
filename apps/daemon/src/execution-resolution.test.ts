import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { removeScratchDirectories } from "./test-scratch.js"
import { resolveExecution } from "./execution-resolution.js"

const scratch: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratch)
})

async function project(scripts?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-execution-"))
  scratch.push(root)
  if (scripts) await writeFile(join(root, "package.json"), JSON.stringify({ scripts }))
  return root
}

describe("resolveExecution", () => {
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

  it("records a contained file tool by workspace scope, not target path", async () => {
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
        coverage: "tool-and-workspace-scope",
        cwd: ".",
        tool: "Write",
        scope: "workspace",
      },
    })
  })

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
        coverage: "tool-and-workspace-scope",
        cwd: ".",
        tool: "Write",
        scope: "workspace",
      },
    })
  })

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

  it("rejects a missing command", async () => {
    const root = await project()
    await expect(resolveExecution({ workspaceRoot: root, cwd: root }))
      .resolves.toEqual({ state: "unresolved", reason: "command-missing" })
  })
})
