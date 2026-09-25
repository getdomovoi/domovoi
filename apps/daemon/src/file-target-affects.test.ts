import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { cardDirectory, fileTargetAffects, hiddenPathForms, hidePaths } from "./file-target-affects.js"
import { namesSecretPath } from "./permission-policy.js"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

// The matcher hidePaths replaced in 1b6aef0f, as it was at e8f7a4d3: one
// "u" pattern over every form, longest first. hidePaths must hide exactly
// what this hid. Each pattern is built once per set of forms, since building
// it costs far more than running it.
const patternsByForms = new Map<string, RegExp>()

function hidePathsByPattern(text: string, forms: readonly string[]): string {
  if (forms.length === 0) return text
  const alternatives = [...new Set(forms)]
    .filter((form) => form !== "")
    .sort((one, other) => other.length - one.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  if (alternatives.length === 0) return text
  const key = alternatives.join("\0")
  const pattern = patternsByForms.get(key) ?? new RegExp(
    `(?<![\\p{L}\\p{N}_.\\-])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_\\-]|\\.[\\p{L}\\p{N}])`,
    "gu",
  )
  patternsByForms.set(key, pattern)
  return text.replace(pattern, "[REDACTED]")
}

// A small seeded generator (mulberry32), so a failing text can be found again.
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

describe("fileTargetAffects", () => {
  it("names the file an edit reaches inside the worktree", async () => {
    const workspace = await directory("domovoi-affects-inside-")
    await mkdir(join(workspace, "two"))
    await symlink(join(workspace, "two"), join(workspace, "one"), "junction")
    await expect(fileTargetAffects({ workspace, path: join(workspace, "src", "a.ts") }))
      .resolves.toEqual({ text: "The file src/a.ts in the session worktree.", redacted: false, sensitive: false, forms: expect.any(Array), complete: true })
    await expect(fileTargetAffects({ workspace, path: "a.ts", cwd: join(workspace, "src") }))
      .resolves.toEqual({ text: "The file src/a.ts in the session worktree.", redacted: false, sensitive: false, forms: expect.any(Array), complete: true })
    await expect(fileTargetAffects({ workspace, path: join(workspace, "one", "file") }))
      .resolves.toEqual({ text: "The file two/file in the session worktree.", redacted: false, sensitive: false, forms: expect.any(Array), complete: true })
  })

  it("says when the file is outside the worktree, and the link that leads there", async () => {
    const workspace = await directory("domovoi-affects-link-")
    const outside = await directory("domovoi-affects-outside-")
    await symlink(outside, join(workspace, "out"), "junction")
    await expect(fileTargetAffects({ workspace, path: join(workspace, "out", "notes.txt") })).resolves.toEqual({
      text: `The file ${join(await realpath(outside), "notes.txt")}, outside the session worktree, through a link at out/notes.txt.`,
      redacted: false,
      sensitive: false,
      forms: expect.any(Array),
      complete: true,
    })
    const plain = resolve(outside, "..", "elsewhere.txt")
    await expect(fileTargetAffects({ workspace, path: plain }))
      .resolves.toEqual({ text: `The file ${plain}, outside the session worktree.`, redacted: false, sensitive: false, forms: expect.any(Array), complete: true })
  })

  it("hides a credential path and redacts a secret in any other", async () => {
    const workspace = await directory("domovoi-affects-secret-")
    await expect(fileTargetAffects({ workspace, path: join(workspace, ".env") }))
      .resolves.toEqual({ text: "The file [REDACTED] in the session worktree.", redacted: false, sensitive: true, forms: expect.any(Array), complete: true })
    await expect(fileTargetAffects({ workspace, path: join(workspace, "ghp_abcdefghijklmnop.txt") }))
      .resolves.toEqual({ text: "The file [REDACTED].txt in the session worktree.", redacted: true, sensitive: false, forms: expect.any(Array), complete: true })
  })

  // Ruled for #541 and applied here: a file hidden as [REDACTED] is a credential
  // file, so its card is a hard gate, whether the path names it or a link leads there.
  it("marks a credential file reached through a link with an ordinary name", async () => {
    const workspace = await directory("domovoi-affects-hidden-link-")
    await mkdir(join(workspace, ".ssh"))
    await symlink(join(workspace, ".ssh"), join(workspace, "cfg"), "junction")
    await expect(fileTargetAffects({ workspace, path: join(workspace, "cfg", "config") }))
      .resolves.toEqual({ text: "The file [REDACTED] in the session worktree.", redacted: false, sensitive: true, forms: expect.any(Array), complete: true })
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
      .resolves.toEqual({ text: "The file c1/public.txt in the session worktree.", redacted: false, sensitive: false, forms: expect.any(Array), complete: true })
    await expect(fileTargetAffects({ workspace, path: at("c2", "x", "notes.txt") }))
      .resolves.toEqual({ text: "The file c2/real/notes.txt in the session worktree.", redacted: false, sensitive: false, forms: expect.any(Array), complete: true })
  })

  // Final check after 3fd053db: the worktree, the request's directory and the
  // file can each be reached through links, and a credential name can sit on
  // any of those spellings. The set of spellings is built once
  // (hiddenPathForms); the card is judged on exactly that set and hides exactly
  // that set, so no spelling is judged and not hidden, or hidden and not judged.
  it("judges and hides one set of spellings through the worktree, the request directory and the file", async () => {
    const base = await directory("domovoi-affects-closed-set-")
    const at = (...parts: string[]) => join(base, ...parts)
    const real = await realpath(base)
    for (const folder of [
      ["w1", "public-workspace"], ["w2", ".ssh"], ["w0", "real-workspace"],
      ["d1", "ws", "work"], ["d2", "ws", ".ssh"], ["d0", "ws", "work"],
      ["t1", "ws"], ["t0", "ws"],
    ]) await mkdir(at(...folder), { recursive: true })
    await writeFile(at("w1", "public-workspace", "public.txt"), "hello")
    await writeFile(at("w0", "real-workspace", "public.txt"), "hello")
    await writeFile(at("d1", "ws", "work", "a.txt"), "hello")
    await writeFile(at("d0", "ws", "work", "a.txt"), "hello")
    await writeFile(at("t1", "ws", "public.txt"), "hello")
    await writeFile(at("t0", "ws", "public.txt"), "hello")
    // Directory links are junctions, which Windows makes without admin rights
    // and writes with an absolute target; file links are plain symlinks.
    const links: Array<[target: string, link: string[], type?: "junction"]> = [
      // Codex's case: the worktree is entry -> .env -> public-workspace.
      ["public-workspace", ["w1", ".env"], "junction"],
      [".env", ["w1", "entry"], "junction"],
      [at("w2", ".ssh"), ["w2", "entry"], "junction"],
      ["real-workspace", ["w0", "mid"], "junction"],
      ["mid", ["w0", "entry"], "junction"],
      // The request runs in run -> .env -> work.
      ["work", ["d1", "ws", ".env"], "junction"],
      [".env", ["d1", "ws", "run"], "junction"],
      [at("d2", "ws", ".ssh"), ["d2", "ws", "run"], "junction"],
      ["work", ["d0", "ws", "mid"], "junction"],
      ["mid", ["d0", "ws", "run"], "junction"],
      // The file is alias -> .env -> public.txt.
      ["public.txt", ["t1", "ws", ".env"]],
      [".env", ["t1", "ws", "alias"]],
      ["public.txt", ["t0", "ws", "second"]],
      ["second", ["t0", "ws", "first"]],
    ]
    for (const [target, link, type] of links) await symlink(target, at(...link), type)
    // The path a link leads to, as the link writes it, with the rest after it.
    const through = async (link: string[], rest: string) => {
      const target = await readlink(at(...link))
      const leads = isAbsolute(target) ? target : `${dirname(at(...link))}${sep}${target}`
      return rest === "" ? leads : `${leads}${sep}${rest}`
    }
    type Row = {
      label: string
      request: { workspace: string; path: string; cwd?: string }
      hops: Array<[link: string[], rest: string]>
    }
    const rows: Row[] = [
      {
        label: "worktree through a link, first hop .env, file named by its real path",
        request: { workspace: at("w1", "entry"), path: join(real, "w1", "public-workspace", "public.txt") },
        hops: [[["w1", "entry"], "public.txt"], [["w1", ".env"], "public.txt"]],
      },
      {
        label: "worktree through a link to .ssh, file named from the worktree",
        request: { workspace: at("w2", "entry"), path: "notes.txt" },
        hops: [[["w2", "entry"], "notes.txt"]],
      },
      {
        label: "request directory through a link, first hop .env, file named by its real path",
        request: { workspace: at("d1", "ws"), path: join(real, "d1", "ws", "work", "a.txt"), cwd: at("d1", "ws", "run") },
        hops: [[["d1", "ws", "run"], "a.txt"], [["d1", "ws", ".env"], "a.txt"]],
      },
      {
        label: "request directory through a link to .ssh, file named from it",
        request: { workspace: at("d2", "ws"), path: "k.txt", cwd: at("d2", "ws", "run") },
        hops: [[["d2", "ws", "run"], "k.txt"]],
      },
      {
        label: "file through alias -> .env -> public.txt",
        request: { workspace: at("t1", "ws"), path: at("t1", "ws", "alias") },
        hops: [[["t1", "ws", "alias"], ""], [["t1", "ws", ".env"], ""]],
      },
    ]
    const missed: string[] = []
    const shown = (text: string) => text.split(real).join("<real>").split(base).join("<base>")
    for (const { label, request, hops } of rows) {
      const affects = await fileTargetAffects(request)
      if (!affects.sensitive || !affects.text.startsWith("The file [REDACTED]")) missed.push(`${label}: ${shown(affects.text)}`)
      const forms = await hiddenPathForms(request)
      for (const [link, rest] of hops) {
        const alias = await through(link, rest)
        if (hidePaths(`Edit ${alias} now`, forms) !== "Edit [REDACTED] now") missed.push(`${label}: ${shown(alias)} shown`)
      }
    }
    expect(missed).toEqual([])

    // Controls: the same shapes with no credential name anywhere.
    const controls = [
      { request: { workspace: at("w0", "entry"), path: join(real, "w0", "real-workspace", "public.txt") }, text: "The file public.txt in the session worktree." },
      { request: { workspace: at("d0", "ws"), path: join(real, "d0", "ws", "work", "a.txt"), cwd: at("d0", "ws", "run") }, text: "The file work/a.txt in the session worktree." },
      { request: { workspace: at("t0", "ws"), path: at("t0", "ws", "first") }, text: "The file public.txt in the session worktree." },
    ]
    for (const { request, text } of controls) {
      await expect(fileTargetAffects(request)).resolves.toMatchObject({ text, redacted: false, sensitive: false })
    }

    // The structure: the card is judged on exactly the set it hides.
    for (const request of [...rows.map((row) => row.request), ...controls.map((control) => control.request)]) {
      const affects = await fileTargetAffects(request)
      const forms = await hiddenPathForms(request)
      expect(affects.forms).toEqual(forms)
      expect(affects.sensitive).toBe(forms.some(namesSecretPath))
    }
    // The directory line too.
    for (const request of rows.map((row) => row.request)) {
      const line = await cardDirectory({ directory: request.cwd ?? request.workspace, workspace: request.workspace })
      const forms = await hiddenPathForms({ workspace: request.workspace, path: request.cwd ?? request.workspace })
      expect(line.forms).toEqual(forms)
      expect(line.hidden).toBe(forms.some(namesSecretPath))
    }
  })

  // A link to its own parent spells the path without end (loop, loop/loop,
  // ...). The set is bounded, and a set that could not be closed is judged as
  // naming a credential path, so the card fails closed as a hard gate.
  it("judges a path whose spellings cannot be closed as a credential path", async () => {
    const workspace = await directory("domovoi-affects-spell-loop-")
    await writeFile(join(workspace, "file.txt"), "hello")
    await symlink(workspace, join(workspace, "loop"), "junction")
    const request = { workspace, path: join(workspace, "loop", "file.txt") }
    await expect(fileTargetAffects(request)).resolves.toMatchObject({
      text: "The file [REDACTED] in the session worktree.",
      redacted: false,
      sensitive: true,
      complete: false,
    })
    // Without the link on its way the same file is shown.
    await expect(fileTargetAffects({ workspace, path: join(workspace, "file.txt") }))
      .resolves.toMatchObject({ text: "The file file.txt in the session worktree.", redacted: false, sensitive: false, complete: true })
  })

  // Final check after e8f7a4d3: nine nested links, each beside the directory
  // it leads to, spell the path 2^9 ways, past any bound. The set is marked
  // not complete, so the server hides the card's text whole.
  it("marks a path with more spellings than its bound as not complete", async () => {
    const workspace = await directory("domovoi-affects-spell-many-")
    let below = workspace
    for (let level = 1; level <= 9; level += 1) {
      await mkdir(join(below, `deepd${level}`))
      await symlink(`deepd${level}`, join(below, `deepa${level}`), "junction")
      below = join(below, `deepd${level}`)
    }
    await writeFile(join(below, ".env"), "TOKEN=1")
    const links = Array.from({ length: 9 }, (_, level) => `deepa${level + 1}`)
    await expect(fileTargetAffects({ workspace, path: join(workspace, ...links, ".env") })).resolves.toMatchObject({
      text: "The file [REDACTED] in the session worktree.",
      sensitive: true,
      complete: false,
    })
  })

  it("keeps a path on one line and bounded", async () => {
    const workspace = await directory("domovoi-affects-shape-")
    await expect(fileTargetAffects({ workspace, path: join(workspace, "a\nNetwork: none\u202e") }))
      .resolves.toEqual({ text: "The file a\\nNetwork: none\\u202e in the session worktree.", redacted: false, sensitive: false, forms: expect.any(Array), complete: true })
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

  // Final check after 1b6aef0f: the text is read by code point, as the "u"
  // pattern hidePaths replaced read it. A lone surrogate is one unit, so the
  // form after it is still tried, and an astral letter or digit before a form
  // makes it the end of a longer name.
  it("hides a form after a lone surrogate", () => {
    const forms = [".env", "cfg/.env"]
    expect(hidePaths("\uD800.env, \uDBFF.env, \uDC00.env and x\uD800cfg/.env", forms))
      .toBe("\uD800[REDACTED], \uDBFF[REDACTED], \uDC00[REDACTED] and x\uD800[REDACTED]")
  })

  it("keeps a longer name that ends in a form after an astral letter or digit", () => {
    const forms = [".env", "cfg/.env"]
    expect(hidePaths("\u{10000}.env, a\u{10000}.env, \u{1D7D8}.env and \u{10000}cfg/.env", forms))
      .toBe("\u{10000}.env, a\u{10000}.env, \u{1D7D8}.env and \u{10000}cfg/[REDACTED]")
    expect(hidePaths("\u{1F600}.env", forms)).toBe("\u{1F600}[REDACTED]")
  })

  it("hides exactly what the pattern it replaced hid", () => {
    const random = seeded(545)
    const pick = <Item>(items: readonly Item[]): Item => items[Math.floor(random() * items.length)]!
    // Forms that are prefixes of each other, share a first character, are
    // written with either separator, hold astral characters, or start or end
    // with a lone surrogate.
    const pool = [
      ".env", ".env/keys", ".e", "e", "env", "en", ".env.local",
      "cfg/.env", "cfg\\.env", "cfg", "cf", "./.env", ".\\.env", "../.env", "..\\.env",
      "/w/cfg/.env", "/w/cfg", "/w", "/", "\\w\\cfg\\.env",
      "\u{10000}/.env", "\u{1F600}.env", "\u{1F600}", "a\u{10000}b/.env",
      ".env\uD800", "\uDC00.env", "x\uD800y/.env",
    ]
    const pieces = [
      "a", "Z", "7", "é", "_", "-", ".", "..", "/", "\\", " ", ",", "x", "e", "nv", "l",
      "\u{10000}", "\u{1F600}", "\u{1D7D8}", "\uD800", "\uDBFF", "\uDC00", "\uDFFF",
      ...pool, ...pool,
    ]
    const formSets = Array.from({ length: 64 }, () => pool.filter(() => random() < 0.4))
    const differing: string[] = []
    for (let run = 0; run < 20_000 && differing.length < 10; run += 1) {
      const forms = pick(formSets)
      let text = ""
      const count = 1 + Math.floor(random() * 24)
      for (let piece = 0; piece < count; piece += 1) text += pick(pieces)
      const expected = hidePathsByPattern(text, forms)
      const shown = hidePaths(text, forms)
      if (shown !== expected) {
        differing.push(`${JSON.stringify(text)} with ${JSON.stringify(forms)}: ${JSON.stringify(shown)}, pattern ${JSON.stringify(expected)}`)
      }
    }
    expect(differing).toEqual([])
  })

  // Final check after 1b6aef0f: 4,096 forms, the most a card holds, that
  // agree with the text for thousands of units at every place and never end
  // whole. Matching them is bounded; past the bound the text is hidden whole,
  // as a card whose spellings hit their bound is. The same forms still hide
  // one that stands whole in an ordinary text.
  it("hides the text whole when matching would take more than its bound", () => {
    const forms = Array.from({ length: 4096 }, (_, count) => `${"a/".repeat(count + 1)}x`)
    expect(hidePaths("/a".repeat(5_500), forms)).toBe("[REDACTED]")
    expect(hidePaths("cat a/a/x and a/b/x", forms)).toBe("cat [REDACTED] and a/b/x")
  })
})
