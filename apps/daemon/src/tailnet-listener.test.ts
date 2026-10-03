import { execFile } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { deviceIssueCodeResultSchema, protocolVersion, tailnetListenerStatusSchema } from "@getdomovoi/protocol"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"

import { DomovoiDaemon, type DaemonErrorEntry } from "./server.js"
import { tailnetCertificateCheck, type DaemonTailnetListenerOptions } from "./tailnet-listener.js"

// TailnetReach (Q404 A): a second listener, TLS only, on this machine's
// Tailscale address, beside the loopback listener the desktop and the CLI
// attach on. The tests bind it to ::1, the one second address every test
// machine has; the daemon's settings refuse ::1 for real use (config.test.ts).

const name = "studio.tail4c2e.ts.net"
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
let folder = ""
let certificate: Buffer
let key: Buffer
let otherKey: Buffer
let ipv6 = false
let nextId = 0

async function generate(prefix: string): Promise<{ cert: Buffer; key: Buffer }> {
  const config = join(folder, `${prefix}.cnf`)
  await writeFile(config, `[req]\ndistinguished_name=dn\nx509_extensions=names\n[dn]\n[names]\nsubjectAltName=DNS:${name}\n`)
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", join(folder, `${prefix}.key`), "-out", join(folder, `${prefix}.crt`), "-days", "30", "-subj", `/CN=${name}`,
    "-config", config,
  ], { timeout: 20_000 })
  return { cert: await readFile(join(folder, `${prefix}.crt`)), key: await readFile(join(folder, `${prefix}.key`)) }
}

async function bindsIpv6Loopback(): Promise<boolean> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "::1", resolve) })
    return true
  } catch {
    return false
  } finally {
    server.close()
  }
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "domovoi-tailnet-listener-"))
  const first = await generate("first")
  certificate = first.cert
  key = first.key
  otherKey = (await generate("second")).key
  ipv6 = await bindsIpv6Loopback()
}, 30_000)

