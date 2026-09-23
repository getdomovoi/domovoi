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

const isolated = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }

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
    ["filter.lfs.clean", "git-lfs clean -- %f"],
    ["filter.crypt.process", "/tmp/crypt"],
    ["log.showSignature", "true"],
    ["gpg.program", "/tmp/gpg"],
    ["gpg.ssh.program", "/tmp/ssh-keygen"],
  ])("asks when %s is set", async (key, value) => {
    const { root, set } = await repository()
    await set(key, value)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })

  it.each([["core.fsmonitor", "false"], ["log.showSignature", "false"]])("does not ask for %s=%s", async (key, value) => {
    const { root, set } = await repository()
    await set(key, value)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(false)
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

  it.each(["GIT_EXTERNAL_DIFF", "GIT_PAGER"])("asks when %s is set in the environment", async (name) => {
    const { root } = await repository()

    await expect(gitReadCanRunProgram(root, { ...isolated, [name]: "/tmp/program" })).resolves.toBe(true)
  })

  it("asks when the configuration cannot be read", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-read-config-none-")))
    scratchDirectories.push(root)

    await expect(gitReadCanRunProgram(root, isolated)).resolves.toBe(true)
  })
})
