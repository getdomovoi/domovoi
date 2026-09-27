import { afterEach, describe, expect, it, vi } from "vitest"

// Directories the test places on a Windows volume: each path's identity and
// the path the volume reports for it. Other paths go to the real filesystem.
// No host can make a case-sensitive Windows directory, so the volume is faked.
const volume = vi.hoisted(() => new Map<string, { dev: bigint; ino: bigint; realpath: string }>())
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const statSync = ((path: string, options?: unknown) => {
    const entry = volume.get(String(path))
    if (entry === undefined) return (actual.statSync as (path: string, options?: unknown) => unknown)(path, options)
    return { dev: entry.dev, ino: entry.ino, isDirectory: () => true }
  }) as typeof actual.statSync
  const native = ((path: string, options?: unknown) => volume.get(String(path))?.realpath
    ?? (actual.realpathSync.native as (path: string, options?: unknown) => string)(path, options)) as typeof actual.realpathSync.native
  const realpathSync = Object.assign(((path: string, options?: unknown) => (actual.realpathSync as (path: string, options?: unknown) => string)(path, options)) as typeof actual.realpathSync, { native })
  return { ...actual, default: { ...actual, statSync, realpathSync }, statSync, realpathSync }
})

import { assertServiceProfile, ServiceProfileMismatchError } from "./service/configuration.js"

afterEach(() => { volume.clear() })

// Runs a check as if this process ran on the given host.
const onHost = (host: NodeJS.Platform, check: () => void) => {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...real, value: host })
  try { check() } finally { Object.defineProperty(process, "platform", real) }
}

// Security review round 13 of #577 (P2): a Windows directory can be case-
// sensitive, so Work and work beside each other are two profiles. Paths that
// exist compare by the volume's file identity, not by their lowercased names.
describe("sameProfileDirectory by file identity", () => {
  it("keeps two profiles apart whose names differ only in case", () => {
    volume.set("C:\\Profiles\\Work", { dev: 7n, ino: 1n, realpath: "C:\\Profiles\\Work" })
    volume.set("C:\\Profiles\\work", { dev: 7n, ino: 2n, realpath: "C:\\Profiles\\work" })
    onHost("win32", () => {
      expect(() => assertServiceProfile({ profileDirectory: "C:\\Profiles\\Work" }, { profileDirectory: "C:\\Profiles\\work" }, "win32"))
        .toThrow(ServiceProfileMismatchError)
    })
  })

  it("matches one profile named in another case", () => {
    volume.set("C:\\Users\\DL\\.domovoi", { dev: 7n, ino: 3n, realpath: "C:\\Users\\dl\\.domovoi" })
    volume.set("C:\\Users\\dl\\.domovoi", { dev: 7n, ino: 3n, realpath: "C:\\Users\\dl\\.domovoi" })
    onHost("win32", () => {
      expect(() => assertServiceProfile({ profileDirectory: "C:\\Users\\DL\\.domovoi" }, { profileDirectory: "C:\\Users\\dl\\.domovoi" }, "win32")).not.toThrow()
    })
  })

  // A volume that reports no file identity cannot tell the two apart, so only
  // the same reported path matches.
  it("refuses to merge names that differ only in case when the volume reports no identity", () => {
    volume.set("C:\\Share\\Work", { dev: 7n, ino: 0n, realpath: "C:\\Share\\Work" })
    volume.set("C:\\Share\\work", { dev: 7n, ino: 0n, realpath: "C:\\Share\\work" })
    onHost("win32", () => {
      expect(() => assertServiceProfile({ profileDirectory: "C:\\Share\\Work" }, { profileDirectory: "C:\\Share\\work" }, "win32"))
        .toThrow(ServiceProfileMismatchError)
    })
  })

  // Security review round 14 of #577 (P2): two missing paths have no identity
  // to compare, and their parent may be case-sensitive, so only the same
  // path text matches.
  it("refuses to merge two missing names that differ only in case", () => {
    onHost("win32", () => {
      expect(() => assertServiceProfile({ profileDirectory: "C:\\Missing\\Work" }, { profileDirectory: "C:\\Missing\\work" }, "win32"))
        .toThrow(ServiceProfileMismatchError)
    })
  })
})
