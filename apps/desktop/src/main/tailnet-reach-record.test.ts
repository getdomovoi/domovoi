import { execFile } from "node:child_process"
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { parseDaemonEnvironment } from "../../../daemon/src/config.js"
import {
  parseTailnetReachRecord,
  savedTailnetReachEnvironment,
  tailnetHostConflict,
  tailnetReachEnvironment,
  tailnetReachRecordFile,
  tailnetTlsDirectory,
} from "./tailnet-reach-record.js"

const home = "/Users/dana"
const tls = "/Users/dana/.domovoi/tls"
const name = "studio.tail4c2e.ts.net"
const record = {
  version: 1, name, address: "100.101.102.103", certPath: `${tls}/${name}.crt`, keyPath: `${tls}/${name}.key`,
  certIdentity: "16777232:48213377:1104537600000", keyIdentity: "16777232:48213378:1262304000000",
} as const
const text = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...record, ...overrides })

describe("where the switch keeps its certificate", () => {
  it("is tls under the daemon's profile, named as the daemon names it", () => {
    expect(tailnetTlsDirectory({}, home)).toBe(tls)
    expect(tailnetTlsDirectory({ DOMOVOI_PROFILE_DIR: "/srv/domovoi" }, home)).toBe("/srv/domovoi/tls")
    // The daemon refuses a relative profile directory, so there is none.
    expect(tailnetTlsDirectory({ DOMOVOI_PROFILE_DIR: "profile" }, home)).toBeUndefined()
  })
})

describe("the TailnetReach record", () => {
  it("reads a record the switch wrote and gives the daemon its tailnet settings", () => {
    const parsed = parseTailnetReachRecord(text(), tls)
    expect(parsed).toEqual(record)
    expect(tailnetReachEnvironment(parsed)).toEqual({
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TAILNET_ADDRESS: "100.101.102.103",
      DOMOVOI_TAILNET_TLS_CERT_PATH: record.certPath,
      DOMOVOI_TAILNET_TLS_KEY_PATH: record.keyPath,
      DOMOVOI_TAILNET_HOST: name,
    })
  })

  it("gives no settings without a record", () => {
    expect(tailnetReachEnvironment(undefined)).toEqual({})
  })

  it.each([
    ["empty", ""], ["broken JSON", "{"], ["null", "null"], ["an array", "[]"],
    ["another version", text({ version: 2 })],
    ["an extra key", text({ extra: true })],
    ["a credential", text({ DOMOVOI_AUTH_TOKEN: "x" })],
    ["capitals in the name", text({ name: "Studio" })],
    ["a trailing dot", text({ name: `${name}.` })],
    ["a path in the name", text({ name: "../studio" })],
    ["no dot in the name", text({ name: "studio", certPath: `${tls}/studio.crt`, keyPath: `${tls}/studio.key` })],
    // Review of 049b1383 (P2-1): these passed and made the daemon refuse to start.
    ["a loopback address for a name", text({ name: "127.0.0.1", certPath: `${tls}/127.0.0.1.crt`, keyPath: `${tls}/127.0.0.1.key` })],
    ["a wildcard address for a name", text({ name: "0.0.0.0", certPath: `${tls}/0.0.0.0.crt`, keyPath: `${tls}/0.0.0.0.key` })],
    ["a Tailscale address for a name", text({ name: "100.101.102.103", certPath: `${tls}/100.101.102.103.crt`, keyPath: `${tls}/100.101.102.103.key` })],
    ["an IPv4 tail on the address", text({ address: "fd7a:115c:a1e0::1.2.3.4" })],
    ["a zone on the address", text({ address: "fd7a:115c:a1e0::1%utun3" })],
    ["a port on the address", text({ address: "100.101.102.103:443" })],
    ["a LAN address", text({ address: "192.168.1.20" })],
    ["a loopback address", text({ address: "127.0.0.1" })],
    ["another IPv6 range", text({ address: "fd7a:115c:a1e1::1" })],
    // Only the files the switch writes: <profile>/tls/<name>.crt and .key.
    ["a certificate anywhere else", text({ certPath: "/etc/passwd" })],
    ["a key anywhere else", text({ keyPath: "/Users/dana/.ssh/id_ed25519" })],
    ["another name's certificate", text({ certPath: `${tls}/other.tail4c2e.ts.net.crt` })],
    ["a path that leaves the directory", text({ certPath: `${tls}/../${name}.crt` })],
    ["the key in the certificate's place", text({ certPath: record.keyPath, keyPath: record.certPath })],
    ["a relative path", text({ certPath: `tls/${name}.crt` })],
    ["a number for a path", text({ keyPath: 7 })],
    // Codex review round 1 (P2-4): the identity of each file the switch wrote.
    ["no certificate identity", text({ certIdentity: undefined })],
    ["no key identity", text({ keyIdentity: undefined })],
    ["an identity that is not device, inode and time", text({ certIdentity: "../x" })],
    ["a number for an identity", text({ keyIdentity: 7 })],
  ])("refuses %s", (_label, value) => {
    expect(parseTailnetReachRecord(value, tls)).toBeUndefined()
  })

  // Re-review of 10dba4a2 (P2): names the URL parser reads as another host.
  // The first three stopped the in-app daemon; 1.0x0 advertised 1.0.0.0.
  it.each(["0.0x0", "127.0x1", "a.0x7f000001", "1.0x0", "0x7f.0.0.1", "studio.0x10"])("refuses the rewritten name %s, as the daemon does", (probe) => {
    expect(parseTailnetReachRecord(text({ name: probe, certPath: `${tls}/${probe}.crt`, keyPath: `${tls}/${probe}.key` }), tls)).toBeUndefined()
    expect(() => parseDaemonEnvironment({ ...tailnetReachEnvironment(record), DOMOVOI_TAILNET_HOST: probe }, home)).toThrow("DOMOVOI_TAILNET_HOST")
  })

  // Every name the parser accepts is one the daemon's settings accept.
  it.each([name, "a.b", "x-1.tail4c2e.ts.net", "studio.0x1g", "0a.b1c"])("accepts %s only if the daemon does", (candidate) => {
    const parsed = parseTailnetReachRecord(text({ name: candidate, certPath: `${tls}/${candidate}.crt`, keyPath: `${tls}/${candidate}.key` }), tls)
    if (parsed) expect(() => parseDaemonEnvironment(tailnetReachEnvironment(parsed), home)).not.toThrow()
  })

  it("accepts a Tailscale IPv6 address", () => {
    expect(parseTailnetReachRecord(text({ address: "fd7a:115c:a1e0::1" }), tls)?.address).toBe("fd7a:115c:a1e0::1")
  })

  // Every record the parser accepts is one the daemon's own settings accept,
  // so a saved record never keeps the in-app daemon from starting; and the
  // refused names and addresses above are ones the daemon refuses.
  it.each(["100.101.102.103", "100.64.0.1", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:6265:6667"])("is accepted by the daemon's settings: %s", (address) => {
    const parsed = parseTailnetReachRecord(text({ address }), tls)
    expect(parsed).toBeDefined()
    expect(() => parseDaemonEnvironment(tailnetReachEnvironment(parsed), home)).not.toThrow()
  })

  it.each([
    { DOMOVOI_TAILNET_HOST: "127.0.0.1" }, { DOMOVOI_TAILNET_HOST: "0.0.0.0" }, { DOMOVOI_TAILNET_ADDRESS: "fd7a:115c:a1e0::1.2.3.4" },
  ])("is refused by the daemon too when it carries %j", (override) => {
    expect(() => parseDaemonEnvironment({ ...tailnetReachEnvironment(record), ...override }, home)).toThrow()
  })
})

