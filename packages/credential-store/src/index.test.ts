import { chmod, lstat, mkdtemp as createTempDirectory, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { nativeKeyring, openCredentialBackend, readPrivateFile, writePrivateFile, type Keyring } from "./index.js"

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  lstat: vi.fn((...args: Parameters<typeof lstat>) => actualLstat(...args)),
  open: vi.fn((...args: Parameters<typeof open>) => actualOpen(...args)),
  unlink: vi.fn((...args: Parameters<typeof unlink>) => actualUnlink(...args)),
}))
const { lstat: actualLstat, open: actualOpen, unlink: actualUnlink } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const keyring = (): Keyring => ({ available: vi.fn(async () => true), get: vi.fn(), set: vi.fn(), delete: vi.fn() })
const options = (ring = keyring()) => ({ keyring: ring, warn: vi.fn(), fileWarning: (path: string) => `private file: ${path}`, unavailable: (cause?: Error) => `keychain refused: ${cause?.message ?? "absent"}` })
const roots: string[] = []
async function mkdtemp(prefix: string) { const root = await createTempDirectory(prefix); roots.push(root); return root }
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("credential custody", () => {
  it("selects a responding keychain without a file or warning", async () => {
    const input = options()
    expect(await openCredentialBackend(input)).toEqual({ where: "keyring", keyring: input.keyring })
    expect(input.warn).not.toHaveBeenCalled()
  })

  it("refuses absent, locked and throwing keychains without file fallback", async () => {
    for (const failure of [undefined, new Error("locked")]) {
      const ring = { ...keyring(), available: async () => false, cause: () => failure }
      await expect(openCredentialBackend(options(ring))).rejects.toThrow(`keychain refused: ${failure?.message ?? "absent"}`)
      expect(ring.set).not.toHaveBeenCalled()
    }
    const ring = { ...keyring(), available: async () => { throw new Error("probe failed") } }
    await expect(openCredentialBackend(options(ring))).rejects.toThrow("probe failed")
  })

  it("honors an explicit file even with a keychain, preserves bytes, and publishes mode 0600", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "domovoi-custody-")), "key")
    const input = { ...options(), credentialFile: path }
    const store = await openCredentialBackend(input)
    expect(store.where).toBe("file")
    if (store.where !== "file") throw new Error("file required")
    expect(input.keyring.available).not.toHaveBeenCalled()
    expect(input.warn).toHaveBeenCalledExactlyOnceWith(`private file: ${path}`)
    expect(await store.read()).toBeUndefined()
    await store.write("é🙂")
    expect(await store.read()).toBe("é🙂")
    await store.write("replacement")
    expect(await readFile(path, "utf8")).toBe("replacement")
    const handle = await actualOpen(path, "r")
    try { if (process.platform !== "win32") expect((await handle.stat()).mode & 0o777).toBe(0o600) } finally { await handle.close() }
  })

  it.skipIf(process.platform === "win32")("rejects symlinks and refuses mode 0644 before reading any bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-custody-"))
    const path = join(root, "key")
    await writeFile(path, "secret", { mode: 0o600 })
    await symlink(path, join(root, "link"))
    await expect(openCredentialBackend({ ...options(), credentialFile: join(root, "link") })).rejects.toThrow("symlink")
    await chmod(path, 0o644)
    const read = vi.fn()
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args)
      vi.spyOn(handle, "readFile").mockImplementation(read)
      vi.spyOn(handle, "read").mockImplementation(read)
      return handle
    })
    await expect(readPrivateFile(path)).rejects.toThrow("mode 0600")
    expect(read).not.toHaveBeenCalled()
  })

  it("checks every read again and bounds UTF-8 bytes", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "domovoi-custody-")), "key")
    const store = await openCredentialBackend({ ...options(), credentialFile: path, maximumBytes: 6 })
    if (store.where !== "file") throw new Error("file required")
    await store.write("é🙂")
    expect(await store.read()).toBe("é🙂")
    await expect(store.write("é🙂x")).rejects.toThrow("6 bytes")
    await writeFile(path, "1234567")
    await expect(store.read()).rejects.toThrow("6 bytes")
  })

  it.each(["ENOTDIR", "EACCES", "EIO"])("propagates lstat %s failures instead of reporting absence", async (code) => {
    const path = join(await mkdtemp(join(tmpdir(), "domovoi-custody-")), "key")
    const failure = Object.assign(new Error("stat failed"), { code })
    const opens = vi.mocked(open).mock.calls.length
    vi.mocked(lstat).mockRejectedValueOnce(failure)
    await expect(readPrivateFile(path)).rejects.toBe(failure)
    expect(vi.mocked(open).mock.calls).toHaveLength(opens)
  })

  it.each([NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects byte limit %s before touching an absent file", async (maximumBytes) => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-custody-"))
    const path = join(root, "missing", "key")
    const reads = vi.mocked(lstat).mock.calls.length
    const opens = vi.mocked(open).mock.calls.length
    await expect(readPrivateFile(path, { maximumBytes })).rejects.toThrow("positive safe integer")
    await expect(writePrivateFile(path, "", { maximumBytes })).rejects.toThrow("positive safe integer")
    await expect(openCredentialBackend({ ...options(), credentialFile: path, maximumBytes })).rejects.toThrow("positive safe integer")
    expect(vi.mocked(lstat).mock.calls).toHaveLength(reads)
    expect(vi.mocked(open).mock.calls).toHaveLength(opens)
    expect(await readdir(root)).toEqual([])
  })

  it.skipIf(process.platform === "win32")("flushes new parent entries before the credential and its final name after rename", async () => {
    const root = resolve(await mkdtemp(join(tmpdir(), "domovoi-custody-")))
    const parent = join(root, "new", "nested")
    const path = join(parent, "key")
    const events: string[] = []
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args)
      const directory = (await handle.stat()).isDirectory()
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        events.push(directory ? `sync:${String(args[0])}` : "file-sync")
        await sync()
      })
      return handle
    })
    await writePrivateFile(path, "fixture", { publish: async (from, to) => { await rename(from, to); events.push("rename") } })
    expect(events).toEqual([
      `sync:${parent}`, `sync:${join(root, "new")}`, `sync:${root}`,
      "file-sync", "rename", `sync:${parent}`,
    ])
    expect(await readFile(path, "utf8")).toBe("fixture")
  })

  it.skipIf(process.platform === "win32")("names an already published credential when directory flush and close fail", async () => {
    const root = resolve(await mkdtemp(join(tmpdir(), "domovoi-custody-")))
    const path = join(root, "key")
    const primary = new Error("directory sync failed"), cleanup = new Error("directory close failed")
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args)
      if ((await handle.stat()).isDirectory()) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, "sync").mockRejectedValueOnce(primary)
        vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); throw cleanup })
      }
      return handle
    })
    await expect(writePrivateFile(path, "fixture")).rejects.toMatchObject({
      message: expect.stringContaining(`published at ${path}`),
      cause: { errors: [primary, cleanup], cause: primary },
    })
    expect(await readFile(path, "utf8")).toBe("fixture")
    expect(await readdir(root)).toEqual(["key"])
  })

  it("refuses nonregular files, open errors and a replaced descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-custody-"))
    const path = join(root, "key")
    await expect(readPrivateFile(root)).rejects.toThrow("not a regular file")
    await writeFile(path, "fixture", { mode: 0o600 })
    for (const code of ["EACCES", "EIO"]) {
      const refusal = Object.assign(new Error(code), { code })
      vi.mocked(open).mockRejectedValueOnce(refusal)
      await expect(readPrivateFile(path)).rejects.toBe(refusal)
    }
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("loop"), { code: "ELOOP" }))
    await expect(readPrivateFile(path)).rejects.toThrow("symlink")
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args)
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => { const status = await stat(); status.ino += 1; return status })
      return handle
    })
    await expect(readPrivateFile(path)).rejects.toThrow("changed while opening")
  })

  it("refuses growth beyond the cap after the size observation", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "domovoi-custody-")), "key")
    await writeFile(path, "1234567", { mode: 0o600 })
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args)
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => { const status = await stat(); status.size = 2; return status })
      return handle
    })
    await expect(readPrivateFile(path, { maximumBytes: 6 })).rejects.toThrow("6 bytes")
    await expect(readPrivateFile(path, { maximumBytes: 0 })).rejects.toThrow("positive safe integer")
  })

  it("preserves the old file and removes staging on publication failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-custody-"))
    const path = join(root, "key")
    await writeFile(path, "original", { mode: 0o600 })
    const store = await openCredentialBackend({ ...options(), credentialFile: path, publish: async () => { throw new Error("publication failed") } })
    if (store.where !== "file") throw new Error("file required")
    await expect(store.write("replacement")).rejects.toThrow("publication failed")
    expect(await readFile(path, "utf8")).toBe("original")
    expect(await readdir(root)).toEqual(["key"])
  })

  it.each(["read", "write"] as const)("preserves the %s error when closing its descriptor also fails", async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-custody-"))
    const path = join(root, "key")
    if (operation === "read") await writeFile(path, "fixture", { mode: 0o600 })
    const primary = new Error(`${operation} failed`)
    const cleanup = new Error("close failed")
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, operation === "read" ? "readFile" : "writeFile").mockRejectedValueOnce(primary)
      vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); throw cleanup })
      return handle
    })
    const action = operation === "read" ? readPrivateFile(path) : (async () => {
      const store = await openCredentialBackend({ ...options(), credentialFile: path })
      if (store.where !== "file") throw new Error("file required")
      await store.write("replacement")
    })()
    await expect(action).rejects.toMatchObject({ errors: [primary, cleanup], cause: primary })
    expect(await readdir(root)).toEqual(operation === "read" ? ["key"] : [])
  })

  it("reports publication and cleanup failures with the retained staging path", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-custody-"))
    const path = join(root, "key")
    const primary = new Error("publish failed"), cleanup = new Error("unlink denied")
    const store = await openCredentialBackend({ ...options(), credentialFile: path, publish: async () => { throw primary } })
    if (store.where !== "file") throw new Error("file required")
    vi.mocked(unlink).mockRejectedValueOnce(cleanup)
    await expect(store.write("fixture")).rejects.toMatchObject({ errors: [primary, cleanup], cause: primary, message: expect.stringContaining(path) })
    const files = await readdir(root)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^key\..*\.tmp$/u)
  })

  it("keeps native probe failure visible and namespaces every native operation", async () => {
    const accounts: string[] = []
    const values = new Map<string, string>()
    let locked = true
    class Entry {
      constructor(service: string, private account: string) { accounts.push(`${service}:${account}`) }
      getPassword() { if (locked) throw new Error("locked"); return values.get(this.account) ?? null }
      setPassword(value: string) { values.set(this.account, value) }
      deletePassword() { values.delete(this.account) }
    }
    const ring = nativeKeyring({ service: "fixture-service", probeAccount: "probe", load: async () => ({ Entry }) })
    expect(await ring.available()).toBe(false)
    expect(ring.cause?.()?.message).toBe("locked")
    locked = false
    expect(await ring.available()).toBe(true)
    expect(ring.cause?.()).toBeUndefined()
    expect(await ring.get("account")).toBeUndefined()
    await ring.set("account", "value")
    expect(await ring.get("account")).toBe("value")
    await ring.delete("account")
    expect(await ring.get("account")).toBeUndefined()
    expect(accounts.every((account) => account.startsWith("fixture-service:"))).toBe(true)
  })

  it("refuses native module load failure without a fallback", async () => {
    const ring = nativeKeyring({ service: "fixture", probeAccount: "probe", load: async () => { throw "native module unavailable" } })
    await expect(openCredentialBackend(options(ring))).rejects.toThrow("native module unavailable")
    await expect(ring.get("account")).rejects.toBe("native module unavailable")
  })
})
