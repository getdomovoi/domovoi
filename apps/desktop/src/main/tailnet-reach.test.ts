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
  conflict?: string
  // A move that fails, as a rename can, leaving both paths as they were.
  failMove?: (from: string, to: string) => boolean
} = {}) {
  const calls: string[] = []
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  let record = options.record
  let temporary = 0
  // Timers are recorded, not run: a test runs the one it wants.
  const timers: { run: () => void; ms: number; cleared: boolean }[] = []
  const deps: TailnetReachDependencies = {
    timers: {
      set: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer },
      clear: (handle) => { (handle as { cleared: boolean }).cleared = true },
    },
    now: () => Date.parse("2026-10-02T12:00:00.000Z"),
    ...(options.conflict ? { conflict: () => options.conflict } : {}),
    recover: vi.fn(async () => { calls.push("recover") }),
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
        if (options.failMove?.(from, to)) throw Object.assign(new Error(`EIO: rename ${from}`), { code: "EIO" })
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
  const pending = () => timers.filter((timer) => !timer.cleared)
  return { reach: new TailnetReach(deps), deps, calls, files, record: () => record, timers: pending }
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

  // Re-review of 10dba4a2 (P2): a name the URL parser would rewrite is not one
  // the switch records, so it never writes a record its own parser refuses.
  it.each(["1.0x0", "127.0x1"])("takes no tailnet name %s that the URL parser rewrites", async (dnsName) => {
    const { reach } = harness({ status: JSON.stringify({ BackendState: "Running", Self: { DNSName: `${dnsName}.`, TailscaleIPs: ["100.101.102.103"] }, CertDomains: [dnsName] }) })
    await expect(reach.status()).resolves.toEqual({ state: "none", detail: "Tailscale gives this computer no tailnet name and address." })
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
      "record write",
      "restart set",
      // Held until the change ends: a failed restart puts files back from it.
      `remove directory ${tls}/.pending-1`,
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

  // Domovoi has no sample of Tailscale's own refusal wording, so it guesses no
  // cause from stderr: the message names the first line, whatever it says.
  it("stores nothing and restarts nothing when Tailscale does not issue the certificate, in Tailscale's first line", async () => {
    const { reach, calls, files, record } = harness({ cert: { code: 1, stderr: "some refusal from the control server.\nsecond line\n" } })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "certificate",
      message: `Tailscale did not issue a certificate for ${name}: some refusal from the control server. Nothing was stored and nothing restarted.`,
      detail: "some refusal from the control server.\nsecond line",
    })
    expect(calls.at(-1)).toBe(`remove directory ${tls}/.pending-1`)
    expect(files.size).toBe(0)
    expect(record()).toBeUndefined()
  })

  it("names the exit code when Tailscale says nothing", async () => {
    const { reach } = harness({ cert: { code: 3, stderr: "" } })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "certificate",
      message: `Tailscale did not issue a certificate for ${name}: tailscale cert exited with 3. Nothing was stored and nothing restarted.`,
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
    const { reach, calls, files } = harness({ record: ours, files: { [certPath]: "old", [keyPath]: "old key" } })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true })
    expect(calls).toContain(`move ${tls}/.pending-1/${name}.crt ${certPath}`)
    expect(files.get(certPath)).toBe(certificate)
    expect([...files.keys()].sort()).toEqual([certPath, keyPath])
  })

  // Review of 049b1383 (P3-b): Tailscale renamed this machine. The new name's
  // files replace the record, and the old name's files go once it works.
  it("removes the previous name's files once the new name's are in use", async () => {
    const oldName = "old-studio.tail4c2e.ts.net"
    const old = { version: 1 as const, name: oldName, address: "100.101.102.103", certPath: `${tls}/${oldName}.crt`, keyPath: `${tls}/${oldName}.key` }
    const { reach, files, record } = harness({ record: old, files: { [old.certPath]: "old certificate", [old.keyPath]: "old key", [`${tls}/kept.crt`]: "kept" } })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true })
    expect(record()).toEqual(ours)
    expect([...files.keys()].sort()).toEqual([certPath, keyPath, `${tls}/kept.crt`].sort())
  })

  it("keeps the previous name's files when the new name's restart fails", async () => {
    const oldName = "old-studio.tail4c2e.ts.net"
    const old = { version: 1 as const, name: oldName, address: "100.101.102.103", certPath: `${tls}/${oldName}.crt`, keyPath: `${tls}/${oldName}.key` }
    const { reach, files, record } = harness({ record: old, files: { [old.certPath]: "old certificate", [old.keyPath]: "old key" }, restart: { ok: false, message: "The daemon did not start again." } })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: false, step: "restart" })
    expect(record()).toEqual(old)
    expect([...files.keys()].sort()).toEqual([old.certPath, old.keyPath].sort())
  })

  // Re-review of 10dba4a2 (P3-1): a failed move partway must not delete a file
  // still in use, and a put-back that fails must not delete the only copy.
  it("deletes only what it moved in when setting the key aside fails", async () => {
    const { reach, files, record, deps } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      failMove: (from, to) => from === keyPath && to.endsWith("/previous.key"),
    })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: false, reason: "failed", step: "store" })
    expect(files.get(certPath)).toBe("old certificate")
    expect(files.get(keyPath)).toBe("old key")
    expect(record()).toEqual(ours)
    expect(deps.restart).not.toHaveBeenCalled()
  })

  it("keeps the pending directory and says where the previous files are when putting them back fails", async () => {
    const { reach, files, calls } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      restart: { ok: false, message: "The daemon did not start again." },
      failMove: (from) => from.endsWith("/previous.crt"),
    })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "restart",
      message: "The daemon did not start again. The previous certificate and key could not be put back and are in ~/.domovoi/tls/.pending-1.",
    })
    expect(files.get(`${tls}/.pending-1/previous.crt`)).toBe("old certificate")
    expect(calls).not.toContain(`remove directory ${tls}/.pending-1`)
  })

  it("does the same when a renewal check cannot put the previous files back", async () => {
    const { reach, files, calls } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      restart: { ok: false, message: "The daemon did not start again." },
      failMove: (from) => from.endsWith("/previous.crt"),
    })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(`${tls}/.pending-1/previous.crt`)).toBe("old certificate")
    expect(calls).not.toContain(`remove directory ${tls}/.pending-1`)
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: "A new certificate is ready, but the daemon did not restart: The daemon did not start again. The previous certificate and key could not be put back and are in ~/.domovoi/tls/.pending-1.",
    } })
  })

  // Review of 049b1383 (P2-2): Renew now while on runs this path. A restart
  // that fails must not take the working certificate, or the switch, with it.
  it("puts the working certificate and record back when a renewal's restart fails, and stays on", async () => {
    const { reach, files, record, calls } = harness({ record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" }, restart: { ok: false, message: "The daemon did not start again." } })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "restart",
      message: "The daemon did not start again. The previous certificate was put back, and the switch stays on.",
    })
    expect(files.get(certPath)).toBe("old certificate")
    expect(files.get(keyPath)).toBe("old key")
    expect(record()).toEqual(ours)
    expect(calls).toContain("recover")
    expect(calls).not.toContain("record remove")
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

// Q404 follow-up: a hand-set DOMOVOI_HOST beyond loopback keeps the saved
// settings out of the in-app daemon (tailnet-reach-record.ts). The switch says
// so rather than claim the daemon answers on the tailnet.
describe("TailnetReach beside a hand-set DOMOVOI_HOST", () => {
  const conflict = "DOMOVOI_HOST is set to 0.0.0.0 in this app's environment, so the daemon inside this app listens there and starts without the tailnet listener."

  it("reports the switch on with the reason its settings are not used", async () => {
    const { reach } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, conflict })
    await expect(reach.status()).resolves.toMatchObject({ state: "on", ignored: conflict })
  })

  it("reports the switch off with the same reason", async () => {
    const { reach } = harness({ conflict })
    await expect(reach.status()).resolves.toMatchObject({ state: "off", ignored: conflict })
  })

  it("does not turn on, and asks Tailscale for nothing", async () => {
    const { reach, calls } = harness({ conflict })
    await expect(reach.turnOn()).resolves.toEqual({ ok: false, reason: "refused", step: "status", message: `${conflict} Nothing was changed.` })
    expect(calls).toEqual([])
  })

  it("still turns off, deleting its own files", async () => {
    const { reach, files } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, conflict })
    await expect(reach.turnOff()).resolves.toMatchObject({ ok: true })
    expect(files.size).toBe(0)
  })
})

