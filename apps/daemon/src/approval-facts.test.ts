import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { demoWorkspace, type Runtime } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { approvalFacts, resolveApprovalPath, unrestrictedApprovalScope } from "./approval-facts.js"
import { codexApprovalScope } from "./codex.js"

const workspace = join("/", "worktrees", "session-1")

function runtime(permissionMode: Runtime["permissionMode"]): Runtime {
  return { ...structuredClone(demoWorkspace.sessions[0]!.runtime), provider: "codex", permissionMode, auto: false }
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("approvalFacts", () => {
  it("says a command from an unsandboxed provider can reach the machine and its network", () => {
    expect(approvalFacts({ workspace, scope: undefined })).toEqual({
      affects: unrestrictedApprovalScope.command,
      network: unrestrictedApprovalScope.network,
      redacted: false,
      sensitive: false,
    })
    expect(unrestrictedApprovalScope.network).not.toMatch(/no .*network/i)
  })

  it("names the file a file request is about, and says when it is outside the worktree", () => {
    expect(approvalFacts({ workspace, path: join(workspace, "src", "index.ts"), scope: undefined }).affects)
      .toBe("The file src/index.ts in the session worktree.")
    expect(approvalFacts({ workspace, path: join("/", "etc", "hosts"), scope: undefined }).affects)
      .toBe(`The file ${resolve(join("/", "etc", "hosts"))}, outside the session worktree.`)
  })

  // Codex's sandbox reads the whole disk in every mode; only Build writes, and
  // only in the worktree. The card says which sandbox this mode runs in.
  it("states the Codex sandbox the session's mode runs in, word for word", () => {
    const readOnly = "Reads anything this user account can read except credential stores and secret files, and writes nothing while the command runs in the Codex sandbox. A request to run outside the sandbox can reach anything this user account can."
    const build = "Writes only in the session worktree and reads anything this user account can read except credential stores and secret files while the command runs in the Codex sandbox. A request to run outside the sandbox can reach anything this user account can."
    const network = "None inside the Codex sandbox. A request to run outside the sandbox has this machine's network access."
    expect(codexApprovalScope(runtime("ask"))).toEqual({ command: readOnly, network })
    expect(codexApprovalScope(runtime("plan"))).toEqual({ command: readOnly, network })
    expect(codexApprovalScope(runtime("build"))).toEqual({ command: build, network })
    expect(codexApprovalScope({ ...runtime("build"), auto: true })).toEqual({ command: build, network })
  })

  // The card is persisted and sent to phones. A path is the agent's text, so
  // it is redacted like the command, and a secret in it makes the gate hard.
  it("redacts a secret in the path and reports that it did", () => {
    const token = `ghp_${"a1B2".repeat(9)}`
    const facts = approvalFacts({ workspace, path: `/tmp/${token}/x`, scope: undefined })
    expect(facts.affects).not.toContain(token)
    expect(facts.affects).toContain("[REDACTED]")
    expect(facts.redacted).toBe(true)
  })

  it("shows control characters in the path as escapes, so a path cannot add a line to the card", () => {
    const facts = approvalFacts({ workspace, path: "a\nNetwork: none\r\t\u0007\u202e", scope: undefined })
    expect(facts.affects).not.toMatch(/[\p{Cc}\u202e]/u)
    expect(facts.affects).toBe("The file a\\nNetwork: none\\r\\t\\u0007\\u202e in the session worktree.")
    expect(facts.redacted).toBe(false)
  })

  it("shortens a long path in the middle", () => {
    const long = `${"a".repeat(600)}/${"b".repeat(600)}.ts`
    const facts = approvalFacts({ workspace, path: long, scope: undefined })
    expect(facts.affects.length).toBeLessThanOrEqual("The file  in the session worktree.".length + 512)
    expect(facts.affects).toMatch(/^The file a+…b+\.ts in the session worktree\.$/u)
  })

  // A request about a credential file is a hard gate, whether the name is in
  // the path the agent gave or in where that path really leads.
  it.each([".env", "config/.env.production", "../other/.npmrc", "/home/u/.ssh/id_rsa", "certs/server.pem", "/home/u/.aws/credentials"])(
    "marks a sensitive file named by the path: %s",
    (path) => {
      expect(approvalFacts({ workspace, path, scope: undefined }).sensitive).toBe(true)
    },
  )

  // The whole path is hidden, and the line keeps where the file is.
  it("hides a sensitive path whole and keeps its location", () => {
    expect(approvalFacts({ workspace, path: "config/.env.production", scope: undefined }).affects)
      .toBe("The file [REDACTED] in the session worktree.")
    expect(approvalFacts({ workspace, path: "/home/u/.ssh/id_rsa", scope: undefined }).affects)
      .toBe("The file [REDACTED], outside the session worktree.")
  })

  it("does not mark an ordinary file as sensitive", () => {
    expect(approvalFacts({ workspace, path: "src/environment.ts", scope: undefined }).sensitive).toBe(false)
    expect(approvalFacts({ workspace, scope: undefined }).sensitive).toBe(false)
  })

  it("marks a sensitive file reached through a link with an ordinary name", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-facts-")))
    directories.push(root)
    const tree = join(root, "worktree")
    await mkdir(tree)
    await mkdir(join(root, "keys"))
    await writeFile(join(root, "keys", "id_rsa"), "")
    await symlink(join(root, "keys", "id_rsa"), join(tree, "notes.txt"))
    const path = join(tree, "notes.txt")
    const facts = approvalFacts({ workspace: tree, path, scope: undefined, resolved: await resolveApprovalPath(tree, path) })
    expect(facts.sensitive).toBe(true)
    expect(facts.affects).toBe("The file [REDACTED], outside the session worktree, through a link at [REDACTED].")
    expect(facts.affects).not.toContain("notes.txt")
  })

  // A write can name directories that do not exist yet. Where it lands is
  // decided by the nearest ancestor that does exist, which may be a link out.
  it("follows a link out of the worktree even when the rest of the path does not exist yet", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-facts-")))
    directories.push(root)
    const tree = join(root, "worktree")
    const outside = join(root, "outside")
    await mkdir(tree)
    await mkdir(outside)
    await symlink(outside, join(tree, "link"))
    const path = join(tree, "link", "new", "nested", "file.txt")
    expect(approvalFacts({ workspace: tree, path, scope: undefined, resolved: await resolveApprovalPath(tree, path) }).affects)
      .toBe(`The file ${join(outside, "new", "nested", "file.txt")}, outside the session worktree, through a link at link/new/nested/file.txt.`)
  })

  // Inside or outside is decided on the real path, so a link in the worktree
  // that leads out of it does not read as "in the session worktree".
  it("names where a link out of the worktree really leads", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-facts-")))
    directories.push(root)
    const tree = join(root, "worktree")
    const outside = join(root, "etc")
    await mkdir(join(tree, "src"), { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, "hosts"), "")
    await symlink(outside, join(tree, "link-to-etc"))
    await symlink(join(tree, "src"), join(tree, "link-to-src"))

    const out = join(tree, "link-to-etc", "hosts")
    expect(approvalFacts({ workspace: tree, path: out, scope: undefined, resolved: await resolveApprovalPath(tree, out) }).affects)
      .toBe(`The file ${join(outside, "hosts")}, outside the session worktree, through a link at link-to-etc/hosts.`)

    const within = join(tree, "link-to-src", "index.ts")
    expect(approvalFacts({ workspace: tree, path: within, scope: undefined, resolved: await resolveApprovalPath(tree, within) }).affects)
      .toBe("The file link-to-src/index.ts in the session worktree.")
  })
})
