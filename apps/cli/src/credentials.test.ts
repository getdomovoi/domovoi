import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { CredentialStoreError, openCredentialStore, type PairedDaemon, type Keyring } from "./credentials.js"

const paired: PairedDaemon = {
  endpoint: "ws://127.0.0.1:47831/rpc",
  machineId: `machine-${"a".repeat(32)}`,
  deviceId: `device-${"b".repeat(32)}`,
  token: "t".repeat(43),
}

const memoryKeyring = (): Keyring & { entries: Map<string, string> } => {
  const entries = new Map<string, string>()
  return {
    entries,
    available: async () => true,
    get: async (account) => entries.get(account),
    set: async (account, secret) => { entries.set(account, secret) },
    delete: async (account) => { entries.delete(account) },
  }
}

const absentKeyring: Keyring = {
  available: async () => false,
  get: async () => { throw new Error("no keyring") },
  set: async () => { throw new Error("no keyring") },
  delete: async () => { throw new Error("no keyring") },
}

const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))) })

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "domovoi-cli-credentials-"))
  scratch.push(path)
  return path
}

describe("credential store", () => {
  it("uses the OS keyring when one is present and never writes a file", async () => {
    const keyring = memoryKeyring()
    const home = await directory()
    const store = await openCredentialStore({ keyring, home, warn: () => {} })
    await store.save(paired)
    expect(keyring.entries.size).toBe(1)
    expect(await store.load(paired.endpoint)).toEqual(paired)
    await expect(stat(join(home, "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses rather than silently writing a dotfile when no keyring exists", async () => {
    const home = await directory()
    await expect(openCredentialStore({ keyring: absentKeyring, home, warn: () => {} }))
      .rejects.toBeInstanceOf(CredentialStoreError)
    await expect(openCredentialStore({ keyring: absentKeyring, home, warn: () => {} }))
      .rejects.toThrow(/--credential-file/)
  })

  it("writes an explicit credential file with mode 0600 and says so once", async () => {
    const home = await directory()
    const file = join(home, "cli-credentials.json")
    const warnings: string[] = []
    const store = await openCredentialStore({ keyring: absentKeyring, home, credentialFile: file, warn: (text) => warnings.push(text) })
    await store.save(paired)
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await store.load(paired.endpoint)).toEqual(paired)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/not in an OS keychain/)
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 })
  })

  it("refuses a credential file whose mode lets others read it", async () => {
    if (process.platform === "win32") return
    const home = await directory()
    const file = join(home, "loose.json")
    const { writeFile, chmod } = await import("node:fs/promises")
    await writeFile(file, JSON.stringify({ version: 1, daemons: [] }))
    await chmod(file, 0o644)
    await expect(openCredentialStore({ keyring: absentKeyring, home, credentialFile: file, warn: () => {} }))
      .rejects.toThrow(/mode 0600/)
  })

  it("prefers the explicit file over the keyring when both exist, and still warns", async () => {
    const keyring = memoryKeyring()
    const home = await directory()
    const warnings: string[] = []
    const store = await openCredentialStore({ keyring, home, credentialFile: join(home, "f.json"), warn: (text) => warnings.push(text) })
    await store.save(paired)
    expect(keyring.entries.size).toBe(0)
    expect(warnings).toHaveLength(1)
  })

  it("forgets one daemon and leaves the others", async () => {
    const keyring = memoryKeyring()
    const store = await openCredentialStore({ keyring, home: await directory(), warn: () => {} })
    await store.save(paired)
    await store.save({ ...paired, endpoint: "ws://10.0.0.2:47831/rpc" })
    await store.forget(paired.endpoint)
    expect(await store.load(paired.endpoint)).toBeUndefined()
    expect(await store.load("ws://10.0.0.2:47831/rpc")).toBeDefined()
  })
})
