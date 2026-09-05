import { describe, expect, it, vi } from "vitest"

import { distroGitCommand, type DistroGitInput } from "./wsl-git.js"

const distribution = "Ubuntu-24.04"
const repositoryPath = "/home/me/project"

type Runner = NonNullable<DistroGitInput["run"]>

// Stands in for wslpath -w inside the distribution: a path of its own reads
// back as its share, and a Windows drive reads back as a drive wherever the
// distribution happens to mount it, so nothing here assumes /mnt.
function wslpath(drives: Record<string, string> = {}): ReturnType<typeof vi.fn<Runner>> {
  return vi.fn<Runner>(async (_command, args) => {
    const [, asked] = args
    const path = args.at(-1) ?? ""
    const drive = Object.entries(drives).find(([mount]) => path === mount || path.startsWith(`${mount}/`))
    if (drive) {
      const [mount, letter] = drive
      return `${letter}\\${path.slice(mount.length + 1).replace(/\//g, "\\")}\n`
    }
    return `\\\\wsl$\\${asked}${path.replace(/\//g, "\\")}\n`
  })
}

const defaultMounts = () => wslpath({ "/mnt/c": "C:", "/mnt/d": "D:" })

function command(input: Partial<DistroGitInput> = {}) {
  return distroGitCommand({ distribution, repositoryPath, args: ["status"], run: defaultMounts(), ...input })
}

