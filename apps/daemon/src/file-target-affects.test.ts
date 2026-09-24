import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fileTargetAffects } from "./file-target-affects.js"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

describe("fileTargetAffects", () => {
  it("names the file an edit reaches inside the worktree", async () => {
    const workspace = await directory("domovoi-affects-inside-")
    await mkdir(join(workspace, "two"))
    await symlink(join(workspace, "two"), join(workspace, "one"), "junction")
    await expect(fileTargetAffects({ workspace, path: join(workspace, "src", "a.ts") }))
      .resolves.toEqual({ text: "The file src/a.ts in the session worktree.", redacted: false, sensitive: false })
    await expect(fileTargetAffects({ workspace, path: "a.ts", cwd: join(workspace, "src") }))
      .resolves.toEqual({ text: "The file src/a.ts in the session worktree.", redacted: false, sensitive: false })
    await expect(fileTargetAffects({ workspace, path: join(workspace, "one", "file") }))
      .resolves.toEqual({ text: "The file two/file in the session worktree.", redacted: false, sensitive: false })
  })

  it("says when the file is outside the worktree, and the link that leads there", async () => {
    const workspace = await directory("domovoi-affects-link-")
    const outside = await directory("domovoi-affects-outside-")
    await symlink(outside, join(workspace, "out"), "junction")
    await expect(fileTargetAffects({ workspace, path: join(workspace, "out", "notes.txt") })).resolves.toEqual({
      text: `The file ${join(await realpath(outside), "notes.txt")}, outside the session worktree, through a link at out/notes.txt.`,
      redacted: false,
      sensitive: false,
    })
    const plain = resolve(outside, "..", "elsewhere.txt")
    await expect(fileTargetAffects({ workspace, path: plain }))
      .resolves.toEqual({ text: `The file ${plain}, outside the session worktree.`, redacted: false, sensitive: false })
  })

  it("hides a credential path and redacts a secret in any other", async () => {
    const workspace = await directory("domovoi-affects-secret-")
    await expect(fileTargetAffects({ workspace, path: join(workspace, ".env") }))
      .resolves.toEqual({ text: "The file [REDACTED] in the session worktree.", redacted: false, sensitive: true })
    await expect(fileTargetAffects({ workspace, path: join(workspace, "ghp_abcdefghijklmnop.txt") }))
      .resolves.toEqual({ text: "The file [REDACTED].txt in the session worktree.", redacted: true, sensitive: false })
  })

  // Ruled for #541 and applied here: a file hidden as [REDACTED] is a credential
  // file, so its card is a hard gate, whether the path names it or a link leads there.
  it("marks a credential file reached through a link with an ordinary name", async () => {
    const workspace = await directory("domovoi-affects-hidden-link-")
    await mkdir(join(workspace, ".ssh"))
    await symlink(join(workspace, ".ssh"), join(workspace, "cfg"), "junction")
    await expect(fileTargetAffects({ workspace, path: join(workspace, "cfg", "config") }))
      .resolves.toEqual({ text: "The file [REDACTED] in the session worktree.", redacted: false, sensitive: true })
  })

  it("keeps a path on one line and bounded", async () => {
    const workspace = await directory("domovoi-affects-shape-")
    await expect(fileTargetAffects({ workspace, path: join(workspace, "a\nNetwork: none\u202e") }))
      .resolves.toEqual({ text: "The file a\\nNetwork: none\\u202e in the session worktree.", redacted: false, sensitive: false })
    const long = await fileTargetAffects({ workspace, path: join(workspace, `${"a".repeat(600)}${"b".repeat(600)}.ts`) })
    expect(long.text).toMatch(/^The file a+…b+\.ts in the session worktree\.$/u)
    expect(long.text.length).toBe("The file  in the session worktree.".length + 512)
  })
})
