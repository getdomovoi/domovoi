import { link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { loadOrCreateDaemonToken } from "./credentials.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { removeScratchDirectories } from "./test-scratch.js"

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return { ...fs, open: vi.fn(fs.open), link: vi.fn(fs.link), mkdir: vi.fn(fs.mkdir), rm: vi.fn(fs.rm) }
})
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(open).mockReset().mockImplementation(actual.open)
  vi.mocked(link).mockReset().mockImplementation(actual.link)
  vi.mocked(mkdir).mockReset().mockImplementation(actual.mkdir)
  vi.mocked(rm).mockReset().mockImplementation(actual.rm)
  await removeScratchDirectories(directories.splice(0))
  vi.mocked(rm).mockClear()
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-token-publication-"))
  directories.push(directory)
  return { directory, path: join(directory, "daemon.token") }
}

it("a failed initial write leaves no authoritative empty credential", async () => {
  const { directory, path } = await setup()
  vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode)
    vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("interrupted credential write"))
    return handle
  })
  await expect(loadOrCreateDaemonToken(path)).rejects.toThrow("interrupted credential write")
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readdir(directory)).toEqual([])
})

it("does not expose the credential until its bytes are synced and closed", async () => {
  const { path } = await setup()
  let synced = false
  let closed = false
  vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode)
    const sync = handle.sync.bind(handle)
    const close = handle.close.bind(handle)
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
      await sync()
      synced = true
    })
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true })
    return handle
  })
  vi.mocked(link).mockImplementation(async (...args) => {
    expect({ synced, closed }).toEqual({ synced: true, closed: true })
    await actual.link(...args)
  })
  const token = await loadOrCreateDaemonToken(path)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(link).toHaveBeenCalledOnce()
})

it("adopts a competing publication without replacing its credential", async () => {
  const { path } = await setup()
  const winner = "w".repeat(43)
  vi.mocked(link).mockImplementationOnce(async (source, target) => {
    await writeFile(path, `${winner}\n`, { mode: 0o600, flag: "wx" })
    await actual.link(source, target)
  })
  await expect(loadOrCreateDaemonToken(path)).resolves.toBe(winner)
  await expect(readFile(path, "utf8")).resolves.toBe(`${winner}\n`)
})

it("refuses unsupported complete-file publication rather than copying to the final name", async () => {
  const { directory, path } = await setup()
  vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("hard links unavailable"), { code: "EXDEV" }))
  await expect(loadOrCreateDaemonToken(path)).rejects.toThrow(path)
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readdir(directory)).toEqual([])
})

for (const contents of ["", "invalid-private-credential\n"]) {
  it(`names an offline quarantine path without replacing ${contents ? "malformed" : "empty"} legacy bytes`, async () => {
    const { path } = await setup()
    await writeFile(path, contents, { mode: 0o644 })
    await expect(loadOrCreateDaemonToken(path)).rejects.toMatchObject({
      message: expect.stringContaining(path),
    })
    await expect(loadOrCreateDaemonToken(path)).rejects.toThrow(/quarantine/i)
    await expect(readFile(path, "utf8")).resolves.toBe(contents)
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
}

it("does not acquire resources after the parent's deadline", async () => {
  const { path } = await setup()
  let now = 0
  const parent = OperationDeadline.start(10_000, { now: () => now })
  now = 10_001
  try {
    await expect(loadOrCreateDaemonToken(path, parent)).rejects.toThrow("No publication was started")
    expect(mkdir).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(link).not.toHaveBeenCalled()
  } finally { parent.clear() }
})

for (const phase of ["writeFile", "sync", "close"] as const) {
  it(`cleans its staging without publishing after a late ${phase} settlement`, async () => {
    const { directory, path } = await setup()
    let now = 0
    const parent = OperationDeadline.start(10_000, { now: () => now })
    const observation = OperationDeadline.start(10_000)
    vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode)
      if (phase === "writeFile") {
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, "writeFile").mockImplementation(async (...args) => { await write(...args); now = 10_001 })
      } else {
        const operation = handle[phase].bind(handle)
        vi.spyOn(handle, phase).mockImplementation(async () => { await operation(); now = 10_001 })
      }
      return handle
    })
    try {
      const failure = await loadOrCreateDaemonToken(path, parent).catch((error: unknown) => error)
      // Expiry bounds the caller first. Observe that the filesystem continuation
      // finishes cleanup without receiving permission for another side effect.
      await beforeDeadline(vi.waitFor(async () => {
        expect(await readdir(directory)).toEqual([])
      }, { timeout: 10_000 }), observation)
      expect(link).not.toHaveBeenCalled()
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
      expect(failure).toMatchObject({ message: expect.stringContaining("No publication was started") })
    } finally { parent.clear(); observation.clear() }
  }, 15_000)
}

