import { describe, expect, it, vi } from "vitest"

import type { TailnetReachRecord } from "./tailnet-reach-record.js"
import { TailnetReach, type TailnetReachDependencies } from "./tailnet-reach.js"

// TailnetReach (Q404 A), the switch's own steps, with every effect a fake that
// records what it was asked. Nothing here runs Tailscale or touches a profile.

// Generated with openssl for these tests: one name, valid 1 to 2 January 2025.
const certificate = `-----BEGIN CERTIFICATE-----
MIIBaDCCAQ+gAwIBAgIUb1E7VPfk5A/cEdedmwPUr2wbFbowCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWc3R1ZGlvLnRhaWw0YzJlLnRzLm5ldDAeFw0yNTAxMDEwMDAw
MDBaFw0yNTAxMDIwMDAwMDBaMCExHzAdBgNVBAMMFnN0dWRpby50YWlsNGMyZS50
cy5uZXQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATtu/OtBFdZfsoqrzwVyR6+
Kw6di2N0m49ICmgVOyWw2mM98b5/dpL/aMcjKjV28mJyFhULKZzbkwwR2ux0jKDU
oyUwIzAhBgNVHREEGjAYghZzdHVkaW8udGFpbDRjMmUudHMubmV0MAoGCCqGSM49
BAMCA0cAMEQCIHBJbyVY310jQC8iDsLg0sa47JNbC7MgrCe+FFjhZBBeAiBVSgGo
m0csbcFZN38Diwdag5/o/56dxngzn9HR6/RuwQ==
-----END CERTIFICATE-----
`

const name = "studio.tail4c2e.ts.net"
const tls = "/Users/dana/.domovoi/tls"
const certPath = `${tls}/${name}.crt`
const keyPath = `${tls}/${name}.key`
const running = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: `${name}.`, TailscaleIPs: ["fd7a:115c:a1e0::1", "100.101.102.103"] },
  CertDomains: [name],
})
const ours: TailnetReachRecord = { version: 1, name, address: "100.101.102.103", certPath, keyPath }

function harness(options: {
  status?: string | "missing" | { code: number; stderr: string }
  cert?: { code: number; stderr: string }
  record?: TailnetReachRecord
  files?: Record<string, string>
  preflight?: string
  restart?: { ok: false; message: string }
} = {}) {
  const calls: string[] = []
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  let record = options.record
  let temporary = 0
  const deps: TailnetReachDependencies = {
    tailscale: vi.fn(async (args: readonly string[]) => {
      calls.push(`tailscale ${args.join(" ")}`)
      if (args[0] === "status") {
        const status = options.status ?? running
        if (status === "missing") return "missing" as const
        return typeof status === "string" ? { code: 0, stdout: status, stderr: "" } : { code: status.code, stdout: "", stderr: status.stderr }
      }
      if (options.cert) return { code: options.cert.code, stdout: "", stderr: options.cert.stderr }
      files.set(args[2]!, certificate)
      files.set(args[4]!, "private key")
      return { code: 0, stdout: "", stderr: "" }
    }),
    tlsDirectory: tls,
    display: (path) => path.replace("/Users/dana", "~"),
    files: {
      exists: async (path) => files.has(path),
      read: async (path) => {
        const text = files.get(path)
        if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
        return Buffer.from(text)
      },
      privateDirectory: async (parent) => {
        const path = `${parent}/.pending-${++temporary}`
        calls.push(`directory ${path}`)
        return path
      },
      move: async (from, to) => {
        calls.push(`move ${from} ${to}`)
        files.set(to, files.get(from)!)
        files.delete(from)
      },
      restrict: async (path) => { calls.push(`restrict ${path}`) },
      remove: async (path) => { calls.push(`remove ${path}`); files.delete(path) },
      removeDirectory: async (path) => {
        calls.push(`remove directory ${path}`)
        for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file)
      },
    },
    record: {
      read: async () => record,
      write: async (value) => { calls.push("record write"); record = value },
      remove: async () => { calls.push("record remove"); record = undefined },
    },
    preflight: vi.fn(async () => { calls.push("preflight"); return options.preflight }),
    restart: vi.fn(async (change) => { calls.push(`restart ${"set" in change ? "set" : "clear"}`); return options.restart ?? { ok: true as const } }),
  }
  return { reach: new TailnetReach(deps), deps, calls, files, record: () => record }
}

