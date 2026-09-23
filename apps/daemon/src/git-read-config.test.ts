import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
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
const isolated: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
for (const name of programVariables) delete isolated[name]

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-read-config-")))
  scratchDirectories.push(root)
  await git("git", ["-C", root, "init", "-q"], { env: isolated })
  const set = (key: string, value: string) => git("git", ["-C", root, "config", key, value], { env: isolated })
  return { root, set }
}

describe("gitReadCanRunProgram", () => {
  it("lets a read-only Git command through when no setting can run a program", async () => {
    const { root } = await repository()

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(false)
  })

  it.each([
    ["core.fsmonitor", "/tmp/helper"],
    ["core.fsmonitor", "true"],
    ["core.pager", "less"],
    ["pager.status", "cat"],
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
  ])("asks when %s is set", async (key, value) => {
    const { root, set } = await repository()
    await set(key, value)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it.each([["core.fsmonitor", "false"], ["log.showSignature", "false"], ["format.pretty", "%h %s"], ["pretty.short", "%an %s"]])("does not ask for %s=%s", async (key, value) => {
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

  it("reads settings from an included file", async () => {
    const { root, set } = await repository()
    const included = join(root, "..", `${root.split("/").at(-1)}-included.gitconfig`)
    scratchDirectories.push(included)
    await writeFile(included, "[core]\n\tfsmonitor = /tmp/helper\n")
    await set("include.path", included)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it("reads the global configuration", async () => {
    const { root } = await repository()
    const global = join(root, ".git", "global.gitconfig")
    await writeFile(global, "[core]\n\tpager = less\n")

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

  it.each(programVariables)("asks when %s is set in the environment", async (name) => {
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
