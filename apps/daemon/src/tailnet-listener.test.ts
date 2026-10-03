import { execFile } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { request as httpsRequest } from "node:https"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { auditQueryPageSchema, demoWorkspace, deviceIssueCodeResultSchema, protocolVersion, tailnetListenerStatusSchema } from "@getdomovoi/protocol"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { DomovoiDaemon, type DaemonErrorEntry } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { tailnetCertificateCheck, tailnetExpiryDelay, type DaemonTailnetListenerOptions } from "./tailnet-listener.js"

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

  // Review of 049b1383 (P2-4): a phone dials wss://<certificate name>:port and
  // builds preview URLs from that name, so the tailnet listener serves an
  // artifact to a Host naming the certificate, and still to no other.
  it("serves a signed preview to the certificate's name on the tailnet", async (context) => {
    if (!ipv6) context.skip()
    const workspace = await mkdtemp(join(tmpdir(), "domovoi-tailnet-artifact-"))
    try {
      await writeFile(join(workspace, "preview.html"), "<h1>Tailnet preview</h1>")
      const snapshot = structuredClone(demoWorkspace)
      snapshot.sessions.find((candidate) => candidate.id === "session-billing")!.workspacePath = workspace
      const artifact = snapshot.artifacts.find((candidate) => candidate.id === "artifact-preview")!
      artifact.path = "preview.html"
      artifact.mimeType = "text/html"
      const served = new DomovoiDaemon({
        port: 0, allowRemoteTransport: true, store: new SqliteWorkspaceStore(":memory:", snapshot),
        tailnetListener: { address: "::1", tls: { cert: certificate, key } },
      })
      daemons.push(served)
      const { port } = await served.start()
      const socket = await open(`ws://127.0.0.1:${port}/rpc`)
      expect((await hello(socket, served.authToken)).error).toBeUndefined()
      const access = (await call(socket, "artifact.authorize", {
        sessionId: artifact.sessionId, artifactId: artifact.id, revision: artifact.revision, purpose: "preview", client: "desktop",
      })).result as { sessionId: string; revision: number; purpose: string; expiresAt: number; signature: string }
      const path = `/artifacts/${artifact.id}?session=${access.sessionId}&revision=${access.revision}&purpose=${access.purpose}&expires=${access.expiresAt}&signature=${access.signature}`
      const fetched = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpsRequest({ host: "::1", port, path, ca: certificate, servername: name, headers: { host } }, (response) => {
          let body = ""
          response.on("data", (chunk) => { body += String(chunk) })
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
        })
        request.on("error", reject)
        request.end()
      })
      expect(await fetched(`${name}:${port}`)).toEqual({ status: 200, body: "<h1>Tailnet preview</h1>" })
      expect(await fetched(`[::1]:${port}`)).toMatchObject({ status: 200 })
      expect(await fetched(`other.tail4c2e.ts.net:${port}`)).toMatchObject({ status: 404 })
      expect(await fetched(`${name}:${port + 1}`)).toMatchObject({ status: 404 })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
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

  // Q404 follow-up: when renewal keeps failing, the certificate lapses. A
  // phone refuses an expired one, so the daemon stops answering on the
  // tailnet at notAfter and says so; loopback answers as before. Only the
  // clock is faked; sockets and timers are real.
  it("stops answering on the tailnet once the certificate expires, and says so", async (context) => {
    if (!ipv6) context.skip()
    const errors: DaemonErrorEntry[] = []
    const served = daemon({ address: "::1", tls: { cert: certificate, key } }, errors)
    const { port } = await served.start()
    const socket = await open(`ws://127.0.0.1:${port}/rpc`)
    expect((await hello(socket, served.authToken)).error).toBeUndefined()
    const remote = await open(`wss://[::1]:${port}/rpc`, trusting())
    expect((await hello(remote, served.authToken)).error).toBeUndefined()
    const notAfter = new Date(new X509Certificate(certificate).validTo)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(notAfter.getTime() + 1_000)
      const closed = once(remote, "close")
      expect(tailnetListenerStatusSchema.parse((await call(socket, "tailnet.status")).result)).toEqual({
        state: "refused", address: "::1", retrying: false, certificateExpiresAt: notAfter.toISOString(),
        reason: `The tailnet certificate expired on ${notAfter.toISOString().slice(0, 10)}, so the daemon answers on this computer only.`,
      })
      await closed
    } finally {
      vi.useRealTimers()
    }
    const late = new WebSocket(`wss://[::1]:${port}/rpc`, trusting())
    sockets.push(late)
    await expect(once(late, "open", { signal: AbortSignal.timeout(3_000) })).rejects.toBeDefined()
    expect((await call(socket, "workspace.get")).error).toBeUndefined()
    expect(errors).toContainEqual({ context: "Domovoi stopped the tailnet listener", detail: expect.stringContaining("expired") })
  })

  // Codex review round 1 (P3-7): the listener closes at notAfter on its own,
  // with no status request to notice it. The timer armed for notAfter
  // re-arms at most every expiryRecheckMs; the test shortens that and moves
  // only the clock past notAfter.
  it("closes at expiry with no status request", async (context) => {
    if (!ipv6) context.skip()
    const errors: DaemonErrorEntry[] = []
    const served = daemon({ address: "::1", tls: { cert: certificate, key }, expiryRecheckMs: 50 }, errors)
    const { port } = await served.start()
    const remote = await open(`wss://[::1]:${port}/rpc`, trusting())
    expect((await hello(remote, served.authToken)).error).toBeUndefined()
    const notAfter = new Date(new X509Certificate(certificate).validTo)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(notAfter.getTime() + 1_000)
      await once(remote, "close", { signal: AbortSignal.timeout(3_000) })
    } finally {
      vi.useRealTimers()
    }
    expect(errors).toContainEqual({ context: "Domovoi stopped the tailnet listener", detail: expect.stringContaining("expired") })
  })

  // Codex review round 2 (P3): a graceful close leaves the connection open
  // for up to 30 seconds while the client answers it. This client never
  // answers and keeps sending; nothing it sends after expiry is handled, and
  // its connection ends at once. Each handled request leaves an audit entry.
  it("handles nothing from a tailnet connection after expiry, and ends it", async (context) => {
    if (!ipv6) context.skip()
    const served = daemon({ address: "::1", tls: { cert: certificate, key } })
    const { port } = await served.start()
    const socket = await open(`ws://127.0.0.1:${port}/rpc`)
    expect((await hello(socket, served.authToken)).error).toBeUndefined()
    const remote = await open(`wss://[::1]:${port}/rpc`, trusting())
    expect((await hello(remote, served.authToken)).error).toBeUndefined()
    remote.close = () => {}
    const closed = once(remote, "close", { signal: AbortSignal.timeout(3_000) })
    closed.catch(() => {})
    // The newest entry for the method only the tailnet client asks.
    const lastHandled = async () => auditQueryPageSchema.parse((await call(socket, "audit.query", { action: "device.current", limit: 1 })).result).entries[0]?.id
    const sending = setInterval(() => {
      try { remote.send(JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "device.current", params: {} })) } catch { /* ended */ }
    }, 5)
    try {
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await lastHandled()).toBeDefined()
      const notAfter = new Date(new X509Certificate(certificate).validTo)
      vi.useFakeTimers({ toFake: ["Date"] })
      try {
        vi.setSystemTime(notAfter.getTime() + 1_000)
        expect(tailnetListenerStatusSchema.parse((await call(socket, "tailnet.status")).result)).toMatchObject({ state: "refused" })
      } finally {
        vi.useRealTimers()
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      const atExpiry = await lastHandled()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await lastHandled()).toBe(atExpiry)
      await closed
    } finally {
      clearInterval(sending)
    }
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

  // Codex review round 1 (P3-7): the timer is armed for notAfter itself, or
  // for the longest wait a timer takes when notAfter is further away.
  it("waits until notAfter, at most one timer's longest wait at a time", () => {
    const now = Date.parse("2026-10-02T00:00:00Z")
    expect(tailnetExpiryDelay(now + 90_000, now)).toBe(90_000)
    expect(tailnetExpiryDelay(now - 1, now)).toBe(0)
    expect(tailnetExpiryDelay(now + 60 * 24 * 60 * 60_000, now)).toBe(2_147_483_647)
    expect(tailnetExpiryDelay(now + 90_000, now, 50)).toBe(50)
  })

  it("refuses something that is not a certificate", () => {
    expect(tailnetCertificateCheck(Buffer.from("-----BEGIN CERTIFICATE-----\nnot one\n-----END CERTIFICATE-----\n"), Date.now()))
      .toEqual({ refused: "The tailnet certificate could not be read as an X.509 certificate, so the daemon answers on this computer only." })
  })
})
