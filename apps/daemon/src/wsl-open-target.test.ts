import { describe, expect, it } from "vitest"

import { resolveOpenTarget } from "./wsl-open-target.js"

const known = [{ name: "Ubuntu-24.04" }, { name: "debian" }]

describe("resolveOpenTarget", () => {
  it("routes a path Explorer wrote as a wsl share to the distribution that holds it", () => {
    expect(resolveOpenTarget({ path: "\\\\wsl$\\Ubuntu-24.04\\home\\me\\project", distributions: known })).toEqual({
      kind: "wsl",
      distribution: "Ubuntu-24.04",
      path: "/home/me/project",
    })
  })

  it("routes the newer wsl.localhost form the same way", () => {
    expect(resolveOpenTarget({ path: "\\\\wsl.localhost\\debian\\srv\\app", distributions: known })).toEqual({
      kind: "wsl",
      distribution: "debian",
      path: "/srv/app",
    })
  })

  it("reads the share written with forward slashes", () => {
    expect(resolveOpenTarget({ path: "//wsl$/debian/srv/app", distributions: known })).toEqual({
      kind: "wsl",
      distribution: "debian",
      path: "/srv/app",
    })
  })

  it("answers the distribution root with the root of its filesystem", () => {
    expect(resolveOpenTarget({ path: "\\\\wsl$\\debian", distributions: known })).toEqual({
      kind: "wsl",
      distribution: "debian",
      path: "/",
    })
  })

  it("names the distribution as it is registered, whatever case the share used", () => {
    expect(resolveOpenTarget({ path: "\\\\WSL$\\UBUNTU-24.04\\home", distributions: known })).toEqual({
      kind: "wsl",
      distribution: "Ubuntu-24.04",
      path: "/home",
    })
  })

  it("never hands back a path that would be read through the share", () => {
    const target = resolveOpenTarget({ path: "\\\\wsl$\\debian\\srv\\app", distributions: known })
    expect(target.kind).toBe("wsl")
    expect(target).toMatchObject({ path: expect.not.stringContaining("\\") })
    expect(target).toMatchObject({ path: expect.not.stringContaining("wsl$") })
  })

  it("refuses a Windows drive mounted into the distribution", () => {
    for (const path of [
      "\\\\wsl$\\debian\\mnt\\c\\repo",
      "\\\\wsl$\\debian\\mnt\\c",
      "//wsl$/debian/mnt/d/work",
    ]) {
      expect(() => resolveOpenTarget({ path, distributions: known })).toThrow(/Windows drive/)
    }
  })

  it("refuses a path that climbs into a Windows drive", () => {
    expect(() => resolveOpenTarget({
      path: "\\\\wsl$\\debian\\home\\me\\..\\..\\mnt\\c\\repo",
      distributions: known,
    })).toThrow(/Windows drive/)
  })

  it("normalizes a path that merely spelled itself oddly", () => {
    expect(resolveOpenTarget({
      path: "\\\\wsl$\\debian\\home\\.\\me\\..\\mnt\\c",
      distributions: known,
    })).toEqual({ kind: "wsl", distribution: "debian", path: "/home/mnt/c" })
  })

  it("keeps a directory that merely starts with the same letters as a mount", () => {
    expect(resolveOpenTarget({ path: "\\\\wsl$\\debian\\mntx\\repo", distributions: known }))
      .toEqual({ kind: "wsl", distribution: "debian", path: "/mntx/repo" })
  })

  it("refuses a distribution this machine does not have", () => {
    expect(() => resolveOpenTarget({ path: "\\\\wsl$\\arch\\home\\me", distributions: known }))
      .toThrow(/arch/)
  })

  it("leaves a Windows path to the Windows daemon", () => {
    expect(resolveOpenTarget({ path: "C:\\Users\\me\\project", distributions: known })).toEqual({
      kind: "windows",
      path: "C:\\Users\\me\\project",
    })
  })

  it("refuses a network share, which is not code on this machine", () => {
    expect(() => resolveOpenTarget({ path: "\\\\fileserver\\share\\project", distributions: known }))
      .toThrow(/this machine/)
  })

  it("refuses a share that names no distribution", () => {
    expect(() => resolveOpenTarget({ path: "\\\\wsl$", distributions: known })).toThrow(/distribution/)
  })

  it("refuses an empty path rather than guessing what to open", () => {
    expect(() => resolveOpenTarget({ path: "", distributions: known })).toThrow(/path/)
  })
})
