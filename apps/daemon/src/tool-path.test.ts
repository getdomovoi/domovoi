import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it } from "vitest"

import { CliProviderProbe, runProviderCommand } from "./providers.js"
import {
  loginShellPathCommand,
  mergeToolPath,
  readLoginShellPath,
  resolveCommandPath,
  resolveCommandPathSync,
  resolveToolPath,
  toolPathFileName,
} from "./tool-path.js"

// The PATH a macOS app inherits from Finder or the Dock. Nothing a person
// installs lives in it.
const guiLaunchPath = "/usr/bin:/bin:/usr/sbin:/sbin"

describe("mergeToolPath", () => {
  it("puts the override first, then the login shell, then the launch PATH, without repeats", () => {
    expect(mergeToolPath({
      override: "/custom/bin",
      loginShell: "/opt/homebrew/bin:/usr/bin:/custom/bin",
      launch: guiLaunchPath,
      delimiter: ":",
    })).toBe("/custom/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
  })

  it("keeps the launch PATH alone when the login shell said nothing", () => {
    expect(mergeToolPath({ launch: guiLaunchPath, delimiter: ":" })).toBe(guiLaunchPath)
  })
})

describe("loginShellPathCommand", () => {
  it("asks a POSIX shell as a login shell and fish in its own words", () => {
    expect(loginShellPathCommand("/bin/zsh")).toEqual(["/bin/zsh", ["-l", "-c", "printf '%s' \"$PATH\""]])
    expect(loginShellPathCommand("/opt/homebrew/bin/fish")).toEqual(["/opt/homebrew/bin/fish", ["-l", "-c", "string join ':' $PATH"]])
  })
})

describe("readLoginShellPath", () => {
  it("returns nothing on Windows, with no shell, or when the shell fails or answers empty", async () => {
    const never = async () => { throw new Error("must not run") }
    await expect(readLoginShellPath({ shell: "/bin/zsh", platform: "win32", run: never })).resolves.toBeUndefined()
    await expect(readLoginShellPath({ shell: undefined, platform: "darwin", run: never })).resolves.toBeUndefined()
    await expect(readLoginShellPath({ shell: "/bin/zsh", platform: "darwin", run: async () => { throw new Error("spawn failed") } })).resolves.toBeUndefined()
    await expect(readLoginShellPath({ shell: "/bin/zsh", platform: "darwin", run: async () => ({ exitCode: 0, stdout: "  \n", stderr: "" }) })).resolves.toBeUndefined()
  })
})

describe("resolveCommandPath", () => {
  it("finds an executable on the given PATH and names its absolute path", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-tool-path-"))
    const bin = join(root, "bin")
    await mkdir(bin)
    // Windows resolves by PATHEXT and ignores the mode bit; POSIX needs +x.
    const name = process.platform === "win32" ? "claude.cmd" : "claude"
    await writeFile(join(bin, name), process.platform === "win32" ? "@echo 1.2.3\r\n" : "#!/bin/sh\necho 1.2.3\n")
    await chmod(join(bin, name), 0o755)
    const searched = [guiLaunchPath.split(":").join(delimiter), bin].join(delimiter)
    await expect(resolveCommandPath("claude", searched, process.platform)).resolves.toBe(join(bin, name))
    await expect(resolveCommandPath("claude", guiLaunchPath.split(":").join(delimiter), process.platform)).resolves.toBeUndefined()
    expect(resolveCommandPathSync("claude", searched, process.platform)).toBe(join(bin, name))
    expect(resolveCommandPathSync("claude", guiLaunchPath.split(":").join(delimiter), process.platform)).toBeUndefined()
  })
})

// The login shell step is what a Finder or Dock launch on macOS and a desktop
// entry on Linux need. Windows apps inherit the account PATH and the daemon
// skips the step there, so the shell fixture below has nothing to prove on
// Windows and would only exercise sh.
describe.skipIf(process.platform === "win32")("under a GUI launch environment", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "domovoi-gui-launch-"))
    const bin = join(root, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "claude"), "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.274 (Claude Code)'; else echo '{\"loggedIn\":true}'; fi\n")
    await chmod(join(bin, "claude"), 0o755)
    // Stands in for the person's login shell: its profile adds the bin dir.
    const shell = join(root, "fake-login-shell")
    await writeFile(shell, `#!/bin/sh\nprintf '%s' "${bin}:${guiLaunchPath}"\n`)
    await chmod(shell, 0o755)
    return { root, bin, shell }
  }

  it("finds a harness the launch PATH hides, records where, and persists the record", async () => {
    const { root, bin, shell } = await fixture()
    const resolved = await resolveToolPath({
      environment: { PATH: guiLaunchPath, SHELL: shell },
      platform: "darwin",
      profileDirectory: root,
      run: runProviderCommand,
    })
    expect(resolved.path).toBe(`${bin}:${guiLaunchPath}`)
    expect(resolved.loginShellPath).toBe(`${bin}:${guiLaunchPath}`)

    const probe = new CliProviderProbe(runProviderCommand, { path: resolved.path, platform: "darwin" })
    const claude = await probe.inspectProvider("claude-code")
    expect(claude).toMatchObject({ id: "claude-code", command: join(bin, "claude"), status: "ready", version: "2.1.274" })

    const record = JSON.parse(await readFile(join(root, toolPathFileName), "utf8")) as Record<string, unknown>
    expect(record).toMatchObject({ version: 1, launchPath: guiLaunchPath, loginShellPath: `${bin}:${guiLaunchPath}`, path: resolved.path })
  })

  it("does not find it without the login shell step, which is the packaged app's failure", async () => {
    const { bin } = await fixture()
    const probe = new CliProviderProbe(runProviderCommand, { path: guiLaunchPath, platform: "darwin" })
    const claude = await probe.inspectProvider("claude-code")
    expect(claude).toMatchObject({ id: "claude-code", status: "missing" })
    expect(claude?.command).not.toBe(join(bin, "claude"))
  })

  it("keeps a hand-written override in the record and puts it first", async () => {
    const { root, bin, shell } = await fixture()
    await writeFile(join(root, toolPathFileName), JSON.stringify({ version: 1, override: "/custom/tools" }))
    const resolved = await resolveToolPath({
      environment: { PATH: guiLaunchPath, SHELL: shell },
      platform: "darwin",
      profileDirectory: root,
      run: runProviderCommand,
    })
    expect(resolved.override).toBe("/custom/tools")
    expect(resolved.path).toBe(`/custom/tools:${bin}:${guiLaunchPath}`)
    const record = JSON.parse(await readFile(join(root, toolPathFileName), "utf8")) as Record<string, unknown>
    expect(record.override).toBe("/custom/tools")
  })

  it("lets the environment override win over the file", async () => {
    const { root, shell } = await fixture()
    await writeFile(join(root, toolPathFileName), JSON.stringify({ version: 1, override: "/from/file" }))
    const resolved = await resolveToolPath({
      environment: { PATH: guiLaunchPath, SHELL: shell, DOMOVOI_TOOL_PATH: "/from/env" },
      platform: "darwin",
      profileDirectory: root,
      run: runProviderCommand,
    })
    expect(resolved.override).toBe("/from/env")
    expect(resolved.path.startsWith("/from/env:")).toBe(true)
  })
})