for (const phase of ["sync", "close"] as const) {
  it(`removes only its staging after a ${phase} failure`, async () => {
    const { directory, path } = await setup()
    const failure = new Error(`credential ${phase} failed`)
    let closeCalls = 0
    vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeCalls += 1
        await close()
        if (phase === "close") throw failure
      })
      if (phase === "sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(failure)
      return handle
    })
    await expect(loadOrCreateDaemonToken(path)).rejects.toBe(failure)
    expect(closeCalls).toBe(1)
    expect(link).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })
}

it("names completed publication when staging removal fails and reuses the published bytes", async () => {
  const { directory, path } = await setup()
  const removalFailure = Object.assign(new Error("staging removal denied"), { code: "EPERM" })
  vi.mocked(rm).mockRejectedValueOnce(removalFailure)
  const failure = await loadOrCreateDaemonToken(path).catch((error: unknown) => error)
  const staging = vi.mocked(rm).mock.calls[0]![0]
  expect(failure).toMatchObject({ message: expect.stringContaining("publication completed"),
    cause: new AggregateError([removalFailure]) })
  expect((failure as Error).message).toContain(path)
  expect((failure as Error).message).toContain(String(staging))
  const published = (await readFile(path, "utf8")).trim()
  await expect(loadOrCreateDaemonToken(path)).resolves.toBe(published)
  expect(open).toHaveBeenCalledOnce()
  expect(await readdir(directory)).toHaveLength(2)
})

it("keeps a failed write primary when both close and staging removal fail", async () => {
  const { path } = await setup()
  const writeFailure = new Error("credential write denied")
  const closeFailure = new Error("credential close failed")
  const removalFailure = new Error("credential removal failed")
  vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode)
    const close = handle.close.bind(handle)
    vi.spyOn(handle, "writeFile").mockRejectedValueOnce(writeFailure)
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); throw closeFailure })
    return handle
  })
  vi.mocked(rm).mockRejectedValueOnce(removalFailure)
  const failure = await loadOrCreateDaemonToken(path).catch((error: unknown) => error)
  expect(failure).toMatchObject({ message: expect.stringContaining(path) })
  expect((failure as Error).message).toContain(String(vi.mocked(rm).mock.calls[0]![0]))
  expect((failure as Error).cause).toBeInstanceOf(AggregateError)
  expect(((failure as Error).cause as AggregateError).errors).toEqual([writeFailure, closeFailure, removalFailure])
  expect(link).not.toHaveBeenCalled()
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
})

it("does not remove an unowned staging path when exclusive creation refuses", async () => {
  const { path } = await setup()
  vi.mocked(open).mockImplementationOnce(async (file) => {
    await writeFile(file, "unowned staging", { flag: "wx", mode: 0o600 })
    throw Object.assign(new Error("staging already exists"), { code: "EEXIST" })
  })
  await expect(loadOrCreateDaemonToken(path)).rejects.toMatchObject({ code: "EEXIST" })
  expect(rm).not.toHaveBeenCalled()
  await expect(readFile(vi.mocked(open).mock.calls[0]![0], "utf8")).resolves.toBe("unowned staging")
  expect(link).not.toHaveBeenCalled()
})

it("ignores interrupted staging even when it holds a valid credential", async () => {
  const { directory, path } = await setup()
  const interrupted = `${path}.interrupted.partial`
  const orphan = "o".repeat(43)
  await writeFile(interrupted, `${orphan}\n`, { mode: 0o600 })
  const token = await loadOrCreateDaemonToken(path)
  expect(token).not.toBe(orphan)
  await expect(readFile(interrupted, "utf8")).resolves.toBe(`${orphan}\n`)
  expect(await readdir(directory)).toHaveLength(2)
})
