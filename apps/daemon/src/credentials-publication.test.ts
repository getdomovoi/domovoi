import { link, mkdtemp, open, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { loadOrCreateDaemonToken } from "./credentials.js"
import { removeScratchDirectories } from "./test-scratch.js"

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return { ...fs, open: vi.fn(fs.open), link: vi.fn(fs.link) }
})
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await removeScratchDirectories(directories.splice(0))
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
    await writeFile(path, contents, { mode: 0o600 })
    await expect(loadOrCreateDaemonToken(path)).rejects.toMatchObject({
      message: expect.stringContaining(path),
    })
    await expect(loadOrCreateDaemonToken(path)).rejects.toThrow(/quarantine/i)
    await expect(readFile(path, "utf8")).resolves.toBe(contents)
  })
}
