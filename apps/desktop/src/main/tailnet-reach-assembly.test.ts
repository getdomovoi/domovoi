import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTailnetReach } from "./tailnet-reach-assembly.js"
import { savedTailnetReachEnvironment } from "./tailnet-reach-record.js"

// TailnetReach against the real file system and a fake `tailscale` on PATH,
// under a temporary HOME. The real Tailscale is never run: the only place
// Domovoi looks is the fake's directory.

const name = "studio.tail4c2e.ts.net"
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

let root = ""
let home = ""
let bin = ""
let data = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "domovoi-tailnet-reach-"))
  home = join(root, "home")
  bin = join(root, "bin")
  data = join(root, "data")
  await Promise.all([mkdir(home), mkdir(bin), mkdir(data)])
  await writeFile(join(root, "status.json"), JSON.stringify({
    BackendState: "Running", Self: { DNSName: `${name}.`, TailscaleIPs: ["100.101.102.103"] }, CertDomains: [name],
  }))
  await writeFile(join(root, "certificate.pem"), certificate)
  // Answers status from a file and writes the certificate where --cert-file
  // and --key-file say, as tailscale does. Each call is logged. PATH holds
  // only the fake, so the tools it uses are named by their own paths.
  await writeFile(join(bin, "tailscale"), [
    "#!/bin/sh",
    `echo "$@" >> "${join(root, "calls.log")}"`,
    `if [ "$1" = status ]; then /bin/cat "${join(root, "status.json")}"; exit 0; fi`,
    "while [ $# -gt 1 ]; do",
    `  case "$1" in --cert-file) /bin/cp "${join(root, "certificate.pem")}" "$2"; shift 2;; --key-file) printf 'private key' > "$2"; shift 2;; *) shift;; esac`,
    "done",
  ].join("\n"))
  await chmod(join(bin, "tailscale"), 0o755)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function assemble(owned = true, environment: Record<string, string> = {}) {
  // The settings index.ts hands the in-app daemon at its next acquisition,
  // and what they were when the daemon was restarted.
  const settings: Record<string, string>[] = []
  const restartedWith: Record<string, string>[] = []
  const endHandoff = vi.fn()
  const stopOwned = vi.fn(async () => {})
  const restart = vi.fn(async () => {
    restartedWith.push(settings.at(-1) ?? {})
    return { kind: "owned" as const, url: "ws://127.0.0.1:47831/rpc", token: "t" }
  })
  const release = vi.fn()
  const update = vi.fn(async () => ({ ok: true as const, kind: "file" as const, target: "plist", configurationPath: "service.json", daemonRunning: true as const }))
  const reach = createTailnetReach({
    desktopDaemon: {
      current: () => owned ? { kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "t" } : { kind: "attached", owner: "daemon", url: "ws://127.0.0.1:47831/rpc", token: "t" },
      stopOwned, restart, endHandoff,
    },
    daemon: {
      readLocalServiceHandoffRefusal: async () => undefined,
      holdServiceHandoffFence: async () => ({ release }),
    },
    service: async () => ({ update, status: async () => ({ installed: true, running: true, detail: "running" }) }),
    dataDirectory: data,
    home,
    environment: { PATH: bin, ...environment },
    platform: "darwin",
    tailscaleLocations: [],
    applySettings: (next) => { settings.push(next) },
  })
  return { reach, stopOwned, restart, endHandoff, release, update, settings, restartedWith }
}

