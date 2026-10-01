import { win32 } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { gitCommand, GitNotFoundError } from "./git-command.js"

// Windows looks for a bare command name in the current directory before
// PATH, and a session worktree is the current directory of most daemon Git
// commands: a git.exe committed to the repository would run as the person
// before any filter isolation (ruling Q301). The command is an absolute path
// found on PATH alone.
describe("gitCommand on Windows", () => {
  // The current directory: a worktree holding a git.exe of its own.
  const worktree = "C:\\work\\repository"
  const installed = "C:\\Program Files\\Git\\cmd\\git.exe"
  const files = new Set([win32.join(worktree, "git.exe"), "git.exe", ".\\git.exe", "relative\\bin\\git.exe", "C:relative\\git.exe", installed])
  const isFile = vi.fn((path: string) => files.has(path))
  const absolute = (path: string) => /^[A-Za-z]:[\\/]|^\\\\/u.test(path)

  it("resolves an absolute git.exe from PATH and never the current directory's", () => {
    isFile.mockClear()
    const resolved = gitCommand({ Path: `.;;relative\\bin;C:relative;${installed.slice(0, -"\\git.exe".length)}` }, "win32", isFile)

    expect(resolved).toBe(installed)
    expect(absolute(resolved)).toBe(true)
    // Relative, empty and drive-relative entries resolve against the current
    // directory, so none of them is looked at.
    expect(isFile.mock.calls.map(([path]) => path)).toEqual([installed])
    expect(resolved).not.toBe(win32.join(worktree, "git.exe"))
  })

  it("reads PATH under any case of its name and takes a quoted entry", () => {
    expect(gitCommand({ pAtH: "\"C:\\Program Files\\Git\\cmd\"" }, "win32", isFile)).toBe(installed)
  })

  // Node gives the child one of several case variants of a name: the first
  // in sorted order, inherited keys included, and none at all when that one
  // is undefined. The resolver reads the PATH the child gets (ruling Q301).
  it("reads the PATH variant Node hands the child when names differ only in case", () => {
    const other = "C:\\Other\\Git\\cmd\\git.exe"
    const both = (path: string) => path === installed || path === other
    // "PATH" sorts before "Path", whatever the insertion order.
    expect(gitCommand({ Path: "C:\\Other\\Git\\cmd", PATH: "C:\\Program Files\\Git\\cmd" }, "win32", both)).toBe(installed)
    const inherited = Object.assign(Object.create({ PATH: "C:\\Program Files\\Git\\cmd" }) as NodeJS.ProcessEnv, { Path: "C:\\Other\\Git\\cmd" })
    expect(gitCommand(inherited, "win32", both)).toBe(installed)
    // The winning variant undefined: the child gets no PATH at all.
    expect(() => gitCommand({ PATH: undefined, Path: "C:\\Other\\Git\\cmd" }, "win32", both)).toThrow(GitNotFoundError)
  })

  it("refuses when no absolute PATH entry holds git.exe", () => {
    expect(() => gitCommand({ Path: "C:\\nothing;.;relative\\bin" }, "win32", isFile)).toThrow(GitNotFoundError)
    expect(() => gitCommand({}, "win32", isFile)).toThrow("Domovoi found no git.exe")
  })

  // POSIX execvp searches PATH alone; the current directory only through an
  // empty or "." PATH entry the person set (ruling Q301 keeps that lookup).
  it("leaves the PATH lookup to the platform elsewhere", () => {
    expect(gitCommand({ PATH: "/usr/bin" }, "linux", isFile)).toBe("git")
    expect(gitCommand({ PATH: "/usr/bin" }, "darwin", isFile)).toBe("git")
  })
})