describe("distroGitCommand", () => {
  it("runs git inside the distribution that holds the repository", async () => {
    await expect(command({ args: ["status", "--porcelain"] })).resolves.toEqual({
      command: "wsl.exe",
      args: ["-d", distribution, "--cd", repositoryPath, "--", "git", "status", "--porcelain"],
    })
  })

  it("asks the distribution where the repository reads back, as an argument list with a deadline", async () => {
    const run = defaultMounts()
    await command({ run })
    expect(run).toHaveBeenCalledWith(
      "wsl.exe",
      ["-d", distribution, "--", "wslpath", "-w", repositoryPath],
      { timeoutMs: expect.any(Number) },
    )
  })

  it("tells the runner how long it is allowed to take", async () => {
    const run = defaultMounts()
    await command({ run, timeoutMs: 3_000 })
    expect(run).toHaveBeenCalledWith("wsl.exe", expect.any(Array), { timeoutMs: 3_000 })
  })

  it("gives the child a real deadline even when asked for none", async () => {
    const run = defaultMounts()
    await command({ run, timeoutMs: 0 })
    expect((run.mock.calls[0]?.[2] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0)
  })

  it("ends its own options before the command, so a repository cannot supply one", async () => {
    const { args } = await command({ args: ["--version"] })
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("git"))
  })

  it("keeps an argument containing spaces as one argument", async () => {
    const { args } = await command({ args: ["commit", "-m", "a message with spaces"] })
    expect(args.at(-1)).toBe("a message with spaces")
  })

  it("refuses a repository reached through the wsl share, before asking anything", async () => {
    for (const path of [
      "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project",
      "//wsl$/Ubuntu-24.04/home/me/project",
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me",
    ]) {
      const run = defaultMounts()
      await expect(command({ repositoryPath: path, run })).rejects.toThrow(/inside the distribution/)
      expect(run).not.toHaveBeenCalled()
    }
  })

  it("refuses a Windows path, which belongs to the Windows daemon", async () => {
    const run = defaultMounts()
    await expect(command({ repositoryPath: "C:\\Users\\me\\project", run })).rejects.toThrow(/inside the distribution/)
    expect(run).not.toHaveBeenCalled()
  })

  it("refuses a relative path, which depends on where the shim happened to run", async () => {
    const run = defaultMounts()
    await expect(command({ repositoryPath: "project", run })).rejects.toThrow(/inside the distribution/)
    expect(run).not.toHaveBeenCalled()
  })

  it("refuses a distribution name wsl.exe would read as one of its own options", async () => {
    const run = defaultMounts()
    await expect(command({ distribution: "--exec", run })).rejects.toThrow(/distribution/)
    expect(run).not.toHaveBeenCalled()
  })

  it("refuses a distribution name carrying something a shell could act on", async () => {
    for (const name of ["", "Ubuntu\nrm -rf /", "Ubuntu\u0000"]) {
      await expect(command({ distribution: name })).rejects.toThrow(/distribution/)
    }
  })

  it("refuses to run git with no arguments at all", async () => {
    const run = defaultMounts()
    await expect(command({ args: [], run })).rejects.toThrow(/git/)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("distroGitCommand with an unusual distribution name", () => {
  it("accepts a distribution registered with spaces in its name", async () => {
    const { args } = await command({ distribution: "Ubuntu 24.04 LTS" })
    expect(args[1]).toBe("Ubuntu 24.04 LTS")
  })
})

describe("distroGitCommand keeps the work inside the distribution", () => {
  it("refuses a repository on a Windows drive mounted into the distribution", async () => {
    for (const path of ["/mnt/c/repo", "/mnt/d/work/project", "/mnt/c"]) {
      await expect(command({ repositoryPath: path })).rejects.toThrow(/Windows drive/)
    }
  })

  it("refuses a Windows drive wherever the distribution mounts it, not only under /mnt", async () => {
    await expect(command({ repositoryPath: "/c/repo", run: wslpath({ "/c": "C:" }) }))
      .rejects.toThrow(/Windows drive.*C:\\repo/s)
    await expect(command({ repositoryPath: "/data/repo", run: wslpath({ "/data": "D:" }) }))
      .rejects.toThrow(/Windows drive.*D:\\repo/s)
  })

  it("keeps a path under /mnt that the distribution does not reach from Windows", async () => {
    const { args } = await command({ repositoryPath: "/mnt/c/repo", run: wslpath({ "/c": "C:" }) })
    expect(args).toContain("/mnt/c/repo")
  })

  it("refuses a path that climbs out of the distribution filesystem", async () => {
    await expect(command({ repositoryPath: "/home/me/../../mnt/c/repo" })).rejects.toThrow(/Windows drive/)
    const run = defaultMounts()
    await expect(command({ repositoryPath: "/home/me/../..", run })).rejects.toThrow(/inside the distribution/)
    expect(run).not.toHaveBeenCalled()
  })

  it("keeps a directory inside the distribution that a .. merely spelled oddly", async () => {
    const { args } = await command({ repositoryPath: "/home/./me/../mnt/c" })
    expect(args).toContain("/home/mnt/c")
  })

  it("keeps a directory that merely starts with the same letters as a mount", async () => {
    const { args } = await command({ repositoryPath: "/mntx/repo" })
    expect(args).toContain("/mntx/repo")
  })

  it("refuses a path the distribution reads back as another distribution's share", async () => {
    const run = vi.fn<Runner>(async () => "\\\\wsl$\\debian\\srv\\app\n")
    await expect(command({ repositoryPath: "/mnt/wsl/debian/srv/app", run })).rejects.toThrow(/debian/)
  })

  it("reports a distribution that could not say where the repository is", async () => {
    const run = vi.fn<Runner>(async () => {
      throw Object.assign(new Error("wslpath: /home/me/project: Invalid argument"), { code: 1 })
    })
    await expect(command({ run })).rejects.toThrow(/Ubuntu-24\.04 could not say which Windows path \/home\/me\/project is/)
  })

  it("gives up on a wsl.exe that never answers", async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn<Runner>(() => new Promise<string>(() => {}))
      const building = command({ run, timeoutMs: 1_000 })
      const settled = expect(building).rejects.toThrow(/in time/)
      await vi.advanceTimersByTimeAsync(1_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses a git option that would choose a different repository", async () => {
    for (const option of ["-C", "--git-dir=/mnt/c/other", "--work-tree=/tmp", "--exec-path=/tmp"]) {
      const run = defaultMounts()
      await expect(command({ args: [option, "status"], run })).rejects.toThrow(/repository/)
      expect(run).not.toHaveBeenCalled()
    }
  })

  it("still allows an option that belongs to the subcommand", async () => {
    const { args } = await command({ args: ["log", "--oneline", "-n", "5"] })
    expect(args.slice(-4)).toEqual(["log", "--oneline", "-n", "5"])
  })
})
