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
