import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"

import { demoWorkspace, type Runtime } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { approvalDirectory, approvalFacts, resolveApprovalPath, unrestrictedApprovalScope } from "./approval-facts.js"
import { pathHider } from "./approval-path-text.js"
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
      hiddenPaths: [],
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

  // Credential names outside the ASCII word set, private keys with a suffix,
  // and the credential stores Codex refuses are hidden and hard-gated like any
  // other secret name, whether the path names them or a link leads to them.
  const credentialNames = ["clé.pem", "id_rsa_work", ".git-credentials", ".pgpass"]

  it.each(credentialNames)("hides and hard-gates a path that names %s", (name) => {
    const facts = approvalFacts({ workspace, cwd: join("/", "elsewhere", "project"), path: name, scope: undefined })
    expect({ affects: facts.affects, sensitive: facts.sensitive })
      .toEqual({ affects: "The file [REDACTED], outside the session worktree.", sensitive: true })
  })

  it.each(credentialNames)("hides and hard-gates a link with an ordinary name that leads to %s", async (name) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-facts-")))
    directories.push(root)
    const tree = join(root, "worktree")
    await mkdir(tree)
    await mkdir(join(root, "outside"))
    await writeFile(join(root, "outside", name), "")
    await symlink(join(root, "outside", name), join(tree, "plain"))
    const path = join(tree, "plain")
    const facts = approvalFacts({ workspace: tree, path, scope: undefined, resolved: await resolveApprovalPath(tree, path) })
    expect({ affects: facts.affects, sensitive: facts.sensitive }).toEqual({
      affects: "The file [REDACTED], outside the session worktree, through a link at [REDACTED].",
      sensitive: true,
    })
  })

  it("shows a link with an ordinary name that leads to an ordinary file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-facts-")))
    directories.push(root)
    const tree = join(root, "worktree")
    await mkdir(tree)
    await mkdir(join(root, "outside"))
    await writeFile(join(root, "outside", "notes.txt"), "")
    await symlink(join(root, "outside", "notes.txt"), join(tree, "plain"))
    const path = join(tree, "plain")
    const facts = approvalFacts({ workspace: tree, path, scope: undefined, resolved: await resolveApprovalPath(tree, path) })
    expect({ affects: facts.affects, sensitive: facts.sensitive }).toEqual({
      affects: `The file ${join(root, "outside", "notes.txt")}, outside the session worktree, through a link at plain.`,
      sensitive: false,
    })
  })

  // A store's location can hold ordinary files too: projects keep a .docker
  // directory, and session worktrees live under ~/.domovoi.
  it("does not mark an ordinary file under a credential store's directory name", () => {
    expect(approvalFacts({ workspace, path: ".docker/Dockerfile", scope: undefined }).sensitive).toBe(false)
    const home = join("/", "home", "u", ".domovoi", "worktrees", "session-1")
    expect(approvalFacts({ workspace: home, path: "src/index.ts", scope: undefined }).sensitive).toBe(false)
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

  // Every way a path can differ from where it really leads: ".." applied after
  // a link, a link that does not resolve yet, a request made from a
  // subdirectory, and a credential name that appears only at the real target.
  // Each row is classified against the worktree after following links in order.
  describe("follows the path the way the filesystem does", () => {
    type Row = {
      name: string
      cwd?: string
      path: string
      affects: (layout: { root: string; tree: string; outside: string }) => string
      sensitive: boolean
    }
    const rows: Row[] = [
      {
        name: "\"..\" after a link to an outside directory, reaching a private key",
        path: "jump/../notes.txt",
        affects: () => "The file [REDACTED], outside the session worktree, through a link at [REDACTED].",
        sensitive: true,
      },
      {
        name: "\"..\" with no link stays where it reads",
        path: "sub/../a.ts",
        affects: () => "The file a.ts in the session worktree.",
        sensitive: false,
      },
      {
        name: "a dangling link to an outside .env",
        path: "dangling",
        affects: () => "The file [REDACTED], outside the session worktree, through a link at [REDACTED].",
        sensitive: true,
      },
      {
        // Owner ruling (merge with #545): a file tool's card names the
        // resolved target, the file the edit really reaches.
        name: "a dangling link to a missing file inside the worktree",
        path: "later",
        affects: () => "The file not-yet.txt in the session worktree.",
        sensitive: false,
      },
      {
        name: "a relative path from a subdirectory, through a link there",
        cwd: "sub",
        path: "link-out/file.txt",
        affects: ({ outside }) => `The file ${join(outside, "file.txt")}, outside the session worktree, through a link at sub/link-out/file.txt.`,
        sensitive: false,
      },
      {
        name: "a relative path from a subdirectory, to an ordinary file",
        cwd: "sub",
        path: "a.ts",
        affects: () => "The file sub/a.ts in the session worktree.",
        sensitive: false,
      },
      {
        name: "an ordinary name whose real target inside the worktree is a .env",
        path: "config.txt",
        affects: () => "The file [REDACTED] in the session worktree.",
        sensitive: true,
      },
      {
        name: "an absolute path through a link, with a cwd that does not apply",
        cwd: "sub",
        path: "<tree>/jump/data.csv",
        affects: ({ outside }) => `The file ${join(outside, "deep", "data.csv")}, outside the session worktree, through a link at jump/data.csv.`,
        sensitive: false,
      },
    ]

    it.each(rows)("$name", async (row) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-table-")))
      directories.push(root)
      const tree = join(root, "worktree")
      const outside = join(root, "outside")
      await mkdir(join(tree, "sub"), { recursive: true })
      await mkdir(join(outside, "deep"), { recursive: true })
      // Decoys at the worktree root, so a path resolved against the wrong
      // directory lands on an ordinary file inside the worktree.
      await mkdir(join(tree, "link-out"))
      await writeFile(join(tree, "notes.txt"), "")
      await writeFile(join(outside, "id_rsa"), "")
      await symlink(join(outside, "id_rsa"), join(outside, "notes.txt"))
      await symlink(join(outside, "deep"), join(tree, "jump"))
      await symlink(join(outside, ".env"), join(tree, "dangling"))
      await symlink(join(tree, "not-yet.txt"), join(tree, "later"))
      await symlink(outside, join(tree, "sub", "link-out"))
      await writeFile(join(tree, ".env"), "")
      await symlink(join(tree, ".env"), join(tree, "config.txt"))

      const cwd = row.cwd === undefined ? undefined : join(tree, row.cwd)
      const path = row.path.replace("<tree>", tree)
      const resolved = await resolveApprovalPath(tree, path, cwd)
      const facts = approvalFacts({ workspace: tree, ...(cwd === undefined ? {} : { cwd }), path, scope: undefined, resolved })
      expect({ affects: facts.affects, sensitive: facts.sensitive })
        .toEqual({ affects: row.affects({ root, tree, outside }), sensitive: row.sensitive })
    })
  })

  // The directory a request runs in is persisted and sent like the file path,
  // so a credential store there is hidden whole and keeps its location.
  describe("approvalDirectory", () => {
    it.each([
      { directory: "/home/u/.aws", text: "[REDACTED], outside the session worktree" },
      { directory: "/home/u/.aws/", text: "[REDACTED], outside the session worktree" },
      { directory: "/home/u/.ssh/keys", text: "[REDACTED], outside the session worktree" },
      { directory: "/home/u/.docker", text: "[REDACTED], outside the session worktree" },
      { directory: "/home/u/.conﬁg/gh", text: "[REDACTED], outside the session worktree" },
      { directory: join(workspace, ".aws"), text: "[REDACTED] in the session worktree" },
    ])("hides and hard-gates $directory", ({ directory, text }) => {
      expect(approvalDirectory({ directory, workspace })).toEqual({ text, redacted: false, sensitive: true })
    })

    it.each([workspace, join(workspace, "src"), "/home/u/.docker/project", "/home/u/.domovoi/worktrees/x"])(
      "shows the ordinary directory %s as it is",
      (directory) => {
        expect(approvalDirectory({ directory, workspace })).toEqual({ text: directory, redacted: false, sensitive: false })
      },
    )

    it("redacts a secret in the directory like any other text", () => {
      const token = `ghp_${"a1B2".repeat(9)}`
      const shown = approvalDirectory({ directory: `/tmp/${token}`, workspace })
      expect(shown.text).not.toContain(token)
      expect(shown.redacted).toBe(true)
    })
  })

  it("gives no resolved path for links that loop, so the path reads as written", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-approval-loop-")))
    directories.push(root)
    const tree = join(root, "worktree")
    await mkdir(tree)
    await symlink(join(tree, "b"), join(tree, "a"))
    await symlink(join(tree, "a"), join(tree, "b"))
    expect(await resolveApprovalPath(tree, "a/file.txt")).toBeUndefined()
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

    // Owner ruling (merge with #545): a link that stays inside names the
    // resolved target, the file the edit really reaches.
    const within = join(tree, "link-to-src", "index.ts")
    expect(approvalFacts({ workspace: tree, path: within, scope: undefined, resolved: await resolveApprovalPath(tree, within) }).affects)
      .toBe("The file src/index.ts in the session worktree.")
  })

  // Round 12: a hidden file under a subdirectory, requested from a nested
  // directory, stayed in the card's text when named relative to the worktree.
  // Every depth of file and every place the request can run from, as given
  // and through a link, with the worktree itself as given and at its real
  // path. Only the exact hidden path is replaced.
  it("hides a hidden file however the card's text writes it from the request's directory or the worktree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "domovoi-approval-forms-"))
    directories.push(workspace)
    const real = await realpath(workspace)
    for (const path of ["src/app", "src/lib", "lib"]) await mkdir(join(workspace, ...path.split("/")), { recursive: true })
    for (const file of [".env", "src/.env", "src/app/.env"]) await writeFile(join(workspace, ...file.split("/")), "")
    await symlink(join(workspace, "src"), join(workspace, "via"), "junction")
    const slashed = (path: string) => path.split(sep).join("/")
    const cases = [
      { file: ".env", cwds: [".", "lib", ".."] },
      { file: "src/.env", cwds: [".", "src", "lib", "via"] },
      { file: "src/app/.env", cwds: [".", "src/app", "src/lib", "src", "via/app", "via"] },
    ]
    const missed: string[] = []
    for (const { file, cwds } of cases) {
      const given = join(workspace, ...file.split("/"))
      const lies = join(real, ...file.split("/"))
      for (const cwd of cwds) {
        const cwdGiven = resolve(workspace, cwd)
        const cwdLies = await realpath(cwdGiven)
        const relatives = [...new Set([file, slashed(relative(cwdGiven, given)), slashed(relative(cwdLies, lies))])]
        const written = [
          given,
          lies,
          ...relatives.flatMap((path) => {
            const backslashed = path.split("/").join("\\")
            return [path, `./${path}`, backslashed, `.\\${backslashed}`]
          }),
        ]
        const text = `Edit ${written.join(", ")}; leave .env.example, .envrc and src/index.ts alone`
        const expected = `Edit ${written.map(() => "[REDACTED]").join(", ")}; leave .env.example, .envrc and src/index.ts alone`
        for (const [shape, request] of Object.entries({
          "absolute path, absolute cwd": { path: given, cwd: cwdGiven },
          "absolute path, relative cwd": { path: given, cwd },
          "relative path, absolute cwd": { path: relative(cwdGiven, given), cwd: cwdGiven },
          "relative path, relative cwd": { path: relative(cwdGiven, given), cwd },
        })) {
          const resolved = await resolveApprovalPath(workspace, request.path, request.cwd)
          const facts = approvalFacts({ workspace, ...request, scope: undefined, resolved })
          const shownText = pathHider(facts.hiddenPaths).hide(text)
          if (!facts.sensitive || shownText !== expected) {
            missed.push(`${file} from ${cwd} (${shape}): ${shownText.split(real).join("<real>").split(workspace).join("<worktree>")}`)
          }
        }
      }
    }
    expect(missed).toEqual([])
  })
})
