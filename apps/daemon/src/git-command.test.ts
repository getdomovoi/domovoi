import { win32 } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { gitCommand, GitNotFoundError, isolationGitCommand } from "./git-command.js"

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

  // libuv reads a quoted PATH entry up to its closing quote before looking
  // for the separator, so a quoted directory can hold a semicolon.
  it("keeps a quoted entry with a semicolon in it whole", () => {
    const quoted = "C:\\Tools;Git\\cmd\\git.exe"
    const exists = (path: string) => path === quoted
    expect(gitCommand({ Path: ".;\"C:\\Tools;Git\\cmd\";C:\\nothing" }, "win32", exists)).toBe(quoted)
    expect(gitCommand({ Path: "'C:\\Tools;Git\\cmd'" }, "win32", exists)).toBe(quoted)
  })

  // A malformed UNC prefix (two separators, then no server and share) joins
  // into a path rooted on the current drive, which the launch can resolve on
  // another drive than the probe did. Only a fully qualified drive path or a
  // UNC path with a server and a share is probed (ruling Q305).
  it("passes over an entry that joins to a path rooted on the current drive", () => {
    const anything = vi.fn(() => true)
    for (const entry of ["'\\\\/dir'", "\\\\/dir", "\\/dir", "/\\dir", "\\\\\\dir", "\\\\server", "//server/", "\\\\server\\\\share"]) {
      anything.mockClear()
      expect(() => gitCommand({ Path: entry }, "win32", anything), entry).toThrow(GitNotFoundError)
      expect(anything, entry).not.toHaveBeenCalled()
    }
    // Mixed separators in a whole UNC path, and a drive path, still count.
    expect(gitCommand({ Path: "//server/share/Git/cmd" }, "win32", anything)).toBe("\\\\server\\share\\Git\\cmd\\git.exe")
    expect(gitCommand({ Path: "\\\\server/share\\Git" }, "win32", anything)).toBe("\\\\server\\share\\Git\\git.exe")
    expect(gitCommand({ Path: "C:/Git/cmd" }, "win32", anything)).toBe("C:\\Git\\cmd\\git.exe")
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

// Isolation captures one Git binary at opening, by absolute path, on POSIX
// too (ruling Q321): its version is checked and cached by that path, and every
// isolated command runs it. Empty and relative PATH entries, which resolve
// against the current directory, are passed over as on Windows.
describe("isolationGitCommand", () => {
  it("takes the first git in an absolute POSIX PATH entry", () => {
    const isFile = vi.fn((path: string) => path === "/opt/git/bin/git" || path === "/usr/bin/git" || path === "relative/bin/git" || path === "git")
    expect(isolationGitCommand({ PATH: ":.:relative/bin:/nothing:/opt/git/bin:/usr/bin" }, "linux", isFile)).toBe("/opt/git/bin/git")
    expect(isFile.mock.calls.map(([path]) => path)).toEqual(["/nothing/git", "/opt/git/bin/git"])
  })

  it("refuses when no absolute POSIX PATH entry holds git", () => {
    expect(() => isolationGitCommand({ PATH: ":.:relative/bin" }, "darwin", () => true)).toThrow(GitNotFoundError)
    expect(() => isolationGitCommand({}, "darwin", () => true)).toThrow("Domovoi found no git")
  })

  it("takes the Windows resolver's git.exe on Windows", () => {
    const installed = "C:\\Program Files\\Git\\cmd\\git.exe"
    expect(isolationGitCommand({ Path: "C:\\Program Files\\Git\\cmd" }, "win32", (path) => path === installed)).toBe(installed)
  })
})