// Q404 follow-up: "Renews on its own." While the switch is on, the desktop
// runs `tailscale cert --min-validity 720h` every 12 hours, the first time a
// minute after the module loads. Tailscale returns the certificate it holds
// unless that one is valid for less than 30 days, so a Let's Encrypt
// certificate (90 days) is replaced about 30 days before it expires, with up
// to 30 days of failed tries before it lapses. A failure is tried again after
// an hour.
describe("TailnetReach renewal", () => {
  const renewedCall = `tailscale cert --cert-file ${tls}/.pending-1/${name}.crt --key-file ${tls}/.pending-1/${name}.key --min-validity 720h ${name}`

  it("checks a minute after it starts while the switch is on, then every 12 hours", async () => {
    const { reach, timers } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" } })
    await reach.startRenewal()
    expect(timers().map((timer) => timer.ms)).toEqual([60_000])
    await expect(reach.renew()).resolves.toBe("unchanged")
    expect(timers().map((timer) => timer.ms)).toEqual([12 * 60 * 60_000])
  })

  it("does not schedule anything while the switch is off", async () => {
    const { reach, timers, calls } = harness()
    await reach.startRenewal()
    expect(timers()).toEqual([])
    await expect(reach.renew()).resolves.toBe("off")
    expect(calls).toEqual([])
  })

  it("leaves its files and the daemon alone when Tailscale returns the same certificate", async () => {
    const { reach, calls, deps } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" } })
    await expect(reach.renew()).resolves.toBe("unchanged")
    expect(calls).toEqual([`directory ${tls}/.pending-1`, renewedCall, `remove directory ${tls}/.pending-1`])
    expect(deps.restart).not.toHaveBeenCalled()
  })

  it("replaces only its own files and restarts once when the certificate changed", async () => {
    const { reach, calls, files, deps } = harness({ record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key", [`${tls}/other.crt`]: "kept" } })
    await expect(reach.renew()).resolves.toBe("renewed")
    expect(calls).toEqual([
      `directory ${tls}/.pending-1`,
      renewedCall,
      "preflight",
      `move ${certPath} ${tls}/.pending-1/previous.crt`,
      `move ${keyPath} ${tls}/.pending-1/previous.key`,
      `move ${tls}/.pending-1/${name}.crt ${certPath}`,
      `move ${tls}/.pending-1/${name}.key ${keyPath}`,
      `restrict ${keyPath}`,
      "restart set",
      `remove directory ${tls}/.pending-1`,
    ])
    expect(deps.restart).toHaveBeenCalledWith({ set: { address: "100.101.102.103", name, certPath, keyPath } })
    expect(files.get(certPath)).toBe(certificate)
    expect(files.get(`${tls}/other.crt`)).toBe("kept")
    await expect(reach.status()).resolves.not.toHaveProperty("renewalFailed")
  })

  it("keeps the old certificate and says so when Tailscale does not renew it, then tries again in an hour", async () => {
    const { reach, files, timers, deps } = harness({ record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" }, cert: { code: 1, stderr: "tailscaled did not answer\n" } })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    expect(deps.restart).not.toHaveBeenCalled()
    await expect(reach.status()).resolves.toMatchObject({
      state: "on",
      renewalFailed: { at: "2026-10-02T12:00:00.000Z", message: `Tailscale did not renew the certificate for ${name}: tailscaled did not answer.` },
    })
    expect(timers().map((timer) => timer.ms)).toEqual([60 * 60_000])
  })

  it("keeps the old certificate while the daemon cannot restart", async () => {
    const { reach, files, deps } = harness({ record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" }, preflight: "1 turn is running (Fix login)." })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    expect(deps.restart).not.toHaveBeenCalled()
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: "A new certificate is ready, but the daemon cannot restart now: 1 turn is running (Fix login). The current certificate stays until the next try.",
    } })
  })

  it("puts the old certificate back and starts the daemon as it was when the restart fails", async () => {
    const { reach, files, calls } = harness({ record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" }, restart: { ok: false, message: "The daemon did not start again." } })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    expect(files.get(keyPath)).toBe("old key")
    expect(calls.slice(-5)).toEqual([
      `move ${tls}/.pending-1/previous.crt ${certPath}`,
      `move ${tls}/.pending-1/previous.key ${keyPath}`,
      `restrict ${keyPath}`,
      "recover",
      `remove directory ${tls}/.pending-1`,
    ])
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: "A new certificate is ready, but the daemon did not restart: The daemon did not start again. The previous certificate was put back.",
    } })
  })

  it("stops when the switch is turned off, and a new turn-on starts again", async () => {
    const { reach, timers } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" } })
    await reach.startRenewal()
    await reach.turnOff()
    expect(timers()).toEqual([])
    await reach.turnOn()
    expect(timers().map((timer) => timer.ms)).toEqual([12 * 60 * 60_000])
  })

  it("waits while the switch is changing", async () => {
    const { reach, timers } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" } })
    const changing = reach.turnOff()
    await expect(reach.renew()).resolves.toBe("busy")
    await changing
    expect(timers()).toEqual([])
  })
})
