import { describe, expect, it } from "vitest"

import { parseTailnetReachRecord, tailnetReachEnvironment } from "./tailnet-reach-record.js"

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
    JSON.stringify({ ...record, certPath: "" }),
    JSON.stringify({ ...record, keyPath: "/a\nb" }),
    JSON.stringify({ ...record, keyPath: 7 }),
  ])("refuses anything that is not exactly such a record: %j", (text) => {
    expect(parseTailnetReachRecord(text)).toBeUndefined()
  })
})