describe("the saved TailnetReach settings at startup", () => {
  async function saved(run: (directory: string) => void | Promise<void>, value = text()): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-tailnet-record-"))
    try {
      await writeFile(join(directory, tailnetReachRecordFile), value)
      await run(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it.each([{}, { DOMOVOI_HOST: "127.0.0.1" }, { DOMOVOI_HOST: "::1" }, { DOMOVOI_HOST: "localhost" }])("gives them to a loopback daemon: %j", async (environment) => {
    await saved((directory) => {
      expect(savedTailnetReachEnvironment(directory, environment, home)).toMatchObject({ DOMOVOI_TAILNET_ADDRESS: "100.101.102.103" })
      expect(tailnetHostConflict(environment)).toBeUndefined()
    })
  })

  // Q404 follow-up: a hand-set listener beyond loopback already reaches off this
  // machine. The tailnet settings beside it would be refused and stop the
  // daemon starting, so they are left out and the switch says why.
  it.each(["0.0.0.0", "100.101.102.103", "studio.example.com"])("leaves them out beside a hand-set DOMOVOI_HOST of %s, and says why", async (host) => {
    await saved((directory) => {
      expect(savedTailnetReachEnvironment(directory, { DOMOVOI_HOST: host }, home)).toEqual({})
      expect(tailnetHostConflict({ DOMOVOI_HOST: host })).toBe(
        `DOMOVOI_HOST is set to ${host} in this app's environment, so the daemon inside this app listens there and starts without the tailnet listener.`,
      )
    })
  })

  it("leaves out a record written for another profile", async () => {
    await saved((directory) => {
      expect(savedTailnetReachEnvironment(directory, { DOMOVOI_PROFILE_DIR: "/srv/domovoi" }, home)).toEqual({})
    })
  })

  // Codex review round 1 (P2-3): startup reads the record synchronously,
  // before the daemon starts. Only a regular file of at most 4 KiB that is not
  // a link is read, opened without following a link or waiting on a FIFO, so
  // nothing at that path can hold startup; anything else gives no settings.
  it.skipIf(process.platform === "win32")("gives nothing for a record that is a link", async () => {
    await saved(async (directory) => {
      const elsewhere = join(directory, "elsewhere.json")
      await rename(join(directory, tailnetReachRecordFile), elsewhere)
      await symlink(elsewhere, join(directory, tailnetReachRecordFile))
      expect(savedTailnetReachEnvironment(directory, {}, home)).toEqual({})
    })
  })

  it("gives nothing for a record over 4 KiB", async () => {
    await saved((directory) => {
      expect(savedTailnetReachEnvironment(directory, {}, home)).toEqual({})
    }, `${text()}${" ".repeat(4 * 1_024)}`)
  })

  it.skipIf(process.platform === "win32")("gives nothing, without waiting, for a record that is a FIFO", async () => {
    await saved(async (directory) => {
      await rm(join(directory, tailnetReachRecordFile))
      await promisify(execFile)("mkfifo", [join(directory, tailnetReachRecordFile)])
      expect(savedTailnetReachEnvironment(directory, {}, home)).toEqual({})
    })
  })

  it("gives nothing when no record is saved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-tailnet-record-"))
    try {
      expect(savedTailnetReachEnvironment(directory, {}, home)).toEqual({})
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  // index.ts checks for the file by this name before it loads this module, so
  // the module stays out of startup when the switch was never used.
  it("is named where index.ts looks for it", async () => {
    const index = await readFile(join(import.meta.dirname, "index.ts"), "utf8")
    expect(index).toContain(`"${tailnetReachRecordFile}"`)
  })
})
