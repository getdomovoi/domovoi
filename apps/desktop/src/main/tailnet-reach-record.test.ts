import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { parseDaemonEnvironment } from "../../../daemon/src/config.js"
import {
  parseTailnetReachRecord,
  savedTailnetReachEnvironment,
  tailnetHostConflict,
  tailnetReachEnvironment,
  tailnetReachRecordFile,
} from "./tailnet-reach-record.js"

describe("the TailnetReach record", () => {
  const record = {
    version: 1, name: "studio.tail4c2e.ts.net", address: "100.101.102.103",
    certPath: "/Users/dana/.domovoi/tls/studio.tail4c2e.ts.net.crt",
    keyPath: "/Users/dana/.domovoi/tls/studio.tail4c2e.ts.net.key",
  } as const

  it("reads a record the switch wrote and gives the daemon its tailnet settings", () => {
    const parsed = parseTailnetReachRecord(JSON.stringify(record))
    expect(parsed).toEqual(record)
    expect(tailnetReachEnvironment(parsed)).toEqual({
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TAILNET_ADDRESS: "100.101.102.103",
      DOMOVOI_TAILNET_TLS_CERT_PATH: record.certPath,
      DOMOVOI_TAILNET_TLS_KEY_PATH: record.keyPath,
      DOMOVOI_TAILNET_HOST: "studio.tail4c2e.ts.net",
    })
  })

  it("gives no settings without a record", () => {
    expect(tailnetReachEnvironment(undefined)).toEqual({})
  })

  it.each([
    "", "{", "null", "[]",
    JSON.stringify({ ...record, version: 2 }),
    JSON.stringify({ ...record, extra: true }),
    JSON.stringify({ ...record, DOMOVOI_AUTH_TOKEN: "x" }),
    JSON.stringify({ ...record, name: "Studio" }),
    JSON.stringify({ ...record, name: "studio.tail4c2e.ts.net." }),
    JSON.stringify({ ...record, name: "../studio" }),
    JSON.stringify({ ...record, address: "100.101.102.103:443" }),
    JSON.stringify({ ...record, address: "0.0.0.0 " }),
    // The daemon refuses these, and a refused setting would stop it starting.
    JSON.stringify({ ...record, address: "192.168.1.20" }),
    JSON.stringify({ ...record, address: "127.0.0.1" }),
    JSON.stringify({ ...record, address: "fd7a:115c:a1e1::1" }),
    JSON.stringify({ ...record, certPath: "relative/studio.crt" }),
    JSON.stringify({ ...record, certPath: "" }),
    JSON.stringify({ ...record, keyPath: "/a\nb" }),
    JSON.stringify({ ...record, keyPath: 7 }),
  ])("refuses anything that is not exactly such a record: %j", (text) => {
    expect(parseTailnetReachRecord(text)).toBeUndefined()
  })

  it("accepts a Tailscale IPv6 address", () => {
    expect(parseTailnetReachRecord(JSON.stringify({ ...record, address: "fd7a:115c:a1e0::1" }))?.address).toBe("fd7a:115c:a1e0::1")
  })

  // Every record the parser accepts is one the daemon's own settings accept,
  // so a saved record never keeps the in-app daemon from starting.
  it.each(["100.101.102.103", "100.64.0.1", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:6265:6667"])("is accepted by the daemon's settings: %s", (address) => {
    const parsed = parseTailnetReachRecord(JSON.stringify({ ...record, address }))
    expect(() => parseDaemonEnvironment(tailnetReachEnvironment(parsed), "/Users/dana")).not.toThrow()
  })
})

describe("the saved TailnetReach settings at startup", () => {
  const record = {
    version: 1, name: "studio.tail4c2e.ts.net", address: "100.101.102.103",
    certPath: "/Users/dana/.domovoi/tls/studio.tail4c2e.ts.net.crt",
    keyPath: "/Users/dana/.domovoi/tls/studio.tail4c2e.ts.net.key",
  }

  async function saved(run: (directory: string) => void | Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-tailnet-record-"))
    try {
      await writeFile(join(directory, tailnetReachRecordFile), JSON.stringify(record))
      await run(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it.each([{}, { DOMOVOI_HOST: "127.0.0.1" }, { DOMOVOI_HOST: "::1" }, { DOMOVOI_HOST: "localhost" }])("gives them to a loopback daemon: %j", async (environment) => {
    await saved((directory) => {
      expect(savedTailnetReachEnvironment(directory, environment)).toMatchObject({ DOMOVOI_TAILNET_ADDRESS: "100.101.102.103" })
      expect(tailnetHostConflict(environment)).toBeUndefined()
    })
  })

  // Q404 follow-up: a hand-set listener beyond loopback already reaches off this
  // machine. The tailnet settings beside it would be refused and stop the
  // daemon starting, so they are left out and the switch says why.
  it.each(["0.0.0.0", "100.101.102.103", "studio.example.com"])("leaves them out beside a hand-set DOMOVOI_HOST of %s, and says why", async (host) => {
    await saved((directory) => {
      expect(savedTailnetReachEnvironment(directory, { DOMOVOI_HOST: host })).toEqual({})
      expect(tailnetHostConflict({ DOMOVOI_HOST: host })).toBe(
        `DOMOVOI_HOST is set to ${host} in this app's environment, so the daemon inside this app listens there and starts without the tailnet listener.`,
      )
    })
  })

  it("gives nothing when no record is saved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-tailnet-record-"))
    try {
      expect(savedTailnetReachEnvironment(directory, {})).toEqual({})
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
