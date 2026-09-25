import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

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

  // Final check after fc428aba: the hide decision judges every spelling the
  // walk produces, as #541 does (sensitive when the requested path, any hop,
  // or the final target names a credential path). Each row names one in a
  // single place only and leads to a public file; each must be hidden whole,
  // with every hop hidden in the text. The controls name one nowhere.
  it("hides a file whose requested path, any hop or final target names a credential path", async () => {
    const workspace = await directory("domovoi-affects-hop-secret-")
    const at = (...parts: string[]) => join(workspace, ...parts)
    const written = (...parts: string[]) => parts.join(sep)
    for (const row of ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "c1", "c2"]) await mkdir(at(row))
    for (const row of ["r1", "r2", "r3", "r4", "c1"]) await writeFile(at(row, "public.txt"), "hello")
    for (const folder of [["r4", ".ssh"], ["r5", ".ssh"], ["r6", ".aws"], ["r7", "public"], ["c2", "real"]]) await mkdir(at(...folder))
    // File links are plain symlinks; directory links are junctions, which
    // Windows makes without admin rights and writes with an absolute target.
    const links: Array<[target: string, link: string[], type?: "junction"]> = [
      ["public.txt", ["r1", ".env"]],
      ["public.txt", ["r2", ".env"]],
      [".env", ["r2", "alias"]],
      ["public.txt", ["r3", ".env"]],
      [".env", ["r3", "b"]],
      ["b", ["r3", "a"]],
      [written(".ssh", "..", "public.txt"), ["r4", "c"]],
      ["c", ["r4", "b"]],
      ["b", ["r4", "a"]],
      [at("r5", ".ssh"), ["r5", "data"], "junction"],
      [at("r6", ".aws"), ["r6", "y"], "junction"],
      ["y", ["r6", "x"], "junction"],
      ["public", ["r7", ".ssh"], "junction"],
      [at("r7", ".ssh"), ["r7", "p"], "junction"],
      ["public.txt", ["c1", "b"]],
      ["b", ["c1", "a"]],
      ["real", ["c2", "z"], "junction"],
      [at("c2", "z"), ["c2", "y"], "junction"],
      ["y", ["c2", "x"], "junction"],
    ]
    for (const [target, link, type] of links) await symlink(target, at(...link), type)
    // The path a link leads to, as the link writes it, with the rest after it.
    const through = async (link: string[], rest: string[]) => {
      const target = await readlink(at(...link))
      const base = isAbsolute(target) ? target : `${dirname(at(...link))}${sep}${target}`
      return rest.length === 0 ? base : `${base}${sep}${rest.join(sep)}`
    }
    const rows: Array<{ label: string; path: string[]; hops: Array<[link: string[], rest: string[]]> }> = [
      { label: "requested path, 1 link", path: ["r1", ".env"], hops: [[["r1", ".env"], []]] },
      { label: "first hop of 2", path: ["r2", "alias"], hops: [[["r2", "alias"], []], [["r2", ".env"], []]] },
      { label: "middle hop of 3", path: ["r3", "a"], hops: [[["r3", "a"], []], [["r3", "b"], []], [["r3", ".env"], []]] },
      { label: "last hop of 3", path: ["r4", "a"], hops: [[["r4", "a"], []], [["r4", "b"], []], [["r4", "c"], []]] },
      { label: "final target, 1 link", path: ["r5", "data", "config"], hops: [[["r5", "data"], ["config"]]] },
      { label: "last hop and final target of 2", path: ["r6", "x", "credentials"], hops: [[["r6", "x"], ["credentials"]], [["r6", "y"], ["credentials"]]] },
      { label: "first hop of 2, directory part", path: ["r7", "p", "notes.txt"], hops: [[["r7", "p"], ["notes.txt"]], [["r7", ".ssh"], ["notes.txt"]]] },
    ]
    const missed: string[] = []
    for (const { label, path, hops } of rows) {
      const request = { workspace, path: at(...path) }
      const affects = await fileTargetAffects(request)
      if (!affects.sensitive || affects.text !== "The file [REDACTED] in the session worktree.") {
        missed.push(`${label}: ${JSON.stringify(affects).split(workspace).join("<worktree>")}`)
      }
      const forms = await hiddenPathForms(request)
      for (const [link, rest] of hops) {
        const alias = await through(link, rest)
        if (hidePaths(`Edit ${alias} now`, forms) !== "Edit [REDACTED] now") {
          missed.push(`${label}: ${alias.split(workspace).join("<worktree>")} shown`)
        }
      }
    }
    expect(missed).toEqual([])

    // No credential name anywhere on the chain: the card names the file.
    await expect(fileTargetAffects({ workspace, path: at("c1", "a") }))
      .resolves.toEqual({ text: "The file c1/public.txt in the session worktree.", redacted: false, sensitive: false })
    await expect(fileTargetAffects({ workspace, path: at("c2", "x", "notes.txt") }))
      .resolves.toEqual({ text: "The file c2/real/notes.txt in the session worktree.", redacted: false, sensitive: false })
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

  // Final check after 8181baf4: a link whose target is written in another case
  // than the directory it reaches. realpath writes the stored case, so the
  // spelling the link target used has to stay a form of its own.
  it("keeps the spelling a link target used beside the one realpath writes", async () => {
    const workspace = await directory("domovoi-hide-link-case-")
    const real = await realpath(workspace)
    await mkdir(join(workspace, "OutsideCase"))
    await writeFile(join(workspace, "OutsideCase", ".env"), "TOKEN=1")
    await symlink(join(workspace, "outsidecase"), join(workspace, "through"), "junction")
    const forms = await hiddenPathForms({ workspace, path: join(workspace, "through", ".env") })
    expect(forms).toEqual(expect.arrayContaining([
      join(workspace, "outsidecase", ".env"),
      join(real, "outsidecase", ".env"),
      "outsidecase/.env",
      "outsidecase\\.env",
    ]))
    expect(hidePaths(`Edit ${join(workspace, "outsidecase", ".env")} or outsidecase/.env`, forms))
      .toBe("Edit [REDACTED] or [REDACTED]")
  })

  // Final check after 59484617: each link on the way is its own alias. The
  // path it leads to, joined with the rest of the request still to walk,
  // names the hidden file too, for a chain of any length, whether the link is
  // in the directory part or is the last part, and whether its target is
  // relative or absolute. Each alias must be hidden as the link spells it,
  // from either spelling of the worktree, and relative to the worktree.
  it("hides the path after every link of a chain, as each link spells it", async () => {
    const workspace = await directory("domovoi-hide-chain-")
    const real = await realpath(workspace)
    const at = (...parts: string[]) => join(workspace, ...parts)
    await mkdir(at("real"))
    await writeFile(at("real", ".env"), "TOKEN=1")
    await mkdir(at(".ssh"))
    for (const folder of ["ddir", "edir"]) await mkdir(at(folder))
    // Junctions, which Windows makes without admin rights, and which it writes
    // with an absolute target whatever target it is given.
    const links: Array<[target: string, link: string]> = [
      [at("real"), "a1"],
      [".ssh", "b1"],
      [at("c2"), "c1"],
      ["real", "c2"],
      ["ddir", "d1"],
      [`..${sep}.ssh`, join("ddir", "keys")],
      ["e2", "e1"],
      [at("edir"), "e2"],
      [`..${sep}.ssh`, join("edir", "keys")],
      [at("f2"), "f1"],
      [at("f3"), "f2"],
      [at("real"), "f3"],
    ]
    for (const [target, link] of links) await symlink(target, at(link), "junction")
    // The path a link leads to, as the link writes it, with the rest after it.
    const through = async (link: string, rest: string) => {
      const target = await readlink(at(link))
      const base = isAbsolute(target) ? target : `${dirname(at(link))}${sep}${target}`
      return rest === "" ? base : `${base}${sep}${rest}`
    }
    const chains = [
      { label: "1 link, absolute, directory part", path: "a1/.env", hops: [["a1", ".env"]] },
      { label: "1 link, relative, last part", path: "b1", hops: [["b1", ""]] },
      { label: "2 links, absolute then relative, directory part", path: "c1/.env", hops: [["c1", ".env"], ["c2", ".env"]] },
      { label: "2 links, relative, directory then last part", path: "d1/keys", hops: [["d1", "keys"], ["ddir/keys", ""]] },
      { label: "3 links, relative, absolute, relative last part", path: "e1/keys", hops: [["e1", "keys"], ["e2", "keys"], ["edir/keys", ""]] },
      { label: "3 links, absolute, directory part", path: "f1/.env", hops: [["f1", ".env"], ["f2", ".env"], ["f3", ".env"]] },
    ]
    const missed: string[] = []
    for (const { label, path, hops } of chains) {
      const forms = await hiddenPathForms({ workspace, path: at(...path.split("/")) })
      for (const [link, rest] of hops) {
        const alias = await through(join(...link!.split("/")), rest!)
        const fromRoot = alias.startsWith(`${workspace}${sep}`) ? alias.slice(workspace.length + 1) : undefined
        const written = [
          alias,
          ...(fromRoot === undefined ? [] : [`${real}${sep}${fromRoot}`, fromRoot.split(sep).join("/")]),
        ]
        for (const text of written) {
          if (hidePaths(`Edit ${text} now`, forms) !== "Edit [REDACTED] now") {
            missed.push(`${label}: ${text.split(real).join("<real>").split(workspace).join("<worktree>")}`)
          }
        }
      }
    }
    expect(missed).toEqual([])
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
