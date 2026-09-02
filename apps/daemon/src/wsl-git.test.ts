import { describe, expect, it } from "vitest"

import { distroGitCommand } from "./wsl-git.js"

const distribution = "Ubuntu-24.04"
const repositoryPath = "/home/me/project"

describe("distroGitCommand", () => {
  it("runs git inside the distribution that holds the repository", () => {
    expect(distroGitCommand({ distribution, repositoryPath, args: ["status", "--porcelain"] })).toEqual({
      command: "wsl.exe",
      args: ["-d", distribution, "--cd", repositoryPath, "--", "git", "status", "--porcelain"],
    })
  })

  it("ends its own options before the command, so a repository cannot supply one", () => {
    const { args } = distroGitCommand({ distribution, repositoryPath, args: ["--version"] })
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("git"))
  })

  it("keeps an argument containing spaces as one argument", () => {
    const { args } = distroGitCommand({
      distribution,
      repositoryPath,
      args: ["commit", "-m", "a message with spaces"],
    })
    expect(args.at(-1)).toBe("a message with spaces")
  })

  it("refuses a repository reached through the wsl share", () => {
    for (const path of [
      "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project",
      "//wsl$/Ubuntu-24.04/home/me/project",
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me",
    ]) {
      expect(() => distroGitCommand({ distribution, repositoryPath: path, args: ["status"] }))
        .toThrow(/inside the distribution/)
    }
  })

  it("refuses a Windows path, which belongs to the Windows daemon", () => {
    expect(() => distroGitCommand({ distribution, repositoryPath: "C:\\Users\\me\\project", args: ["status"] }))
      .toThrow(/inside the distribution/)
  })

  it("refuses a relative path, which depends on where the shim happened to run", () => {
    expect(() => distroGitCommand({ distribution, repositoryPath: "project", args: ["status"] }))
      .toThrow(/inside the distribution/)
  })

  it("refuses a distribution name wsl.exe would read as one of its own options", () => {
    expect(() => distroGitCommand({ distribution: "--exec", repositoryPath, args: ["status"] }))
      .toThrow(/distribution/)
  })

  it("refuses a distribution name carrying something a shell could act on", () => {
    for (const name of ["", "Ubuntu\nrm -rf /", "Ubuntu\u0000"]) {
      expect(() => distroGitCommand({ distribution: name, repositoryPath, args: ["status"] }))
        .toThrow(/distribution/)
    }
  })

  it("refuses to run git with no arguments at all", () => {
    expect(() => distroGitCommand({ distribution, repositoryPath, args: [] }))
      .toThrow(/git/)
  })
})

describe("distroGitCommand with an unusual distribution name", () => {
  it("accepts a distribution registered with spaces in its name", () => {
    const { args } = distroGitCommand({
      distribution: "Ubuntu 24.04 LTS",
      repositoryPath,
      args: ["status"],
    })
    expect(args[1]).toBe("Ubuntu 24.04 LTS")
  })
})

describe("distroGitCommand keeps the work inside the distribution", () => {
  it("refuses a repository on a Windows drive mounted into the distribution", () => {
    for (const path of ["/mnt/c/repo", "/mnt/d/work/project", "/mnt/c"]) {
      expect(() => distroGitCommand({ distribution, repositoryPath: path, args: ["status"] }))
        .toThrow(/inside the distribution/)
    }
  })

  it("refuses a path that climbs out of the distribution filesystem", () => {
    for (const path of ["/home/me/../../mnt/c/repo", "/home/me/../.."]) {
      expect(() => distroGitCommand({ distribution, repositoryPath: path, args: ["status"] }))
        .toThrow(/inside the distribution/)
    }
  })

  it("keeps a directory inside the distribution that a .. merely spelled oddly", () => {
    const { args } = distroGitCommand({
      distribution,
      repositoryPath: "/home/./me/../mnt/c",
      args: ["status"],
    })
    expect(args).toContain("/home/mnt/c")
  })

  it("keeps a directory that merely starts with the same letters as a mount", () => {
    const { args } = distroGitCommand({ distribution, repositoryPath: "/mntx/repo", args: ["status"] })
    expect(args).toContain("/mntx/repo")
  })

  it("refuses a git option that would choose a different repository", () => {
    for (const option of ["-C", "--git-dir=/mnt/c/other", "--work-tree=/tmp", "--exec-path=/tmp"]) {
      expect(() => distroGitCommand({ distribution, repositoryPath, args: [option, "status"] }))
        .toThrow(/repository/)
    }
  })

  it("still allows an option that belongs to the subcommand", () => {
    const { args } = distroGitCommand({
      distribution,
      repositoryPath,
      args: ["log", "--oneline", "-n", "5"],
    })
    expect(args.slice(-4)).toEqual(["log", "--oneline", "-n", "5"])
  })
})
