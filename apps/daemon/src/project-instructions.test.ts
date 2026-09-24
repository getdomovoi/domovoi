import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { importReferences, projectInstructions } from "./project-instructions.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "domovoi-instructions-"))
  scratchDirectories.push(path)
  return path
}

describe("importReferences", () => {
  it("reads imports from prose and skips code spans and fenced blocks", () => {
    expect(importReferences([
      "@AGENTS.md",
      "See @docs/rules.md and `@not/this.md`.",
      "```",
      "@inside/fence.md",
      "```",
      "mail me at someone@example.com",
    ].join("\n"))).toEqual(["AGENTS.md", "docs/rules.md"])
  })
})

describe("importReferences code boundaries", () => {
  it.each([
    ["a double-backtick span", "See ``@double/span.md`` here."],
    ["a span with a backtick inside", "See `` a ` @inner/tick.md `` here."],
    ["a code span across lines", "See `code\n@multi/line.md` done."],
    ["a fence indented by three spaces", "   ```\n@indented/fence.md\n   ```"],
    ["a tilde fence closed by a longer fence", "~~~\n@tilde/fence.md\n~~~~~"],
    ["a fence left open to the end", "```\n@open/fence.md\nmore"],
    ["an indented code block", "Intro.\n\n    @indented/block.md\n"],
    ["a tab-indented code block", "\t@tab/block.md"],
  ])("skips an import inside %s", (_label, text) => {
    expect(importReferences(text)).toEqual([])
  })

  it.each([
    ["prose after a closed double span", "See ``code`` then @after/span.md", ["after/span.md"]],
    ["a lone backtick", "A ` stray tick and @stray/tick.md", ["stray/tick.md"]],
    ["an indented line that continues a paragraph", "Intro line\n    @continued.md", ["continued.md"]],
    ["a fence closed by a shorter run, which does not close it", "````\n```\n@still/inside.md\n````\n@outside.md", ["outside.md"]],
  ])("keeps %s", (_label, text, expected) => {
    expect(importReferences(text)).toEqual(expected)
  })
})

describe("projectInstructions", () => {
  it("follows nested Claude imports inside the worktree only", async () => {
    const root = await scratch()
    const worktree = join(root, "worktree")
    await mkdir(join(worktree, "docs"), { recursive: true })
    await writeFile(join(root, "secret.md"), "outside secret\n")
    await writeFile(join(worktree, "CLAUDE.md"), "@docs/one.md\n@~/.ssh/config\n@/etc/hosts\ntop rule\n")
    await writeFile(join(worktree, "docs", "one.md"), "@two.md\none rule\n")
    await writeFile(join(worktree, "docs", "two.md"), "@../../secret.md\n@../CLAUDE.md\ntwo rule\n")

    const text = await projectInstructions(worktree, "claude")

    expect(text).toContain("Contents of CLAUDE.md")
    expect(text).toContain("Contents of docs/one.md")
    expect(text).toContain("Contents of docs/two.md")
    expect(text).toContain("two rule")
    expect(text).not.toContain("outside secret")
    expect(text?.match(/top rule/g)).toHaveLength(1)
  })

  it("stops following imports after five hops", async () => {
    const worktree = await scratch()
    await writeFile(join(worktree, "CLAUDE.md"), "@1.md\n")
    for (let index = 1; index <= 7; index += 1) {
      await writeFile(join(worktree, `${index}.md`), `@${index + 1}.md\nlevel ${index}\n`)
    }

    const text = await projectInstructions(worktree, "claude")

    expect(text).toContain("level 5")
    expect(text).not.toContain("level 6")
  })

  it.runIf(process.platform !== "win32")("refuses an instruction file that links outside the worktree", async () => {
    const root = await scratch()
    const worktree = join(root, "worktree")
    await mkdir(worktree)
    await writeFile(join(root, "outside.md"), "outside secret\n")
    await symlink(join(root, "outside.md"), join(worktree, "AGENTS.md"))

    await expect(projectInstructions(worktree, "opencode")).resolves.toBeUndefined()
  })

  it("reads nothing from a nested repository or from Git metadata", async () => {
    const worktree = await scratch()
    await mkdir(join(worktree, "vendor", "lib", ".git"), { recursive: true })
    await writeFile(join(worktree, "vendor", "lib", "rules.md"), "nested repo rule\n")
    await mkdir(join(worktree, "sub"), { recursive: true })
    await writeFile(join(worktree, "sub", ".git"), "gitdir: ../.git/modules/sub\n")
    await writeFile(join(worktree, "sub", "rules.md"), "submodule rule\n")
    await mkdir(join(worktree, ".git"), { recursive: true })
    await writeFile(join(worktree, ".git", "config"), "[core]\n\tgit metadata\n")
    await writeFile(join(worktree, "CLAUDE.md"), "@vendor/lib/rules.md\n@sub/rules.md\n@.git/config\ntop rule\n")

    const text = await projectInstructions(worktree, "claude")

    expect(text).toContain("top rule")
    expect(text).not.toContain("nested repo rule")
    expect(text).not.toContain("submodule rule")
    expect(text).not.toContain("git metadata")
  })

  it.runIf(process.platform !== "win32")("refuses a root instruction file that links into a submodule", async () => {
    const worktree = await scratch()
    await mkdir(join(worktree, "sub"), { recursive: true })
    await writeFile(join(worktree, "sub", ".git"), "gitdir: ../.git/modules/sub\n")
    await writeFile(join(worktree, "sub", "AGENTS.md"), "submodule rule\n")
    await symlink(join(worktree, "sub", "AGENTS.md"), join(worktree, "AGENTS.md"))
    await symlink(join(worktree, "sub", "AGENTS.md"), join(worktree, "CLAUDE.md"))

    await expect(projectInstructions(worktree, "opencode")).resolves.toBeUndefined()
    await expect(projectInstructions(worktree, "claude")).resolves.toBeUndefined()
  })

  it("gives OpenCode the first root instruction file in its own order", async () => {
    const worktree = await scratch()
    await writeFile(join(worktree, "CLAUDE.md"), "claude rule\n")
    await writeFile(join(worktree, "CONTEXT.md"), "context rule\n")

    const text = await projectInstructions(worktree, "opencode")

    expect(text).toMatch(/^Instructions from: .*CLAUDE\.md\nclaude rule/)
    expect(text).not.toContain("context rule")
  })
})
