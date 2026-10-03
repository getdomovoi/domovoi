import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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

function assemble(owned = true) {
  const endHandoff = vi.fn()
  const stopOwned = vi.fn(async () => {})
  const restart = vi.fn(async () => ({ kind: "owned" as const, url: "ws://127.0.0.1:47831/rpc", token: "t" }))
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
    environment: { PATH: bin },
    platform: "darwin",
    tailscaleLocations: [],
  })
  return { reach, stopOwned, restart, endHandoff, release, update }
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

  it("stores a private certificate and key in the profile, records them for the in-app daemon, and restarts it", async () => {
    const { reach, stopOwned, restart, endHandoff, release } = assemble()
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true, report: { state: "on", name, certificateExpiresAt: "2025-01-02T00:00:00.000Z" } })
    const tls = join(home, ".domovoi", "tls")
    expect(((await stat(tls)).mode & 0o777).toString(8)).toBe("700")
    expect(((await stat(join(tls, `${name}.key`))).mode & 0o777).toString(8)).toBe("600")
    expect(await readFile(join(tls, `${name}.crt`), "utf8")).toBe(certificate)
    expect(savedTailnetReachEnvironment(data)).toEqual({
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TAILNET_ADDRESS: "100.101.102.103",
      DOMOVOI_TAILNET_TLS_CERT_PATH: join(tls, `${name}.crt`),
      DOMOVOI_TAILNET_TLS_KEY_PATH: join(tls, `${name}.key`),
      DOMOVOI_TAILNET_HOST: name,
    })
    expect(stopOwned).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledOnce()
    expect(endHandoff).toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    expect((await readFile(join(root, "calls.log"), "utf8")).split("\n")[1]).toMatch(new RegExp(`^cert --cert-file ${tls}/\\.pending-[^ ]+/${name}\\.crt --key-file ${tls}/\\.pending-[^ ]+/${name}\\.key ${name}$`))
  })

  it("deletes only what it wrote when turned off, and forgets the settings", async () => {
    const { reach } = assemble()
    await reach.turnOn()
    const tls = join(home, ".domovoi", "tls")
    await writeFile(join(tls, "kept.crt"), "not Domovoi's")
    await expect(reach.turnOff()).resolves.toMatchObject({ ok: true, report: { state: "off" } })
    await expect(readdir(tls)).resolves.toEqual(["kept.crt"])
    expect(savedTailnetReachEnvironment(data)).toEqual({})
  })

  it("applies the change through the service update when the app runs on the login service", async () => {
    const { reach, update, stopOwned } = assemble(false)
    await expect(reach.turnOn()).resolves.toMatchObject({ ok: true })
    const tls = join(home, ".domovoi", "tls")
    expect(update).toHaveBeenCalledWith({ set: { address: "100.101.102.103", name, certPath: join(tls, `${name}.crt`), keyPath: join(tls, `${name}.key`) } })
    expect(stopOwned).not.toHaveBeenCalled()
  })
})
