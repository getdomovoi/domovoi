import { execFile } from "node:child_process"
import { access, chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { gitReadCanRunProgram } from "./git-read-config.js"
import { removeScratchDirectories } from "./test-scratch.js"

const git = promisify(execFile)
const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

const programVariables = ["GIT_PAGER", "PAGER", "GIT_EXTERNAL_DIFF", "GIT_EXEC_PATH"] as const
const isolated: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && !(programVariables as readonly string[]).includes(name)),
)
isolated.GIT_CONFIG_GLOBAL = "/dev/null"
isolated.GIT_CONFIG_NOSYSTEM = "1"

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-read-config-")))
  scratchDirectories.push(root)
  await git("git", ["-C", root, "init", "-q"], { env: isolated })
  const set = (key: string, value: string) => git("git", ["-C", root, "config", key, value], { env: isolated })
  return { root, set }
}

// The pager exemption rests on one premise: Git starts a pager only when its
// output is a terminal. Claude Code runs Bash commands without one (measured
// 2026-09-23: [ -t 1 ] and [ -t 0 ] false, and a pager set with -c did not
// run). Domovoi does not spawn those commands itself, so the closest point it
// can pin is Git's own behaviour with a configured pager and piped output.
describe("Git pager premise", () => {
  async function pagedRepository() {
    const { root, set } = await repository()
    await writeFile(join(root, "a.txt"), "a\n")
    await git("git", ["-C", root, "add", "a.txt"], { env: isolated })
    await git("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "a"], { env: isolated })
    const marker = join(root, ".git", "pager-ran")
    await set("core.pager", `sh -c 'echo ran > "${marker}"; cat'`)
    return { root, marker }
  }

  it("does not run a configured pager when the output is not a terminal", async () => {
    const { root, marker } = await pagedRepository()
    await git("git", ["-C", root, "log", "-1", "--oneline"], { env: isolated })
    await git("git", ["-C", root, "diff", "HEAD~0"], { env: isolated })

    await expect(access(marker)).rejects.toThrow()
  })

  it.runIf(process.platform !== "win32")("runs the same pager when a terminal is faked, so the check above can see one", async () => {
    const { root, marker } = await pagedRepository()
    await git("python3", ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", "git", "-C", root, "log", "-1", "--oneline"], { env: isolated })

    await expect(access(marker)).resolves.toBeUndefined()
  })
})

describe("gitReadCanRunProgram", () => {
  it("lets a read-only Git command through when no setting can run a program", async () => {
    const { root } = await repository()

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(false)
  })

  it.each([
    ["core.fsmonitor", "/tmp/helper"],
    ["core.fsmonitor", "true"],
    ["diff.external", "/tmp/differ"],
    ["diff.secret.textconv", "/tmp/decode"],
    ["diff.secret.command", "/tmp/differ"],
    ["filter.lfs.clean", "git-lfs clean %f"],
    ["filter.lfs.smudge", "git-lfs smudge --skip -- %f"],
    ["filter.lfs.process", "git-lfs filter-process --skip"],
    ["filter.lfs.required", "false"],
    ["filter.lfs.extra", "/tmp/program"],
    ["filter.crypt.process", "/tmp/crypt"],
    ["log.showSignature", "true"],
    ["gpg.program", "/tmp/gpg"],
    ["gpg.ssh.program", "/tmp/ssh-keygen"],
    ["format.pretty", "%h %G?"],
    ["format.pretty", "format:%GG"],
    ["format.pretty", "%GS"],
    ["format.pretty", "%GK"],
    ["format.pretty", "%GF"],
    ["format.pretty", "%GP"],
    ["format.pretty", "%GT"],
    ["format.pretty", "%GR"],
    ["pretty.signed", "%h %G? %s"],
    ["format.pretty", "%%%G?"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialCloneFilter", "blob:none"],
    ["extensions.partialClone", "origin"],
  ])("asks when %s is set", async (key, value) => {
    const { root, set } = await repository()
    await set(key, value)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it.each([
    ["core.fsmonitor", "false"],
    ["log.showSignature", "false"],
    ["format.pretty", "%h %s"],
    ["pretty.short", "%an %s"],
    ["core.pager", "less"],
    ["pager.status", "cat"],
    ["pager.log", "/tmp/program"],
    ["format.pretty", "100%%Green %h"],
    ["pretty.escaped", "%%GG %s"],
    ["remote.origin.promisor", "false"],
  ])("does not ask for %s=%s", async (key, value) => {
    const { root, set } = await repository()
    await set(key, value)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(false)
  })

  it("allows the filter lines git lfs install writes, exactly", async () => {
    const { root, set } = await repository()
    await set("filter.lfs.clean", "git-lfs clean -- %f")
    await set("filter.lfs.smudge", "git-lfs smudge -- %f")
    await set("filter.lfs.process", "git-lfs filter-process")
    await set("filter.lfs.required", "true")

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(false)
    await set("filter.crypt.clean", "/tmp/crypt")
    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it("asks in a repository with a submodule, since git status runs each submodule under its own configuration", async () => {
    const { root } = await repository()
    await writeFile(join(root, "a.txt"), "a\n")
    const commit = async () => {
      await git("git", ["-C", root, "add", "a.txt"], { env: isolated })
      await git("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "a"], { env: isolated })
      return (await git("git", ["-C", root, "rev-parse", "HEAD"], { env: isolated })).stdout.trim()
    }
    const head = await commit()
    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(false)
    await git("git", ["-C", root, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/lib`], { env: isolated })

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it("asks in a partial clone, where git log --stat can fetch missing objects through the remote's programs", async () => {
    const server = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-read-config-server-")))
    const parent = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-read-config-partial-")))
    scratchDirectories.push(server, parent)
    const run = (cwd: string, ...args: string[]) => git("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { env: isolated })
    await run(server, "init", "-q")
    await run(server, "config", "uploadpack.allowFilter", "true")
    await writeFile(join(server, "a.txt"), "a\n")
    await run(server, "add", "a.txt")
    await run(server, "commit", "-qm", "a")
    await run(parent, "clone", "-q", "--no-checkout", "--filter=blob:none", `file://${server}`, "clone")

    await expect(gitReadCanRunProgram(join(parent, "clone"), isolated)).resolves.toBe(true)
  })

  it("reads settings from an included file", async () => {
    const { root, set } = await repository()
    const included = join(root, "..", `${root.split("/").at(-1)}-included.gitconfig`)
    scratchDirectories.push(included)
    await writeFile(included, "[core]\n\tfsmonitor = /tmp/helper\n")
    await set("include.path", included)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it.each(["GIT_PAGER", "PAGER"])("does not ask for %s, since Git pages only to a terminal", async (name) => {
    const { root } = await repository()

    await expect(gitReadCanRunProgram(root, { ...isolated, [name]: "/tmp/program" })).resolves.toBe(false)
  })

  it("reads the global configuration", async () => {
    const { root } = await repository()
    const global = join(root, ".git", "global.gitconfig")
    await writeFile(global, "[core]\n\tfsmonitor = /tmp/helper\n")

    await expect(gitReadCanRunProgram(root, { ...isolated, GIT_CONFIG_GLOBAL: global })).resolves.toBe(true)
  })

  it("asks when a post-index-change hook exists, since git status can rewrite the index", async () => {
    const { root, set } = await repository()
    await mkdir(join(root, "hooks-elsewhere"), { recursive: true })
    await writeFile(join(root, "hooks-elsewhere", "post-index-change"), "#!/bin/sh\n")
    await chmod(join(root, "hooks-elsewhere", "post-index-change"), 0o755)
    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(false)
    await set("core.hooksPath", join(root, "hooks-elsewhere"))

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it.each(["GIT_EXTERNAL_DIFF", "GIT_EXEC_PATH"])("asks when %s is set in the environment", async (name) => {
    const { root } = await repository()

    await expect(gitReadCanRunProgram(root, { ...isolated, [name]: "/tmp/program" })).resolves.toBe(true)
  })

  it("finds a hook under a hooks path that starts with a space", async () => {
    const { root, set } = await repository()
    await mkdir(join(root, " spaced-hooks"), { recursive: true })
    await writeFile(join(root, " spaced-hooks", "post-index-change"), "#!/bin/sh\n")
    await chmod(join(root, " spaced-hooks", "post-index-change"), 0o755)
    await set("core.hooksPath", " spaced-hooks")

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it("asks when the configuration cannot be read", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-read-config-none-")))
    scratchDirectories.push(root)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })
})
