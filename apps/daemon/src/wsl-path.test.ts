import { describe, expect, it, vi } from "vitest"

import { distributionPath, type DistributionPathInput } from "./wsl-path.js"

const distribution = "Ubuntu-24.04"

type Runner = NonNullable<DistributionPathInput["run"]>

// Stands in for wslpath inside a distribution whose Windows drives are
// mounted wherever the table says, so nothing here assumes /mnt.
function wslpath(table: Record<string, string>): ReturnType<typeof vi.fn<Runner>> {
  return vi.fn<Runner>(async (_command, args) => {
    const [flag, path] = args.slice(-2)
    const answer = table[`${flag} ${path}`]
    if (answer === undefined) {
      throw Object.assign(new Error(`wslpath: ${path}: Invalid argument`), {
        code: 1,
        stderr: `wslpath: ${path}: Invalid argument\n`,
      })
    }
    return `${answer}\n`
  })
}

const defaultMounts = wslpath({
  "-u \\\\wsl$\\Ubuntu-24.04\\home\\me\\project": "/home/me/project",
  "-w /home/me/project": "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project",
  "-u \\\\wsl.localhost\\Ubuntu-24.04\\srv\\app": "/srv/app",
  "-w /srv/app": "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\app",
  "-u \\\\wsl$\\Ubuntu-24.04\\": "/",
  "-w /": "\\\\wsl$\\Ubuntu-24.04\\",
  "-u \\\\wsl$\\Ubuntu-24.04\\mnt\\c\\repo": "/mnt/c/repo",
  "-w /mnt/c/repo": "C:\\repo",
  "-u C:\\work\\repo": "/mnt/c/work/repo",
  "-w /mnt/c/work/repo": "C:\\work\\repo",
  "-u \\\\wsl$\\Ubuntu-24.04\\home\\me\\my project": "/home/me/my project",
  "-w /home/me/my project": "\\\\wsl$\\Ubuntu-24.04\\home\\me\\my project",
})

