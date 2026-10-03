import { describe, expect, it, vi } from "vitest"

import { generateKeyPairSync } from "node:crypto"

import type { TailnetListenerStatus } from "@getdomovoi/protocol"

import type { TailnetReachRecord } from "./tailnet-reach-record.js"
import { TailnetReach, tailnetMaterialCheck, type TailnetReachDependencies } from "./tailnet-reach.js"

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
const recordPath = "/Users/dana/Library/Application Support/Domovoi/tailnet-reach.json"
const running = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: `${name}.`, TailscaleIPs: ["fd7a:115c:a1e0::1", "100.101.102.103"] },
  CertDomains: [name],
})
// The fake gives a file the identity <path>#mark, as if the switch had marked
// it there, unless a test names another (a file the switch did not write).
// The expiry the fake checks give every issued certificate.
const issuedNotAfter = "2026-12-20T04:12:00.000Z"
const ours: TailnetReachRecord = { version: 1, name, address: "100.101.102.103", certPath, keyPath, certIdentity: `${certPath}#mark`, keyIdentity: `${keyPath}#mark` }

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
  // A move that renames, then fails, as publishFileDurably does when the
  // directory flush after the rename fails.
  failAfterRename?: (from: string, to: string) => boolean
  // Files that can be neither deleted nor moved away, as an immutable file
  // cannot.
  immovable?: string[]
  // Deleting the record fails.
  recordRemoveThrows?: Error
  // The restart throws instead of answering, as a service module that fails
  // to load does.
  restartThrows?: Error
  // tailscale cert exits 0 and writes nothing.
  certWritesNothing?: boolean
  handSet?: string
  // Making the pending directory fails, as mkdir does on a full disk.
  privateDirectoryThrows?: Error
  // Removing a pending directory fails, leaving what is in it.
  removeDirectoryThrows?: Error
  // Reading the notes for the switch's state throws.
  notesThrow?: Error
  // The directory the sweep at load left because it holds previous files.
  setAside?: string
  // Identities other than the switch's mark, for files someone else wrote.
  identities?: Record<string, string>
  // Why the issued certificate and key fail the checks before they are used.
  invalid?: string
  // What tailnet.status answers after a restart, or what reading it throws.
  // Default: listening, with the issued certificate's expiry.
  listener?: TailnetListenerStatus | Error
} = {}) {
  const calls: string[] = []
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const identities = new Map<string, string>(Object.entries(options.identities ?? {}))
  const marked: string[] = []
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
    ...(options.handSet ? { handSet: () => options.handSet } : {}),
    ...(options.notesThrow ? { setAside: async () => { throw options.notesThrow } } : {}),
    ...(options.setAside ? { setAside: async () => options.setAside } : {}),
    recover: vi.fn(async () => { calls.push("recover") }),
    tailscale: vi.fn(async (args: readonly string[]) => {
      calls.push(`tailscale ${args.join(" ")}`)
      if (args[0] === "status") {
        const status = options.status ?? running
        if (status === "missing") return "missing" as const
        return typeof status === "string" ? { code: 0, stdout: status, stderr: "" } : { code: status.code, stdout: "", stderr: status.stderr }
      }
      if (options.cert) return { code: options.cert.code, stdout: "", stderr: options.cert.stderr }
      if (options.certWritesNothing) return { code: 0, stdout: "", stderr: "" }
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
        if (options.privateDirectoryThrows) throw options.privateDirectoryThrows
        return path
      },
      move: async (from, to, renamed) => {
        calls.push(`move ${from} ${to}`)
        if (options.failMove?.(from, to)) throw Object.assign(new Error(`EIO: rename ${from}`), { code: "EIO" })
        if (options.immovable?.includes(from)) throw Object.assign(new Error(`EPERM: rename ${from}`), { code: "EPERM" })
        if (!files.has(from)) throw Object.assign(new Error(`ENOENT: rename ${from}`), { code: "ENOENT" })
        files.set(to, files.get(from)!)
        files.delete(from)
        // A rename keeps the file, and so its identity.
        identities.set(to, identities.get(from) ?? `${from}#mark`)
        identities.delete(from)
        renamed?.()
        if (options.failAfterRename?.(from, to)) throw Object.assign(new Error(`EIO: fsync ${to}`), { code: "EIO" })
      },
      restrict: async (path) => { calls.push(`restrict ${path}`) },
      identity: async (path) => files.has(path) ? identities.get(path) ?? `${path}#mark` : undefined,
      mark: async (path) => { marked.push(path); identities.set(path, `${path}#mark`) },
      remove: async (path) => {
        calls.push(`remove ${path}`)
        if (options.immovable?.includes(path)) throw Object.assign(new Error(`EPERM: unlink ${path}`), { code: "EPERM" })
        files.delete(path)
        identities.delete(path)
      },
      removeDirectory: async (path) => {
        calls.push(`remove directory ${path}`)
        if (options.removeDirectoryThrows) throw options.removeDirectoryThrows
        for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file)
      },
    },
    record: {
      path: recordPath,
      read: async () => record,
      write: async (value) => { calls.push("record write"); record = value },
      remove: async () => {
        calls.push("record remove")
        if (options.recordRemoveThrows) throw options.recordRemoveThrows
        record = undefined
      },
    },
    check: vi.fn(() => options.invalid ? { refused: options.invalid } : { notAfter: issuedNotAfter }),
    listener: vi.fn(async () => {
      if (options.listener instanceof Error) throw options.listener
      return options.listener ?? { state: "listening" as const, address: "100.101.102.103", port: 47831, certificateExpiresAt: issuedNotAfter }
    }),
    preflight: vi.fn(async () => { calls.push("preflight"); return options.preflight }),
    restart: vi.fn(async (change) => {
      calls.push(`restart ${"set" in change ? "set" : "clear"}`)
      if (options.restartThrows) throw options.restartThrows
      return options.restart ?? { ok: true as const }
    }),
  }
  const pending = () => timers.filter((timer) => !timer.cleared)
  return { reach: new TailnetReach(deps), deps, calls, files, marked, record: () => record, timers: pending }
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
    const old = { version: 1 as const, name: oldName, address: "100.101.102.103", certPath: `${tls}/${oldName}.crt`, keyPath: `${tls}/${oldName}.key`, certIdentity: `${tls}/${oldName}.crt#mark`, keyIdentity: `${tls}/${oldName}.key#mark` }
    const { reach, files, record } = harness({ record: old, files: { [old.certPath]: "old certificate", [old.keyPath]: "old key", [`${tls}/kept.crt`]: "kept" } })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true })
    expect(record()).toEqual(ours)
    expect([...files.keys()].sort()).toEqual([certPath, keyPath, `${tls}/kept.crt`].sort())
  })

  // Codex review round 1 (P2-4): a record is no proof the files at its paths
  // are the switch's. The switch marks each file it writes and records its
  // device, inode and mark; a file that does not carry them is someone
  // else's, and is never replaced or deleted.
  it("records the identity of each file it wrote", async () => {
    const { reach, marked, record } = harness()
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true })
    expect(marked).toEqual([certPath, keyPath])
    expect(record()).toEqual(ours)
  })

  it("deletes nothing it cannot show it wrote when turned off", async () => {
    const { reach, files, record, deps } = harness({
      record: ours, files: { [certPath]: "someone's certificate", [keyPath]: "someone's key" }, identities: { [keyPath]: "16777232:9:1700000000000" },
    })
    await expect(reach.turnOff()).resolves.toEqual({
      ok: false, reason: "refused", step: "delete",
      message: `~/.domovoi/tls/${name}.key is not the file the switch wrote. Domovoi deletes only files it wrote, so nothing was deleted and the switch stays on. Move that file away, then turn the switch off again.`,
    })
    expect([...files.keys()].sort()).toEqual([certPath, keyPath])
    expect(record()).toEqual(ours)
    expect(deps.restart).not.toHaveBeenCalled()
  })

  it("renews over nothing it cannot show it wrote", async () => {
    const { reach, files, deps } = harness({
      record: ours, files: { [certPath]: "someone's certificate", [keyPath]: "someone's key" }, identities: { [certPath]: "16777232:9:1700000000000" },
    })
    await expect(reach.renew()).resolves.toBe("failed")
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: `~/.domovoi/tls/${name}.crt is not the file the switch wrote, so Domovoi does not renew over it.`,
    } })
    expect(files.get(certPath)).toBe("someone's certificate")
    expect(deps.restart).not.toHaveBeenCalled()
  })

  it("replaces nothing it cannot show it wrote when turned on again", async () => {
    const { reach, files } = harness({
      record: ours, files: { [certPath]: "someone's certificate", [keyPath]: "someone's key" }, identities: { [certPath]: "16777232:9:1700000000000" },
    })
    await expect(reach.turnOn()).resolves.toMatchObject({
      ok: false, reason: "refused", step: "store",
      message: `A file Domovoi did not write is already at ~/.domovoi/tls/${name}.crt. Domovoi does not replace it. Nothing was stored and nothing restarted.`,
    })
    expect(files.get(certPath)).toBe("someone's certificate")
  })

  it("records the renewed files and puts the record back when the restart fails", async () => {
    const { reach, calls, record } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" }, restart: { ok: false, message: "The daemon did not start again." },
    })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(calls.filter((call) => call === "record write")).toHaveLength(2)
    expect(calls.indexOf("record write")).toBeLessThan(calls.indexOf("restart set"))
    expect(record()).toEqual(ours)
  })

  // Codex review round 1 (P2-5): a certificate Tailscale handed back is
  // checked before it replaces anything, and a restart counts only once the
  // daemon says it serves the new certificate on the tailnet.
  it("stores nothing when the issued certificate fails the checks", async () => {
    const { reach, files, record, deps } = harness({ invalid: "it expired on 2025-01-02." })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "certificate",
      message: `Tailscale's certificate for ${name} was not used: it expired on 2025-01-02. Nothing was stored and nothing restarted.`,
    })
    expect(files.size).toBe(0)
    expect(record()).toBeUndefined()
    expect(deps.restart).not.toHaveBeenCalled()
  })

  it("deletes the new files again when the daemon does not take the certificate on the tailnet", async () => {
    const reason = "The tailnet certificate and key do not belong together, so the daemon answers on this computer only."
    const { reach, files, record, deps } = harness({ listener: { state: "refused", address: "100.101.102.103", reason, retrying: false } })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "restart",
      message: `The daemon did not take the certificate for the tailnet: ${reason} The certificate and key were deleted again, and the switch stays off.`,
    })
    expect(files.size).toBe(0)
    expect(record()).toBeUndefined()
    expect(deps.restart).toHaveBeenLastCalledWith({ clear: true })
  })

  it("keeps the previous name's files when the new name's restart fails", async () => {
    const oldName = "old-studio.tail4c2e.ts.net"
    const old = { version: 1 as const, name: oldName, address: "100.101.102.103", certPath: `${tls}/${oldName}.crt`, keyPath: `${tls}/${oldName}.key`, certIdentity: `${tls}/${oldName}.crt#mark`, keyIdentity: `${tls}/${oldName}.key#mark` }
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

  // Codex review round 1 (P2-1): a move that renamed and then failed has
  // still moved the file. The swap counts it as moved from the rename on, so
  // the working certificate set aside is put back, not deleted with pending.
  it("puts back a certificate whose move aside renamed and then failed", async () => {
    const { reach, files } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      failAfterRename: (from, to) => from === certPath && to.endsWith("/previous.crt"),
    })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    expect(files.get(keyPath)).toBe("old key")
  })

  it("deletes a new certificate whose move in renamed and then failed", async () => {
    const { reach, files, record } = harness({ failAfterRename: (_from, to) => to === certPath })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: false, reason: "failed", step: "store" })
    expect([...files.keys()]).toEqual([])
    expect(record()).toBeUndefined()
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
    // Round 3 re-review (P3-3): the switch keeps saying where they are.
    await expect(reach.status()).resolves.toMatchObject({ state: "on", kept: "~/.domovoi/tls/.pending-1" })
    // Round 4 review (P3-3): until someone moves them.
    files.delete(`${tls}/.pending-1/previous.crt`)
    files.delete(`${tls}/.pending-1/previous.key`)
    await expect(reach.status()).resolves.not.toHaveProperty("kept")
  })

  // Round 4 review (P3-3): the sweep at load cannot tell a put-back that
  // failed from a change cut off before it finished, so a directory it found
  // is named apart from one this session could not empty, and only while it
  // still holds previous files.
  it("names a directory the sweep set aside apart from one this session kept", async () => {
    const aside = `${tls}/.pending-Ab3xYz`
    const { reach, files } = harness({ setAside: aside, files: { [`${aside}/previous.key`]: "old key" } })
    const report = await reach.status()
    expect(report).toMatchObject({ state: "off", setAside: "~/.domovoi/tls/.pending-Ab3xYz" })
    expect(report).not.toHaveProperty("kept")
    files.delete(`${aside}/previous.key`)
    await expect(reach.status()).resolves.not.toHaveProperty("setAside")
  })

  // Round 3 re-review (P2): a throw that is not a failed answer must not skip
  // the put-back, leave renew() rejecting from its timer, or delete the
  // pending directory holding the only copy of the files in use.
  it("puts the files back and says so when a renewal's restart throws", async () => {
    const { reach, files, calls, deps } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      restartThrows: new Error("Cannot find module './daemon-service-assembly.js'"),
    })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    expect(files.get(keyPath)).toBe("old key")
    expect(deps.recover).toHaveBeenCalled()
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: `The certificate for ${name} could not be renewed: Cannot find module './daemon-service-assembly.js' The previous certificate was put back.`,
    } })
    // Put back, so the directory holds nothing of the files in use.
    expect(calls).toContain(`remove directory ${tls}/.pending-1`)
  })

  // Round 4 review (P3-1): the pending directory is made before anything else,
  // and renew runs from a timer, so a full disk must be a recorded failure.
  it("records a renewal whose pending directory cannot be made", async () => {
    const { reach, files, timers } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      privateDirectoryThrows: Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), { code: "ENOSPC" }),
    })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: `The certificate for ${name} could not be renewed: ENOSPC: no space left on device, mkdtemp`,
    } })
    expect(timers().map((timer) => timer.ms)).toEqual([60 * 60_000])
  })

  it("records a renewal whose tailscale cert exits 0 without writing anything", async () => {
    const { reach, files } = harness({ record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" }, certWritesNothing: true })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: { message: `The certificate for ${name} could not be renewed: missing` } })
  })

  it("puts the files and record back when turning on again and the restart throws", async () => {
    const { reach, files, record, calls } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      restartThrows: new Error("Cannot find module './daemon-service-assembly.js'"),
    })
    await expect(reach.turnOn()).resolves.toEqual({
      ok: false, reason: "failed", step: "restart",
      message: "Turning it on stopped: Cannot find module './daemon-service-assembly.js' The previous certificate was put back.",
    })
    expect(files.get(certPath)).toBe("old certificate")
    expect(files.get(keyPath)).toBe("old key")
    expect(record()).toEqual(ours)
    expect(calls).toContain("recover")
  })

  // Round 4 review (P3-2): once the restart succeeded the change is made. A
  // throw while describing it must not undo the files the daemon now uses.
  it("keeps the new files and record when describing a committed turn-on throws", async () => {
    const { reach, files, record, calls } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      notesThrow: new Error("EACCES: permission denied, scandir"),
    })
    await expect(reach.turnOn()).rejects.toThrow("EACCES: permission denied, scandir")
    expect(files.get(certPath)).toBe(certificate)
    expect(files.get(keyPath)).toBe("private key")
    expect(record()).toEqual(ours)
    expect(calls).not.toContain("recover")
    expect(calls).toContain(`remove directory ${tls}/.pending-1`)
  })

  it("leaves nothing stored when a first turn-on's restart throws", async () => {
    const { reach, files, record } = harness({ restartThrows: new Error("Cannot find module './daemon-service-assembly.js'") })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: false, reason: "failed", step: "restart" })
    expect(files.size).toBe(0)
    expect(record()).toBeUndefined()
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
    // Review of PR #713 (P2): set aside first, deleted once the record is gone.
    expect(calls.slice(0, 7)).toEqual([
      "preflight", `directory ${tls}/.pending-1`, `move ${certPath} ${tls}/.pending-1/previous.crt`, `move ${keyPath} ${tls}/.pending-1/previous.key`,
      "record remove", `remove directory ${tls}/.pending-1`, "restart clear",
    ])
    expect(deps.restart).toHaveBeenCalledWith({ clear: true })
    expect([...files.keys()]).toEqual([`${tls}/other.crt`])
    expect(record()).toBeUndefined()
  })

  it("turns off when its files are already gone", async () => {
    const { reach, calls, record } = harness({ record: ours })
    await expect(reach.turnOff()).resolves.toMatchObject({ ok: true })
    expect(calls.slice(0, 3)).toEqual(["preflight", "record remove", "restart clear"])
    expect(record()).toBeUndefined()
  })

  // Review of PR #713 (P2): a turn-off that fails part way leaves the switch
  // on as it was, both files and the record, not one file deleted under a
  // record that still names it.
  it("puts the certificate back when the key cannot be deleted, and stays on", async () => {
    const { reach, deps, files, record } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, immovable: [keyPath] })
    await expect(reach.turnOff()).resolves.toEqual({
      ok: false, reason: "failed", step: "delete",
      message: `~/.domovoi/tls/${name}.key could not be deleted, so the switch stays on.`,
      detail: `EPERM: rename ${keyPath}`,
    })
    expect(Object.fromEntries(files)).toEqual({ [certPath]: certificate, [keyPath]: "key" })
    expect(record()).toEqual(ours)
    expect(deps.restart).not.toHaveBeenCalled()
    await expect(reach.status()).resolves.not.toHaveProperty("kept")
  })

  // Q418 A: the same sentence as for a file, with the record's path.
  it("puts both files back when the record cannot be deleted, and stays on", async () => {
    const refusal = new Error(`EACCES: permission denied, unlink '${recordPath}'`)
    const { reach, deps, files, record } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, recordRemoveThrows: refusal })
    await expect(reach.turnOff()).resolves.toEqual({
      ok: false, reason: "failed", step: "delete",
      message: "~/Library/Application Support/Domovoi/tailnet-reach.json could not be deleted, so the switch stays on.",
      detail: `EACCES: permission denied, unlink '${recordPath}'`,
    })
    expect(Object.fromEntries(files)).toEqual({ [certPath]: certificate, [keyPath]: "key" })
    expect(record()).toEqual(ours)
    expect(deps.restart).not.toHaveBeenCalled()
    await expect(reach.status()).resolves.toMatchObject({ state: "on" })
  })

  it("says the record could not be deleted when its files are already gone", async () => {
    const { reach, deps, record } = harness({ record: ours, recordRemoveThrows: new Error("EACCES: permission denied") })
    await expect(reach.turnOff()).resolves.toEqual({
      ok: false, reason: "failed", step: "delete",
      message: "~/Library/Application Support/Domovoi/tailnet-reach.json could not be deleted, so the switch stays on.",
      detail: "EACCES: permission denied",
    })
    expect(record()).toEqual(ours)
    expect(deps.restart).not.toHaveBeenCalled()
  })

  // Q417 A: the record is gone and the switch is off, but the files set aside
  // are still in pending. The switch's state says so at once, until they go.
  it("says where the files are when the pending directory cannot be removed after the record is gone", async () => {
    const { reach, files, record, deps } = harness({
      record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, removeDirectoryThrows: new Error("EIO: rmdir"),
    })
    await expect(reach.turnOff()).resolves.toEqual({ ok: true, report: expect.objectContaining({ state: "off", undeleted: "~/.domovoi/tls/.pending-1" }) })
    expect(record()).toBeUndefined()
    expect(deps.restart).toHaveBeenCalledWith({ clear: true })
    expect(files.get(`${tls}/.pending-1/previous.crt`)).toBe(certificate)
    await expect(reach.status()).resolves.toMatchObject({ state: "off", undeleted: "~/.domovoi/tls/.pending-1" })
    expect((await reach.status())).not.toHaveProperty("kept")
    // Gone, by hand or otherwise: the line goes too.
    files.delete(`${tls}/.pending-1/previous.crt`)
    files.delete(`${tls}/.pending-1/previous.key`)
    await expect(reach.status()).resolves.not.toHaveProperty("undeleted")
  })

  it("does not name the same directory as one found at load", async () => {
    const { reach } = harness({
      record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, removeDirectoryThrows: new Error("EIO: rmdir"), setAside: `${tls}/.pending-1`,
    })
    await reach.turnOff()
    const report = await reach.status()
    expect(report).toMatchObject({ undeleted: "~/.domovoi/tls/.pending-1" })
    expect(report).not.toHaveProperty("setAside")
  })

  it("says where the certificate is when it cannot be put back either", async () => {
    const { reach, files, record } = harness({
      record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, immovable: [keyPath],
      failMove: (from) => from === `${tls}/.pending-1/previous.crt`,
    })
    await expect(reach.turnOff()).resolves.toMatchObject({
      ok: false, reason: "failed", step: "delete", message: `~/.domovoi/tls/${name}.key could not be deleted, so the switch stays on.`,
    })
    expect(files.get(`${tls}/.pending-1/previous.crt`)).toBe(certificate)
    expect(record()).toEqual(ours)
    await expect(reach.status()).resolves.toMatchObject({ state: "on", kept: "~/.domovoi/tls/.pending-1" })
  })

  it("deletes nothing when it cannot set the files aside", async () => {
    const { reach, files, record } = harness({ record: ours, files: { [certPath]: certificate, [keyPath]: "key" }, privateDirectoryThrows: new Error("ENOSPC: no space left on device") })
    await expect(reach.turnOff()).resolves.toEqual({
      ok: false, reason: "failed", step: "delete",
      message: `~/.domovoi/tls/${name}.crt could not be deleted, so the switch stays on.`,
      detail: "ENOSPC: no space left on device",
    })
    expect(Object.fromEntries(files)).toEqual({ [certPath]: certificate, [keyPath]: "key" })
    expect(record()).toEqual(ours)
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

  it("carries a hand-set listener's line with the switch off or on", async () => {
    const handSet = "The tailnet listener comes from DOMOVOI_TAILNET_ADDRESS set by hand in this app's environment, and the switch cannot clear it."
    await expect(harness({ handSet }).reach.status()).resolves.toMatchObject({ state: "off", handSet })
    await expect(harness({ handSet, record: ours, files: { [certPath]: certificate, [keyPath]: "key" } }).reach.status()).resolves.toMatchObject({ state: "on", handSet })
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
      // Codex review round 1 (P2-4): the new files' identities.
      "record write",
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
    expect(calls.slice(-6)).toEqual([
      `move ${tls}/.pending-1/previous.crt ${certPath}`,
      `move ${tls}/.pending-1/previous.key ${keyPath}`,
      `restrict ${keyPath}`,
      // Codex review round 1 (P2-4): the previous files' identities again.
      "record write",
      "recover",
      `remove directory ${tls}/.pending-1`,
    ])
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: "A new certificate is ready, but the daemon did not restart: The daemon did not start again. The previous certificate was put back.",
    } })
  })

  // Codex review round 1 (P2-5): a loopback restart is not proof the daemon
  // took the new certificate. Until tailnet.status says it serves it, the
  // previous pair stays in pending, and goes back if the daemon refused it.
  it("replaces nothing with a certificate that fails the checks", async () => {
    const { reach, files, deps } = harness({ record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" }, invalid: "the key does not belong to it." })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    expect(deps.restart).not.toHaveBeenCalled()
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: `Tailscale's new certificate for ${name} was not used: the key does not belong to it. The current certificate stays.`,
    } })
  })

  it("puts the previous pair back and restarts on it when the daemon refuses the new one", async () => {
    const reason = "The tailnet certificate and key do not belong together, so the daemon answers on this computer only."
    const { reach, files, record, deps } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      listener: { state: "refused", address: "100.101.102.103", reason, retrying: false, certificateExpiresAt: issuedNotAfter },
    })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    expect(files.get(keyPath)).toBe("old key")
    expect(record()).toEqual(ours)
    expect(deps.restart).toHaveBeenCalledTimes(2)
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: `The daemon did not take the new certificate for the tailnet: ${reason} The previous certificate was put back.`,
    } })
  })

  it("keeps a new certificate the daemon took while the tailnet address is not up yet", async () => {
    const { reach, files } = harness({
      record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" },
      listener: { state: "refused", address: "100.101.102.103", reason: "The tailnet address 100.101.102.103 is not on this machine (EADDRNOTAVAIL).", retrying: true, certificateExpiresAt: issuedNotAfter },
    })
    await expect(reach.renew()).resolves.toBe("renewed")
    expect(files.get(certPath)).toBe(certificate)
  })

  it("puts the previous pair back when the daemon cannot say whether it took the new one", async () => {
    const { reach, files } = harness({ record: ours, files: { [certPath]: "old certificate", [keyPath]: "old key" }, listener: new Error("No reply to tailnet.status") })
    await expect(reach.renew()).resolves.toBe("failed")
    expect(files.get(certPath)).toBe("old certificate")
    await expect(reach.status()).resolves.toMatchObject({ renewalFailed: {
      message: "Domovoi could not confirm that the daemon took the new certificate for the tailnet (No reply to tailnet.status). The previous certificate was put back.",
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

// Codex review round 1 (P2-5): the checks a certificate and key Tailscale
// handed back pass before the switch uses them.
describe("the checks before an issued certificate is used", () => {
  const before = Date.parse("2025-01-01T12:00:00Z")

  // A pair that passes every check is in tailnet-reach-assembly.test.ts,
  // made with openssl; this fixture's own key was not kept.
  it("refuses a key that does not belong to the certificate", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    expect(tailnetMaterialCheck(Buffer.from(certificate), Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string), name, before))
      .toEqual({ refused: "the key does not belong to it." })
  })

  it.each([
    ["an unreadable certificate", "-----BEGIN CERTIFICATE-----\nnot one\n-----END CERTIFICATE-----\n", name, before, "it is not a certificate Domovoi can read."],
    ["an expired certificate", certificate, name, Date.parse("2026-10-02T00:00:00Z"), "it expired on 2025-01-02."],
    ["another name", certificate, "other.tail4c2e.ts.net", before, "it is not for other.tail4c2e.ts.net."],
  ])("refuses %s", (_label, cert, forName, now, refused) => {
    expect(tailnetMaterialCheck(Buffer.from(cert), Buffer.from("private key"), forName, now)).toEqual({ refused })
  })

  it("refuses a key that cannot be read", () => {
    expect(tailnetMaterialCheck(Buffer.from(certificate), Buffer.from("private key"), name, before)).toEqual({ refused: "the key could not be read." })
  })
})
