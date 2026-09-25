import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { fileTargetAffects, hiddenPathForms, hidePaths } from "./file-target-affects.js"

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

describe("hidePaths", () => {
  it("replaces each form of a hidden path where it stands whole, and nothing else", async () => {
    const workspace = await directory("domovoi-hide-paths-")
    const real = await realpath(workspace)
    await mkdir(join(workspace, ".ssh"))
    await symlink(join(workspace, ".ssh"), join(workspace, "cfg"), "junction")
    const forms = await hiddenPathForms({ workspace, path: join(workspace, "cfg", "config") })
    expect(forms).toEqual(expect.arrayContaining([
      join(workspace, "cfg", "config"),
      "cfg/config",
      join(real, ".ssh", "config"),
      ".ssh/config",
      join(workspace, ".ssh", "config"),
    ]))
    expect(hidePaths(
      `open ${join(workspace, "cfg", "config")}, cfg/config, ~/.ssh/config and ${join(workspace, ".ssh", "config")}`,
      forms,
    )).toBe("open [REDACTED], [REDACTED], ~/[REDACTED] and [REDACTED]")
    // A longer name that only starts or ends with the path is another file.
    expect(hidePaths("cfg/config.bak, xcfg/config, cfg/config2 and cfg/config.", forms))
      .toBe("cfg/config.bak, xcfg/config, cfg/config2 and [REDACTED].")
    const env = await hiddenPathForms({ workspace, path: ".env", cwd: workspace })
    expect(hidePaths("cp .env.example .env; source .env", env)).toBe("cp .env.example [REDACTED]; source [REDACTED]")
    // A hidden directory is replaced where the path continues below it.
    const directoryForms = await hiddenPathForms({ workspace, path: join(workspace, ".ssh") })
    expect(hidePaths(`ls ${join(workspace, ".ssh")}/keys .ssh/known_hosts .sshrc`, directoryForms))
      .toBe("ls [REDACTED]/keys [REDACTED]/known_hosts .sshrc")
    expect(hidePaths("nothing hidden", [])).toBe("nothing hidden")
  })

  // Round 10: a hidden file under a subdirectory, named from the request's
  // directory, was left in the card's text. Every depth of file and every
  // place the request can run from, as given and through a link.
  it("replaces a hidden file however it is written from the request's directory or the worktree", async () => {
    const workspace = await directory("domovoi-hide-forms-")
    const real = await realpath(workspace)
    for (const path of ["src/app", "src/lib", "lib"]) await mkdir(join(workspace, ...path.split("/")), { recursive: true })
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
          "relative path, relative cwd": { path: relative(cwdGiven, given), cwd },
        })) {
          const shownText = hidePaths(text, await hiddenPathForms({ workspace, ...request }))
          if (shownText !== expected) {
            missed.push(`${file} from ${cwd} (${shape}): ${shownText.split(real).join("<real>").split(workspace).join("<worktree>")}`)
          }
        }
      }
    }
    expect(missed).toEqual([])
  })
})