describe("TailnetReach actions from the renderer", () => {
  it("answers status, on and off, and refuses anything else", async () => {
    const { reach, deps } = harness({ status: "missing" })
    await expect(reach.act("status")).resolves.toMatchObject({ state: "none" })
    await expect(reach.act("on")).resolves.toMatchObject({ ok: false, reason: "none" })
    await expect(reach.act("off")).resolves.toMatchObject({ ok: true })
    for (const action of [undefined, "renew", { action: "on" }, "ON", "turnOn"]) {
      await expect(reach.act(action)).rejects.toThrow("Desktop received an invalid tailnet action")
    }
    expect(deps.restart).toHaveBeenCalledTimes(1)
  })
})

describe("TailnetReach status", () => {
  it("says there is no tailnet when Domovoi finds no tailscale command", async () => {
    const { reach } = harness({ status: "missing" })
    await expect(reach.status()).resolves.toEqual({ state: "none", detail: "Domovoi found no tailscale command on this computer." })
  })

  it("says there is no tailnet when Tailscale is not running", async () => {
    const { reach } = harness({ status: JSON.stringify({ BackendState: "Stopped", Self: {} }) })
    await expect(reach.status()).resolves.toEqual({ state: "none", detail: "Tailscale is not running on this computer (Stopped)." })
  })

  it("carries Tailscale's own words when its status fails", async () => {
    const { reach } = harness({ status: { code: 1, stderr: "failed to connect to local tailscaled; it doesn't appear to be running\n" } })
    await expect(reach.status()).resolves.toEqual({ state: "none", detail: "failed to connect to local tailscaled; it doesn't appear to be running" })
  })

  it("reads the tailnet name and IPv4 address and changes nothing while off", async () => {
    const { reach, calls } = harness()
    await expect(reach.status()).resolves.toEqual({
      state: "off", name, address: "100.101.102.103", stored: `~/.domovoi/tls/${name}.crt, .key`, httpsCertificates: true,
    })
    expect(calls).toEqual(["tailscale status --json"])
  })

  it("says when the tailnet has HTTPS certificates off", async () => {
    const { reach } = harness({ status: JSON.stringify({ BackendState: "Running", Self: { DNSName: `${name}.`, TailscaleIPs: ["100.101.102.103"] }, CertDomains: null }) })
    await expect(reach.status()).resolves.toMatchObject({ state: "off", httpsCertificates: false })
  })

  it("reports the switch on from its record, with the stored certificate's expiry", async () => {
    const { reach, calls } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "private key" } })
    await expect(reach.status()).resolves.toEqual({
      state: "on", name, address: "100.101.102.103", stored: `~/.domovoi/tls/${name}.crt, .key`, httpsCertificates: true,
      certificateExpiresAt: "2025-01-02T00:00:00.000Z",
    })
    expect(calls).toEqual([])
  })
})

