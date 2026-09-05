import { describe, expect, it, vi } from "vitest"

import type { WslDistribution } from "./wsl-distributions.js"
import { resolveOpenTarget, wslSharePath, type OpenTargetInput } from "./wsl-open-target.js"

const known: WslDistribution[] = [
  { name: "Ubuntu-24.04", state: "Running", version: 2, default: true },
  { name: "debian", state: "Running", version: 2, default: false },
  { name: "parked", state: "Stopped", version: 2, default: false },
  { name: "Legacy", state: "Running", version: 1, default: false },
]

// Stands in for wslpath inside the distribution: the share prefix comes off
// and what is left is the distribution's own path.
function placeInDistribution(_distribution: string, windowsPath: string): Promise<string> {
  const segments = windowsPath.replace(/\\/g, "/").split("/").filter((segment) => segment !== "")
  return Promise.resolve(`/${segments.slice(2).join("/")}`)
}

function input(path: string, overrides: Partial<OpenTargetInput> = {}) {
  const base = {
    path,
    distributions: vi.fn<OpenTargetInput["distributions"]>(async () => known),
    translate: vi.fn<OpenTargetInput["translate"]>(placeInDistribution),
  }
  return Object.assign(base, overrides) as typeof base
}

describe("resolveOpenTarget", () => {
  it("routes a path Explorer wrote as a wsl share to the distribution that holds it", async () => {
    const request = input("\\\\wsl$\\Ubuntu-24.04\\home\\me\\project")
    await expect(resolveOpenTarget(request)).resolves.toEqual({
      kind: "wsl",
      distribution: "Ubuntu-24.04",
      path: "/home/me/project",
    })
    expect(request.translate).toHaveBeenCalledWith("Ubuntu-24.04", "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project")
  })

  it("routes the newer wsl.localhost form the same way", async () => {
    await expect(resolveOpenTarget(input("\\\\wsl.localhost\\debian\\srv\\app"))).resolves.toEqual({
      kind: "wsl",
      distribution: "debian",
      path: "/srv/app",
    })
  })

  it("hands the share written with forward slashes to the distribution in the form Windows uses", async () => {
    const request = input("//wsl$/debian/srv/app")
    await expect(resolveOpenTarget(request)).resolves.toEqual({
      kind: "wsl",
      distribution: "debian",
      path: "/srv/app",
    })
    expect(request.translate).toHaveBeenCalledWith("debian", "\\\\wsl$\\debian\\srv\\app")
  })

  it("asks for the distribution root as a directory", async () => {
    const request = input("\\\\wsl$\\debian")
    await expect(resolveOpenTarget(request)).resolves.toEqual({ kind: "wsl", distribution: "debian", path: "/" })
    expect(request.translate).toHaveBeenCalledWith("debian", "\\\\wsl$\\debian\\")
  })

  it("names the distribution as it is registered, whatever case the share used", async () => {
    const request = input("\\\\WSL$\\UBUNTU-24.04\\home")
    await expect(resolveOpenTarget(request)).resolves.toMatchObject({ distribution: "Ubuntu-24.04" })
    expect(request.translate).toHaveBeenCalledWith("Ubuntu-24.04", expect.any(String))
  })

  it("hands back the path the distribution answered, never one read through the share", async () => {
    const target = await resolveOpenTarget(input("\\\\wsl$\\debian\\srv\\app"))
    expect(target.kind).toBe("wsl")
    expect(target).toMatchObject({ path: expect.not.stringContaining("\\") })
    expect(target).toMatchObject({ path: expect.not.stringContaining("wsl$") })
  })

  it("reports a path the distribution refused, in the distribution's words", async () => {
    const request = input("\\\\wsl$\\debian\\mnt\\c\\repo", {
      translate: vi.fn(async () => {
        throw new Error("\\\\wsl$\\debian\\mnt\\c\\repo is a Windows drive")
      }),
    })
    await expect(resolveOpenTarget(request)).rejects.toThrow(/Windows drive/)
  })

  it("leaves a Windows path to the Windows daemon without asking wsl.exe anything", async () => {
    const request = input("C:\\Users\\me\\project")
    await expect(resolveOpenTarget(request)).resolves.toEqual({
      kind: "windows",
      path: "C:\\Users\\me\\project",
    })
    expect(request.distributions).not.toHaveBeenCalled()
    expect(request.translate).not.toHaveBeenCalled()
  })

  it("refuses a network share, which is not code on this machine", async () => {
    const request = input("\\\\fileserver\\share\\project")
    await expect(resolveOpenTarget(request)).rejects.toThrow(/this machine/)
    expect(request.translate).not.toHaveBeenCalled()
  })

  it("refuses a share that names no distribution", async () => {
    await expect(resolveOpenTarget(input("\\\\wsl$"))).rejects.toThrow(/distribution/)
  })

  it("refuses an empty path rather than guessing what to open", async () => {
    await expect(resolveOpenTarget(input(""))).rejects.toThrow(/path/)
  })

  it("refuses a distribution this machine does not have, and says how to list them", async () => {
    const request = input("\\\\wsl$\\arch\\home\\me")
    await expect(resolveOpenTarget(request)).rejects.toThrow(/arch.*wsl\.exe --list --verbose/s)
    expect(request.translate).not.toHaveBeenCalled()
  })

  it("refuses a stopped distribution rather than starting it, and says how to start it", async () => {
    const request = input("\\\\wsl$\\parked\\home\\me")
    await expect(resolveOpenTarget(request)).rejects.toThrow(/parked is stopped.*wsl\.exe -d parked.*domovoid/s)
    expect(request.translate).not.toHaveBeenCalled()
  })

  it("refuses a WSL 1 distribution, and says how to convert it", async () => {
    const request = input("\\\\wsl$\\Legacy\\home\\me")
    await expect(resolveOpenTarget(request)).rejects.toThrow(/Legacy.*WSL 1.*wsl\.exe --set-version Legacy 2/s)
    expect(request.translate).not.toHaveBeenCalled()
  })

  it("lists the distributions once, only for a share path", async () => {
    const request = input("\\\\wsl$\\debian\\srv")
    await resolveOpenTarget(request)
    expect(request.distributions).toHaveBeenCalledOnce()
  })
})

describe("wslSharePath", () => {
  it("reads the distribution and its path off either share name", () => {
    expect(wslSharePath("\\\\wsl$\\Ubuntu-24.04\\home\\me")).toEqual({ distribution: "Ubuntu-24.04", path: "/home/me" })
    expect(wslSharePath("\\\\wsl.localhost\\debian\\srv\\app")).toEqual({ distribution: "debian", path: "/srv/app" })
    expect(wslSharePath("//wsl$/debian/srv")).toEqual({ distribution: "debian", path: "/srv" })
  })

  it("reads the distribution root as the root of its filesystem", () => {
    expect(wslSharePath("\\\\wsl$\\debian")).toEqual({ distribution: "debian", path: "/" })
  })

  it("leaves every other path alone", () => {
    for (const path of ["C:\\Users\\me", "/home/me", "\\\\fileserver\\share", "\\\\wsl$", "", "wsl$\\debian"]) {
      expect(wslSharePath(path)).toBeUndefined()
    }
  })
})