describe.skipIf(process.platform === "win32")("TailnetReach on this machine's files", () => {
  it("reads the tailnet from tailscale status and changes nothing while off", async () => {
    const { reach } = assemble()
    await expect(reach.status()).resolves.toEqual({
      state: "off", name, address: "100.101.102.103", stored: `~/.domovoi/tls/${name}.crt, .key`, httpsCertificates: true,
    })
    expect(await readFile(join(root, "calls.log"), "utf8")).toBe("status --json\n")
    await expect(stat(join(home, ".domovoi"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("says there is no tailnet when no tailscale command is where Domovoi looks", async () => {
    const reach = createTailnetReach({
      desktopDaemon: { current: () => undefined, stopOwned: async () => {}, restart: async () => ({ kind: "refused", reason: "port-in-use", message: "x" }), endHandoff: () => {} },
      daemon: { readLocalServiceHandoffRefusal: async () => undefined, holdServiceHandoffFence: async () => ({ refusal: "x" }) },
      service: async () => { throw new Error("unused") },
      dataDirectory: data, home, environment: { PATH: join(root, "empty") }, platform: "darwin", tailscaleLocations: [],
    })
    await expect(reach.status()).resolves.toEqual({ state: "none", detail: "Domovoi found no tailscale command on this computer." })
  })

  // Review of 049b1383 (P3-c): a crash while a certificate was being issued
  // leaves a pending directory holding a private key. Loading the module
  // removes the ones Domovoi made, by their name inside <profile>/tls only,
  // and never follows a link.
  it("sweeps pending directories a crash left behind, and nothing else", async () => {
    const tls = join(home, ".domovoi", "tls")
    const outside = join(root, "outside")
    await mkdir(join(tls, ".pending-Ab3xYz"), { recursive: true })
    await writeFile(join(tls, ".pending-Ab3xYz", `${name}.key`), "private key")
    await mkdir(outside)
    await writeFile(join(outside, "keep.txt"), "kept")
    await symlink(outside, join(tls, ".pending-Lnk123"))
    await writeFile(join(tls, ".pending-File12"), "a file")
    await mkdir(join(tls, ".pending-toolongname"))
    await writeFile(join(tls, `${name}.crt`), "kept")
    assemble()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await readdir(tls)).sort()).toEqual([".pending-File12", ".pending-Lnk123", ".pending-toolongname", `${name}.crt`].sort())
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("kept")
  })

  // Re-review of 10dba4a2 (P3-1): a change that could not put the previous
  // files back keeps them in its pending directory and says so; the sweep
  // leaves that one for the person to recover.
  it("leaves a pending directory holding previous files that could not be put back", async () => {
    const tls = join(home, ".domovoi", "tls")
    await mkdir(join(tls, ".pending-Kept12"), { recursive: true })
    await writeFile(join(tls, ".pending-Kept12", "previous.key"), "the only copy")
    const { reach } = assemble()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await readFile(join(tls, ".pending-Kept12", "previous.key"), "utf8")).toBe("the only copy")
    // Round 3 re-review (P3-3): and the switch says where it is.
    await expect(reach.status()).resolves.toMatchObject({ state: "off", kept: "~/.domovoi/tls/.pending-Kept12" })
  })

  // index.ts loads the module at startup only when the switch is on, and the
  // module starts its own renewal checks, so main carries none of that.
  it("starts its renewal checks when created with the switch on, and none when off", async () => {
    const scheduled: number[] = []
    const timers = { set: (_run: () => void, ms: number) => { scheduled.push(ms); return ms }, clear: () => {} }
    const create = () => createTailnetReach({
      desktopDaemon: { current: () => undefined, stopOwned: async () => {}, restart: async () => ({ kind: "refused", reason: "port-in-use", message: "x" }), endHandoff: () => {} },
      daemon: { readLocalServiceHandoffRefusal: async () => undefined, holdServiceHandoffFence: async () => ({ refusal: "x" }) },
      service: async () => { throw new Error("unused") },
      dataDirectory: data, home, environment: { PATH: bin }, platform: "darwin", tailscaleLocations: [], timers,
    })
    create()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scheduled).toEqual([])
    await writeFile(join(data, "tailnet-reach.json"), JSON.stringify({ version: 1, name, address: "100.101.102.103", certPath: join(home, ".domovoi", "tls", `${name}.crt`), keyPath: join(home, ".domovoi", "tls", `${name}.key`) }))
    create()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scheduled).toEqual([60_000])
  })

  it("stores a private certificate and key in the profile, records them for the in-app daemon, and restarts it", async () => {
    const { reach, stopOwned, restart, endHandoff, release, restartedWith } = assemble()
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true, report: { state: "on", name, certificateExpiresAt: "2025-01-02T00:00:00.000Z" } })
    const tls = join(home, ".domovoi", "tls")
    expect(((await stat(tls)).mode & 0o777).toString(8)).toBe("700")
    expect(((await stat(join(tls, `${name}.key`))).mode & 0o777).toString(8)).toBe("600")
    expect(await readFile(join(tls, `${name}.crt`), "utf8")).toBe(certificate)
    const expected = {
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TAILNET_ADDRESS: "100.101.102.103",
      DOMOVOI_TAILNET_TLS_CERT_PATH: join(tls, `${name}.crt`),
      DOMOVOI_TAILNET_TLS_KEY_PATH: join(tls, `${name}.key`),
      DOMOVOI_TAILNET_HOST: name,
    }
    expect(savedTailnetReachEnvironment(data, {}, home)).toEqual(expected)
    // The restarted daemon starts with them.
    expect(restartedWith).toEqual([expected])
    expect(stopOwned).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledOnce()
    expect(endHandoff).toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect((await readFile(join(root, "calls.log"), "utf8")).split("\n")[1]).toMatch(new RegExp(`^cert --cert-file ${tls}/\\.pending-[^ ]+/${name}\\.crt --key-file ${tls}/\\.pending-[^ ]+/${name}\\.key ${name}$`))
  })

  it("deletes only what it wrote when turned off, and forgets the settings", async () => {
    const { reach, restartedWith } = assemble()
    await reach.turnOn()
    const tls = join(home, ".domovoi", "tls")
    await writeFile(join(tls, "kept.crt"), "not Domovoi's")
    await expect(reach.turnOff()).resolves.toMatchObject({ ok: true, report: { state: "off" } })
    await expect(readdir(tls)).resolves.toEqual(["kept.crt"])
    expect(savedTailnetReachEnvironment(data, {}, home)).toEqual({})
    expect(restartedWith.at(-1)).toEqual({})
  })

  it("renews over its own files with --min-validity and restarts once when the certificate changed", async () => {
    const { reach, restart } = assemble()
    await reach.turnOn()
    const tls = join(home, ".domovoi", "tls")
    await expect(reach.renew()).resolves.toBe("unchanged")
    expect(restart).toHaveBeenCalledOnce()
    await writeFile(join(tls, `${name}.crt`), "an older certificate")
    await expect(reach.renew()).resolves.toBe("renewed")
    expect(restart).toHaveBeenCalledTimes(2)
    expect(await readFile(join(tls, `${name}.crt`), "utf8")).toBe(certificate)
    expect(((await stat(join(tls, `${name}.key`))).mode & 0o777).toString(8)).toBe("600")
    await expect(readdir(tls)).resolves.toEqual([`${name}.crt`, `${name}.key`])
    expect((await readFile(join(root, "calls.log"), "utf8")).trim().split("\n").at(-1)).toMatch(new RegExp(`^cert --cert-file \\S+ --key-file \\S+ --min-validity 720h ${name}$`))
    reach.stopRenewal()
  })

  // Q404 follow-up: a hand-set DOMOVOI_HOST beyond loopback keeps the saved
  // settings out of the in-app daemon, which starts without them.
  it("refuses to turn on beside a hand-set DOMOVOI_HOST, and says why in the switch state", async () => {
    const { reach } = assemble(true, { DOMOVOI_HOST: "0.0.0.0" })
    const why = "DOMOVOI_HOST is set to 0.0.0.0 in this app's environment, so the daemon inside this app listens there and starts without the tailnet listener."
    await expect(reach.status()).resolves.toMatchObject({ state: "off", ignored: why })
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: false, reason: "refused", message: `${why} Nothing was changed.` })
  })

  it("does not apply the in-app daemon's DOMOVOI_HOST to the login service", async () => {
    const { reach, update } = assemble(false, { DOMOVOI_HOST: "0.0.0.0" })
    await expect(reach.status()).resolves.not.toHaveProperty("ignored")
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true })
    expect(update).toHaveBeenCalledOnce()
  })

  // Round 3 re-review (P3-2): a tailnet listener set by hand in this app's
  // environment is the in-app daemon's whatever the switch says.
  it("says when the in-app daemon's tailnet listener is set by hand", async () => {
    const handSet = "The tailnet listener comes from DOMOVOI_TAILNET_ADDRESS set by hand in this app's environment, and the switch cannot clear it."
    await expect(assemble(true, { DOMOVOI_TAILNET_ADDRESS: "100.101.102.103" }).reach.status()).resolves.toMatchObject({ state: "off", handSet })
    await expect(assemble(false, { DOMOVOI_TAILNET_ADDRESS: "100.101.102.103" }).reach.status()).resolves.not.toHaveProperty("handSet")
    await expect(assemble(true).reach.status()).resolves.not.toHaveProperty("handSet")
  })

  it("applies the change through the service update when the app runs on the login service", async () => {
    const { reach, update, stopOwned } = assemble(false)
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true })
    const tls = join(home, ".domovoi", "tls")
    expect(update).toHaveBeenCalledWith({ set: { address: "100.101.102.103", name, certPath: join(tls, `${name}.crt`), keyPath: join(tls, `${name}.key`) } })
    expect(stopOwned).not.toHaveBeenCalled()
  })
})