describe("turning TailnetReach on", () => {
  it("reads the status, asks for the certificate, stores it, records it, then restarts once", async () => {
    const { reach, deps, calls, files, record } = harness()
    const outcome = await reach.turnOn()
    expect(outcome).toEqual({ ok: true, report: expect.objectContaining({ state: "on", name, address: "100.101.102.103" }) })
    expect(calls).toEqual([
      "preflight",
      "tailscale status --json",
      `directory ${tls}/.pending-1`,
      `tailscale cert --cert-file ${tls}/.pending-1/${name}.crt --key-file ${tls}/.pending-1/${name}.key ${name}`,
      `move ${tls}/.pending-1/${name}.crt ${certPath}`,
      `move ${tls}/.pending-1/${name}.key ${keyPath}`,
      `restrict ${keyPath}`,
      `remove directory ${tls}/.pending-1`,
      "record write",
      "restart set",
    ])
    expect(deps.restart).toHaveBeenCalledWith({ set: { address: "100.101.102.103", name, certPath, keyPath } })
    expect(record()).toEqual(ours)
    expect([...files.keys()].sort()).toEqual([certPath, keyPath])
  })

  it("stops before asking for anything while the daemon cannot restart", async () => {
    const { reach, calls } = harness({ preflight: "1 turn is running (Fix login)." })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "refused", step: "status",
      message: "The daemon cannot restart now: 1 turn is running (Fix login). Nothing was changed.",
    })
    expect(calls).toEqual(["preflight"])
  })

  it("stops at the status when there is no tailnet", async () => {
    const { reach, calls } = harness({ status: "missing" })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "none", step: "status", message: "Domovoi found no tailscale command on this computer.",
    })
    expect(calls).toEqual(["preflight", "tailscale status --json"])
  })

  it("does not ask for a certificate the tailnet does not issue, and stores nothing", async () => {
    const { reach, calls } = harness({ status: JSON.stringify({ BackendState: "Running", Self: { DNSName: `${name}.`, TailscaleIPs: ["100.101.102.103"] }, CertDomains: [] }) })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "https-off", step: "certificate", message: "HTTPS certificates are off for tail4c2e.ts.net.",
    })
    expect(calls).toEqual(["preflight", "tailscale status --json"])
  })

  it("stores nothing and restarts nothing when Tailscale does not issue the certificate", async () => {
    const { reach, calls, files, record } = harness({ cert: { code: 1, stderr: "500 Internal Server Error: your Tailscale account does not support getting TLS certs\n" } })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "https-off", step: "certificate", message: "HTTPS certificates are off for tail4c2e.ts.net.",
      detail: "500 Internal Server Error: your Tailscale account does not support getting TLS certs",
    })
    expect(calls.at(-1)).toBe(`remove directory ${tls}/.pending-1`)
    expect(files.size).toBe(0)
    expect(record()).toBeUndefined()
  })

  it("says Tailscale's words when the certificate fails for another reason", async () => {
    const { reach } = harness({ cert: { code: 1, stderr: "context deadline exceeded" } })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "certificate",
      message: `Tailscale did not issue a certificate for ${name}. Nothing was stored and nothing restarted.`,
      detail: "context deadline exceeded",
    })
  })

  it("does not replace a file it did not write", async () => {
    const { reach, calls, files } = harness({ files: { [certPath]: "someone else's certificate" } })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "refused", step: "store",
      message: `A file Domovoi did not write is already at ~/.domovoi/tls/${name}.crt. Domovoi does not replace it. Nothing was stored and nothing restarted.`,
    })
    expect(files.get(certPath)).toBe("someone else's certificate")
    expect(calls).not.toContain("restart set")
    expect(calls.at(-1)).toBe(`remove directory ${tls}/.pending-1`)
  })

  it("renews over its own files", async () => {
    const { reach, calls } = harness({ record: ours, files: { [certPath]: "old", [keyPath]: "old key" } })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true })
    expect(calls).toContain(`move ${tls}/.pending-1/${name}.crt ${certPath}`)
  })

  it("deletes what it stored again when the restart fails, and the switch stays off", async () => {
    const { reach, files, record } = harness({ restart: { ok: false, message: "The daemon did not start again." } })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "restart",
      message: "The daemon did not start again. The certificate and key were deleted again, and the switch stays off.",
    })
    expect(files.size).toBe(0)
    expect(record()).toBeUndefined()
  })

  it("runs one change at a time", async () => {
    const { reach } = harness()
    const first = reach.turnOn()
    await expect(reach.turnOff()).resolves.toEqual({ ok: false, reason: "busy", step: "status", message: "The switch is already changing." })
    await first
  })
})

describe("turning TailnetReach off", () => {
  it("deletes only the files it wrote, forgets them, then restarts on this computer only", async () => {
    const { reach, deps, calls, files, record } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key", [`${tls}/other.crt`]: "kept" } })
    await expect(reach.turnOff()).resolves.toEqual({ ok: true, report: expect.objectContaining({ state: "off" }) })
    expect(calls.slice(0, 5)).toEqual(["preflight", `remove ${certPath}`, `remove ${keyPath}`, "record remove", "restart clear"])
    expect(deps.restart).toHaveBeenCalledWith({ clear: true })
    expect([...files.keys()]).toEqual([`${tls}/other.crt`])
    expect(record()).toBeUndefined()
  })

  it("is refused while the daemon cannot restart, and deletes nothing", async () => {
    const { reach, files } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, preflight: "1 gate is waiting (Fix login)." })
    await expect(reach.turnOff()).resolves.toEqual({
      ok: false, reason: "refused", step: "delete",
      message: "The daemon cannot restart now: 1 gate is waiting (Fix login). Nothing was changed.",
    })
    expect(files.size).toBe(2)
  })

  it("says the files are gone when the restart fails after the delete", async () => {
    const { reach } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, restart: { ok: false, message: "The service did not report ready." } })
    await expect(reach.turnOff()).resolves.toEqual({
      ok: false, reason: "failed", step: "restart",
      message: "The certificate and key were deleted, but the daemon did not restart: The service did not report ready.",
    })
  })
})