describe("distributionPath", () => {
  it("asks the distribution's own wslpath where a share path lives", async () => {
    const run = defaultMounts
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project", run }))
      .resolves.toBe("/home/me/project")
    expect(run).toHaveBeenCalledWith(
      "wsl.exe",
      ["-d", distribution, "--", "wslpath", "-u", "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project"],
      { timeoutMs: expect.any(Number) },
    )
  })

  it("asks the distribution to say which Windows path that is, and accepts its own share", async () => {
    const run = defaultMounts
    await distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project", run })
    expect(run).toHaveBeenCalledWith(
      "wsl.exe",
      ["-d", distribution, "--", "wslpath", "-w", "/home/me/project"],
      { timeoutMs: expect.any(Number) },
    )
  })

  it("reads the wsl.localhost form the same way", async () => {
    await expect(distributionPath({ distribution, path: "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\app", run: defaultMounts }))
      .resolves.toBe("/srv/app")
  })

  it("writes a share spelled with forward slashes the way wslpath reads it", async () => {
    const run = defaultMounts
    await expect(distributionPath({ distribution, path: "//wsl$/Ubuntu-24.04/home/me/project", run }))
      .resolves.toBe("/home/me/project")
    expect(run).toHaveBeenCalledWith("wsl.exe", expect.arrayContaining(["\\\\wsl$\\Ubuntu-24.04\\home\\me\\project"]), expect.anything())
  })

  it("places the distribution root at the root of its filesystem", async () => {
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04", run: defaultMounts })).resolves.toBe("/")
  })

  it("refuses a Windows drive the distribution mounts, and says where to open it instead", async () => {
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\mnt\\c\\repo", run: defaultMounts }))
      .rejects.toThrow(/Windows drive.*Ubuntu-24\.04.*C:\\repo/s)
  })

  it("refuses a plain Windows path, which the distribution reaches only as a mounted drive", async () => {
    await expect(distributionPath({ distribution, path: "C:\\work\\repo", run: defaultMounts }))
      .rejects.toThrow(/Windows drive.*C:\\work\\repo/s)
  })

  it("does not assume Windows drives are mounted under /mnt", async () => {
    const customRoot = wslpath({
      "-u \\\\wsl$\\Ubuntu-24.04\\c\\work": "/c/work",
      "-w /c/work": "C:\\work",
      "-u \\\\wsl$\\Ubuntu-24.04\\mnt\\c": "/mnt/c",
      "-w /mnt/c": "\\\\wsl$\\Ubuntu-24.04\\mnt\\c",
    })
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\c\\work", run: customRoot }))
      .rejects.toThrow(/Windows drive/)
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\mnt\\c", run: customRoot }))
      .resolves.toBe("/mnt/c")
  })

  it("refuses a drive the distribution mounted by hand, wherever it put it", async () => {
    const byHand = wslpath({
      "-u \\\\wsl$\\Ubuntu-24.04\\data\\repo": "/data/repo",
      "-w /data/repo": "D:\\repo",
    })
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\data\\repo", run: byHand }))
      .rejects.toThrow(/Windows drive.*mounts at \/data\/repo.*D:\\repo/s)
  })

  it("refuses a path the distribution's wslpath could not place", async () => {
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\nowhere", run: defaultMounts }))
      .rejects.toThrow(/Ubuntu-24\.04.*nowhere/s)
  })

  it("reports a read-back the distribution's wslpath refused, naming the placed path", async () => {
    const run = wslpath({ "-u \\\\wsl$\\Ubuntu-24.04\\odd": "/odd" })
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\odd", run }))
      .rejects.toThrow(/Ubuntu-24\.04 could not say which Windows path \/odd is/)
  })

  it("refuses an answer that is not a path inside the distribution", async () => {
    for (const answer of ["", "C:\\repo", "relative/path"]) {
      const run = wslpath({ "-u \\\\wsl$\\Ubuntu-24.04\\x": answer })
      await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\x", run })).rejects.toThrow(/Ubuntu-24\.04/)
    }
  })

  it("refuses a path that reads back as another distribution's share", async () => {
    const run = wslpath({
      "-u \\\\wsl$\\Ubuntu-24.04\\mnt\\wsl\\debian\\srv": "/mnt/wsl/debian/srv",
      "-w /mnt/wsl/debian/srv": "\\\\wsl$\\debian\\srv",
    })
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\mnt\\wsl\\debian\\srv", run }))
      .rejects.toThrow(/debian/)
  })

  it("passes a path with spaces as one argument", async () => {
    const run = defaultMounts
    run.mockClear()
    await expect(distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\home\\me\\my project", run }))
      .resolves.toBe("/home/me/my project")
    const placed = run.mock.calls.find((call) => call[1].includes("-u"))
    expect(placed?.[1].at(-1)).toBe("\\\\wsl$\\Ubuntu-24.04\\home\\me\\my project")
  })

  it("never hands back a path that would be read through the share", async () => {
    const answer = await distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project", run: defaultMounts })
    expect(answer).not.toContain("wsl$")
    expect(answer).not.toContain("\\")
  })

  it("refuses a distribution name wsl.exe would read as an option, before asking anything", async () => {
    const run = defaultMounts
    run.mockClear()
    await expect(distributionPath({ distribution: "--exec", path: "\\\\wsl$\\x\\home", run })).rejects.toThrow(/distribution/)
    expect(run).not.toHaveBeenCalled()
  })

  it("gives up on a wsl.exe that never answers", async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn<Runner>(() => new Promise<string>(() => {}))
      const placing = distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\home", run, timeoutMs: 1_000 })
      const settled = expect(placing).rejects.toThrow(/in time/)
      await vi.advanceTimersByTimeAsync(1_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives the child a real deadline even when asked for none", async () => {
    const run = defaultMounts
    run.mockClear()
    await distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project", run, timeoutMs: 0 })
    for (const call of run.mock.calls) {
      expect((call[2] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0)
    }
  })

  it("tells the runner how long it is allowed to take", async () => {
    const run = defaultMounts
    run.mockClear()
    await distributionPath({ distribution, path: "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project", run, timeoutMs: 3_000 })
    expect(run).toHaveBeenCalledWith("wsl.exe", expect.any(Array), { timeoutMs: 3_000 })
  })
})