afterAll(async () => {
  await rm(folder, { recursive: true, force: true })
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

function call(socket: WebSocket, method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId
  return new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No reply to ${method}`)) }, 3_000)
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage) }
    const onMessage = (bytes: WebSocket.RawData) => {
      const response = JSON.parse(bytes.toString()) as { id: number; result?: unknown; error?: { code: number; message: string } }
      if (response.id === id) { cleanup(); resolve(response) }
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

async function open(url: string, options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  const socket = new WebSocket(url, options)
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(3_000) })
  return socket
}

async function hello(socket: WebSocket, authToken?: string) {
  return call(socket, "system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, ...(authToken ? { authToken } : {}) })
}

// The client checks the certificate against its name, as a phone does.
function trusting(): WebSocket.ClientOptions {
  const options = { ca: certificate, servername: name }
  return options
}

function daemon(tailnetListener: DaemonTailnetListenerOptions, errors: DaemonErrorEntry[] = []) {
  const created = new DomovoiDaemon({
    port: 0, statePath: ":memory:", allowRemoteTransport: true, authTimeoutMs: 1_000,
    errorSink: (entry) => errors.push(entry),
    tailnetListener,
  })
  daemons.push(created)
  return created
}

describe("the tailnet listener", () => {
  it("is off without the setting, and loopback answers as before", async () => {
    const plain = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(plain)
    const { port } = await plain.start()
    const socket = await open(`ws://127.0.0.1:${port}/rpc`)
    expect((await hello(socket, plain.authToken)).error).toBeUndefined()
    expect(tailnetListenerStatusSchema.parse((await call(socket, "tailnet.status")).result)).toEqual({ state: "off" })
  })

  it("needs the remote transport opt-in, as any listener off this machine does", () => {
    expect(() => new DomovoiDaemon({ port: 0, statePath: ":memory:", tailnetListener: { address: "::1", tls: { cert: certificate, key } } }))
      .toThrow("Non-loopback listeners require explicit protected-transport opt-in")
  })

  it("answers TLS on the tailnet address beside plaintext loopback, with the same authentication", async (context) => {
    if (!ipv6) context.skip()
    const served = daemon({ address: "::1", tls: { cert: certificate, key } })
    const { host, port } = await served.start()
    expect(host).toBe("127.0.0.1")

    const local = await open(`ws://127.0.0.1:${port}/rpc`)
    expect((await hello(local, served.authToken)).error).toBeUndefined()
    const status = tailnetListenerStatusSchema.parse((await call(local, "tailnet.status")).result)
    expect(status).toEqual({
      state: "listening", address: "::1", port,
      certificateExpiresAt: new Date(new X509Certificate(certificate).validTo).toISOString(),
    })

    const tls = trusting()
    const anonymous = await open(`wss://[::1]:${port}/rpc`, tls)
    expect((await hello(anonymous)).error).toBeDefined()
    const wrong = await open(`wss://[::1]:${port}/rpc`, tls)
    expect((await hello(wrong, "x".repeat(43))).error).toBeDefined()
    const owner = await open(`wss://[::1]:${port}/rpc`, tls)
    expect((await hello(owner, served.authToken)).error).toBeUndefined()

    // TLS only: a plaintext dial to the tailnet address gets no WebSocket.
    const plaintext = new WebSocket(`ws://[::1]:${port}/rpc`)
    sockets.push(plaintext)
    await expect(once(plaintext, "open", { signal: AbortSignal.timeout(3_000) })).rejects.toBeDefined()
  })

  it("names the certificate's host in a pairing code while it listens", async (context) => {
    if (!ipv6) context.skip()
    const served = daemon({ address: "::1", tls: { cert: certificate, key } })
    const { port } = await served.start()
    const socket = await open(`ws://127.0.0.1:${port}/rpc`)
    expect((await hello(socket, served.authToken)).error).toBeUndefined()
    const issued = deviceIssueCodeResultSchema.parse((await call(socket, "device.issueCode", { targetClient: "phone" })).result)
    expect(issued.pairingAddress).toMatchObject({ url: `wss://${name}:${port}/rpc`, label: name })
  })

  it("closes with the daemon", async (context) => {
    if (!ipv6) context.skip()
    const served = daemon({ address: "::1", tls: { cert: certificate, key } })
    const { port } = await served.start()
    await served.stop()
    const late = new WebSocket(`wss://[::1]:${port}/rpc`, trusting())
    sockets.push(late)
    await expect(once(late, "open", { signal: AbortSignal.timeout(3_000) })).rejects.toBeDefined()
  })

  it("refuses the listener, says why and keeps loopback when the certificate could not be read", async () => {
    const errors: DaemonErrorEntry[] = []
    const served = daemon({ address: "100.101.102.103", tls: { refused: "Domovoi could not read the TLS certificate at /home/tester/.domovoi/tls/studio.crt: ENOENT" } }, errors)
    const { port } = await served.start()
    const socket = await open(`ws://127.0.0.1:${port}/rpc`)
    expect((await hello(socket, served.authToken)).error).toBeUndefined()
    expect(tailnetListenerStatusSchema.parse((await call(socket, "tailnet.status")).result)).toEqual({
      state: "refused", address: "100.101.102.103", retrying: false,
      reason: "Domovoi could not read the TLS certificate at /home/tester/.domovoi/tls/studio.crt: ENOENT",
    })
    expect(errors).toContainEqual({ context: "Domovoi did not start the tailnet listener", detail: expect.stringContaining("ENOENT") })
    // With nothing on the tailnet, a code names the loopback listener.
    const issued = deviceIssueCodeResultSchema.parse((await call(socket, "device.issueCode", { targetClient: "phone" })).result)
    expect(issued.pairingAddress).toEqual({ url: `ws://127.0.0.1:${port}/rpc`, loopback: true })
  })

  it("refuses a key that does not belong to the certificate", async () => {
    const served = daemon({ address: "::1", tls: { cert: certificate, key: otherKey } })
    const { port } = await served.start()
    const socket = await open(`ws://127.0.0.1:${port}/rpc`)
    expect((await hello(socket, served.authToken)).error).toBeUndefined()
    expect(tailnetListenerStatusSchema.parse((await call(socket, "tailnet.status")).result)).toMatchObject({
      state: "refused", address: "::1", retrying: false,
      reason: "The tailnet certificate and key do not belong together, so the daemon answers on this computer only.",
    })
  })

  it("tries an address that is not on this machine again on its own", async () => {
    // TEST-NET-1 is never assigned to a machine, as a Tailscale address is not
    // until Tailscale is up.
    const served = daemon({ address: "192.0.2.1", tls: { cert: certificate, key }, retryMs: 50 })
    const { port } = await served.start()
    const socket = await open(`ws://127.0.0.1:${port}/rpc`)
    expect((await hello(socket, served.authToken)).error).toBeUndefined()
    expect(tailnetListenerStatusSchema.parse((await call(socket, "tailnet.status")).result)).toMatchObject({
      state: "refused", address: "192.0.2.1", retrying: true,
      reason: expect.stringContaining("192.0.2.1 is not on this machine"),
      certificateExpiresAt: new Date(new X509Certificate(certificate).validTo).toISOString(),
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(tailnetListenerStatusSchema.parse((await call(socket, "tailnet.status")).result)).toMatchObject({ state: "refused", retrying: true })
  })
})

describe("the tailnet certificate check", () => {
  // Generated with openssl for this test: one name, valid 1 to 2 January 2025.
  const expired = `-----BEGIN CERTIFICATE-----
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

  it("reads the certificate's expiry", () => {
    expect(tailnetCertificateCheck(Buffer.from(expired), Date.parse("2025-01-01T12:00:00Z")))
      .toEqual({ notAfter: new Date("2025-01-02T00:00:00Z") })
  })

  it("refuses a certificate that has expired", () => {
    expect(tailnetCertificateCheck(Buffer.from(expired), Date.parse("2026-10-02T00:00:00Z"))).toEqual({
      notAfter: new Date("2025-01-02T00:00:00Z"),
      refused: "The tailnet certificate expired on 2025-01-02, so the daemon answers on this computer only.",
    })
  })

  it("refuses something that is not a certificate", () => {
    expect(tailnetCertificateCheck(Buffer.from("-----BEGIN CERTIFICATE-----\nnot one\n-----END CERTIFICATE-----\n"), Date.now()))
      .toEqual({ refused: "The tailnet certificate could not be read as an X.509 certificate, so the daemon answers on this computer only." })
  })
})
