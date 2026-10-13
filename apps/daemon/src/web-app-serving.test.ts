import { execFile } from "node:child_process"
import { createHash, X509Certificate } from "node:crypto"
import { once } from "node:events"
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { DomovoiDaemon, type DaemonServerOptions } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { LoadedWebAppFile, WebAppBundleLoad } from "./web-app-bundle.js"

// S3.2 slice 4 (docs/plans/s3-2-web-over-tailnet.md, Q46 A): the running
// daemon serves the web app on every listener it opens. Each listener admits
// to /rpc the configured origins plus only its own browser origins, and names
// only those in a preview's frame-ancestors. Preview documents keep a CSP
// sandbox without allow-same-origin, so on the shared origin they still run
// in an opaque origin.

const name = "studio.example.ts.net"
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
let folder = ""
let workspace = ""
let certificate: Buffer
let key: Buffer
let ipv6 = false

const indexHtml = Buffer.from('<!doctype html><html lang="en"><head><title>Domovoi</title><script type="module" src="/assets/index-B0V_-a_P.js"></script></head><body><div id="root"></div></body></html>')
const script = Buffer.from("document.getElementById('root').textContent = 'Domovoi'")

function file(bytes: Buffer, contentType: string, cacheClass: LoadedWebAppFile["cacheClass"]): LoadedWebAppFile {
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  return Object.freeze({ bytes, contentType, sha256, etag: `"${sha256}"`, cacheClass })
}

const loaded: WebAppBundleLoad = Object.freeze({
  state: "loaded", root: "/srv/domovoi-web", version: "0.0.1", protocolVersion,
  files: new Map([
    ["/index.html", file(indexHtml, "text/html; charset=utf-8", "entry")],
    ["/assets/index-B0V_-a_P.js", file(script, "text/javascript; charset=utf-8", "hashed")],
  ]),
})

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
  folder = await mkdtemp(join(tmpdir(), "domovoi-web-app-serving-"))
  const config = join(folder, "cert.cnf")
  await writeFile(config, `[req]\ndistinguished_name=dn\nx509_extensions=names\n[dn]\n[names]\nsubjectAltName=DNS:${name}\n`)
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", join(folder, "cert.key"), "-out", join(folder, "cert.crt"), "-days", "30", "-subj", `/CN=${name}`,
    "-config", config,
  ], { timeout: 20_000 })
  certificate = await readFile(join(folder, "cert.crt"))
  key = await readFile(join(folder, "cert.key"))
  workspace = join(folder, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "preview.html"), "<h1>Preview</h1>")
  ipv6 = await bindsIpv6Loopback()
}, 30_000)

afterAll(async () => {
  await rm(folder, { recursive: true, force: true })
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

function daemon(options: Partial<DaemonServerOptions> = {}): DomovoiDaemon {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.sessions.find((candidate) => candidate.id === "session-billing")!.workspacePath = workspace
  const artifact = snapshot.artifacts.find((candidate) => candidate.id === "artifact-preview")!
  artifact.path = "preview.html"
  artifact.mimeType = "text/html"
  const created = new DomovoiDaemon({ port: 0, store: new SqliteWorkspaceStore(":memory:", snapshot), authTimeoutMs: 1_000, ...options })
  daemons.push(created)
  return created
}

type Fetched = { status: number; headers: IncomingHttpHeaders; body: string }

function fetchFrom(target: { host: string; port: number; tls?: boolean }, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const options = { host: target.host, port: target.port, path, method, headers: { host: `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`, ...headers } }
    const request = target.tls
      ? httpsRequest({ ...options, ca: certificate, servername: name }, collect)
      : httpRequest(options, collect)
    function collect(response: IncomingMessage) {
      let body = ""
      response.on("data", (chunk) => { body += String(chunk) })
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
    }
    request.on("error", reject)
    request.end()
  })
}

// The client checks the certificate against its name, as a browser does.
// servername is a TLS option the ws types do not list.
function trusting(extra: WebSocket.ClientOptions = {}): WebSocket.ClientOptions {
  const options = { ca: certificate, servername: name, ...extra }
  return options
}

// Over TLS the client sends the certificate's name as Host, as a browser that
// loaded the page from that name does.
async function admitted(url: string, origin: string | undefined, tls = false): Promise<boolean> {
  const socket = new WebSocket(url, {
    ...(origin === undefined ? {} : { origin }),
    ...(tls ? trusting({ headers: { host: `${name}:${new URL(url).port}` } }) : {}),
  })
  sockets.push(socket)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000)
    socket.once("open", () => { clearTimeout(timer); resolve(true) })
    socket.once("unexpected-response", () => { clearTimeout(timer); resolve(false) })
    socket.once("error", () => { clearTimeout(timer); resolve(false) })
  })
}

async function rpc(url: string, authToken: string, tls = false) {
  const socket = new WebSocket(url, tls ? trusting() : {})
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(3_000) })
  let nextId = 0
  const call = (method: string, params: Record<string, unknown> = {}) => new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`No reply to ${method}`)), 3_000)
    const onMessage = (bytes: WebSocket.RawData) => {
      const response = JSON.parse(bytes.toString()) as { id: number; result?: unknown; error?: { message: string } }
      if (response.id !== id) return
      clearTimeout(timer)
      socket.off("message", onMessage)
      resolve(response)
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
  expect((await call("system.hello", { client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken })).error).toBeUndefined()
  return call
}

type Access = { sessionId: string; artifactId: string; revision: number; purpose: string; bridgeChannel?: string; parentOrigin?: string; expiresAt: number; signature: string }

async function artifactPath(call: Awaited<ReturnType<typeof rpc>>, purpose: "preview" | "print" | "download", bridge?: { channel: string; parentOrigin: string }): Promise<string> {
  const artifact = demoWorkspace.artifacts.find((candidate) => candidate.id === "artifact-preview")!
  const access = (await call("artifact.authorize", {
    sessionId: artifact.sessionId, artifactId: artifact.id, revision: artifact.revision, purpose, client: "desktop",
    ...(bridge ? { bridgeChannel: bridge.channel, parentOrigin: bridge.parentOrigin } : {}),
  })).result as Access
  const query = new URLSearchParams({
    session: access.sessionId, revision: String(access.revision), purpose: access.purpose,
    ...(access.bridgeChannel ? { bridge: access.bridgeChannel } : {}),
    ...(access.parentOrigin ? { parentOrigin: access.parentOrigin } : {}),
    expires: String(access.expiresAt), signature: access.signature,
  })
  return `/artifacts/${access.artifactId}?${query.toString()}`
}

function frameAncestors(csp: string | string[] | undefined): string[] {
  return /frame-ancestors ([^;]*)/.exec(String(csp))?.[1]?.split(" ") ?? []
}

describe("the web app on the loopback listener", () => {
  it("serves the bundle beside the daemon's own routes", async () => {
    const served = daemon({ webApp: loaded })
    const { port } = await served.start()
    const local = { host: "127.0.0.1", port }

    const root = await fetchFrom(local, "/?code=ABCD-EFGH")
    expect(root).toMatchObject({ status: 200, body: indexHtml.toString() })
    expect(root.headers).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": expect.stringContaining(`connect-src 'self' ws://127.0.0.1:${port};`),
    })
    expect(JSON.stringify(root)).not.toContain("ABCD-EFGH")
    expect(await fetchFrom(local, "/assets/index-B0V_-a_P.js")).toMatchObject({ status: 200, headers: { "cache-control": "private, max-age=31536000, immutable" } })
    expect(await fetchFrom({ host: "localhost", port }, "/")).toMatchObject({ status: 200 })

    // The daemon's own routes are unchanged.
    expect(JSON.parse((await fetchFrom(local, "/healthz")).body)).toEqual({ status: "ok", protocolVersion: expect.any(String) })
    expect(await fetchFrom(local, "/nothing-here")).toMatchObject({ status: 404, body: '{"error":"not_found"}' })
    expect(await fetchFrom(local, "/domovoi-web.json")).toMatchObject({ status: 404 })
    const call = await rpc(`ws://127.0.0.1:${port}/rpc`, served.authToken)
    const preview = await fetchFrom(local, await artifactPath(call, "preview"))
    expect(preview).toMatchObject({ status: 200, body: "<h1>Preview</h1>" })
    expect(preview.headers["content-security-policy"]).toContain("sandbox allow-scripts")

    // A rebound name is not this listener.
    expect(await fetchFrom(local, "/", { host: `rebind.example:${port}` })).toMatchObject({ status: 404 })
  })

  it("serves the state page when no bundle loaded, and nothing when none was given", async () => {
    const absent = daemon({ webApp: Object.freeze({ state: "absent", root: "/srv/domovoi-web", reason: "root-missing" }) })
    const { port } = await absent.start()
    const page = await fetchFrom({ host: "127.0.0.1", port }, "/")
    expect(page).toMatchObject({ status: 503, headers: { "cache-control": "no-store" } })
    expect(page.body).toContain("No web app is installed for this Domovoi daemon.")
    expect(page.body).not.toContain("/srv/domovoi-web")

    const none = daemon()
    const other = await none.start()
    expect(await fetchFrom({ host: "127.0.0.1", port: other.port }, "/")).toMatchObject({ status: 404, body: '{"error":"not_found"}' })
  })

  it("admits the page's own loopback origin to the socket only while a bundle is loaded", async () => {
    const served = daemon({ webApp: loaded })
    const { port } = await served.start()
    const url = `ws://127.0.0.1:${port}/rpc`
    expect(await admitted(url, `http://127.0.0.1:${port}`)).toBe(true)
    expect(await admitted(url, `http://localhost:${port}`)).toBe(true)
    expect(await admitted(url, `http://127.0.0.1:${port + 1}`)).toBe(false)
    expect(await admitted(url, "http://evil.example")).toBe(false)
    expect(await admitted(url, "null")).toBe(false)
    // A rebinding page carries its own name in Origin and Host alike.
    const rebound = new WebSocket(url, { origin: `http://rebind.example:${port}`, headers: { host: `rebind.example:${port}` } })
    sockets.push(rebound)
    expect(await new Promise((resolve) => { rebound.once("open", () => resolve(true)); rebound.once("unexpected-response", () => resolve(false)); rebound.once("error", () => resolve(false)) })).toBe(false)

    for (const webApp of [undefined, Object.freeze({ state: "invalid", root: "/srv/domovoi-web", reason: "digest-mismatch" }) satisfies WebAppBundleLoad]) {
      const without = daemon(webApp ? { webApp } : {})
      const other = await without.start()
      expect(await admitted(`ws://127.0.0.1:${other.port}/rpc`, `http://127.0.0.1:${other.port}`)).toBe(false)
    }
  })

  it("names the page's origin in a preview's frame-ancestors", async () => {
    const served = daemon({ webApp: loaded })
    const { port } = await served.start()
    const call = await rpc(`ws://127.0.0.1:${port}/rpc`, served.authToken)
    const preview = await fetchFrom({ host: "127.0.0.1", port }, await artifactPath(call, "preview"))
    expect(frameAncestors(preview.headers["content-security-policy"])).toEqual(expect.arrayContaining([`http://127.0.0.1:${port}`, `http://localhost:${port}`]))
  })

  // Plan section 3.4 and 3.8: on the shared origin the CSP sandbox is what
  // keeps an agent-written document out of the app's storage and socket.
  it("sandboxes every artifact document it returns, without allow-same-origin", async () => {
    const served = daemon({ webApp: loaded })
    const { port } = await served.start()
    const call = await rpc(`ws://127.0.0.1:${port}/rpc`, served.authToken)
    const paths = [
      await artifactPath(call, "preview"),
      await artifactPath(call, "preview", { channel: "a".repeat(32), parentOrigin: `http://127.0.0.1:${port}` }),
      await artifactPath(call, "print"),
      await artifactPath(call, "download"),
    ]
    for (const path of paths) {
      const response = await fetchFrom({ host: "127.0.0.1", port }, path)
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8")
      expect(response.headers["x-content-type-options"]).toBe("nosniff")
      const csp = String(response.headers["content-security-policy"])
      expect(csp).toMatch(/(?:^|; )sandbox(?: allow-scripts)?(?:;|$)/)
      expect(csp).not.toContain("allow-same-origin")
      expect(response.headers["content-security-policy-report-only"]).toBeUndefined()
    }
  })
})

describe("the web app on a TLS listener", () => {
  it("serves the app under the certificate's name and admits only that exact origin", async () => {
    const served = daemon({ webApp: loaded, tls: { cert: certificate, key } })
    const { port } = await served.start()
    const local = { host: "127.0.0.1", port, tls: true }
    const page = await fetchFrom(local, "/", { host: `${name}:${port}` })
    expect(page).toMatchObject({ status: 200, body: indexHtml.toString() })
    expect(page.headers["content-security-policy"]).toContain(`connect-src 'self' wss://${name}:${port};`)
    expect(await fetchFrom(local, "/", { host: `other.example.ts.net:${port}` })).toMatchObject({ status: 404 })

    const url = `wss://127.0.0.1:${port}/rpc`
    const tlsSocket = (origin: string, host = `${name}:${port}`) => {
      const socket = new WebSocket(url, trusting({ origin, headers: { host } }))
      sockets.push(socket)
      return new Promise<boolean>((resolve) => {
        socket.once("open", () => resolve(true))
        socket.once("unexpected-response", () => resolve(false))
        socket.once("error", () => resolve(false))
      })
    }
    expect(await tlsSocket(`https://${name}:${port}`)).toBe(true)
    expect(await tlsSocket(`http://${name}:${port}`)).toBe(false)
    expect(await tlsSocket("null")).toBe(false)

    const call = await rpc(url, served.authToken, true)
    const preview = await fetchFrom(local, await artifactPath(call, "preview"))
    expect(frameAncestors(preview.headers["content-security-policy"])).toContain(`https://${name}:${port}`)
  })
})

// S3.2 slice 5 (plan section 2.4): the legacy tailnet setup binds the main
// listener to an address with TLS, while every client sends the certificate's
// name as Host. Artifacts answer to the listener's Host authorities, the same
// set the web app answers to, with or without a bundle.
describe("artifacts on a TLS listener", () => {
  for (const webApp of [loaded, undefined]) {
    it(`serves artifacts under the certificate's name and refuses other names (${webApp ? "bundle" : "no bundle"})`, async () => {
      const served = daemon({ ...(webApp ? { webApp } : {}), tls: { cert: certificate, key }, advertiseHost: "advertised.example" })
      const { port } = await served.start()
      const local = { host: "127.0.0.1", port, tls: true }
      const call = await rpc(`wss://127.0.0.1:${port}/rpc`, served.authToken, true)
      const path = await artifactPath(call, "preview")

      for (const host of [`${name}:${port}`, `STUDIO.Example.ts.net:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `advertised.example:${port}`]) {
        expect(await fetchFrom(local, path, { host }), host).toMatchObject({ status: 200, body: "<h1>Preview</h1>" })
      }
      for (const host of [
        `127.0.0.2:${port}`, `other.example.ts.net:${port}`, `${name}:${port + 1}`, name,
        `user@${name}:${port}`, `${name}:${port}/path`, `${name}:${port}?query`, `${name}:${port}#fragment`,
      ]) {
        expect(await fetchFrom(local, path, { host }), host).toMatchObject({ status: 404, body: '{"error":"not_found"}' })
      }
    })
  }

  // docs/clean-machine-setup.md step 4: a wildcard bind with TLS and a tailnet
  // name. The wildcard address is no name a client dials.
  it("serves artifacts on a wildcard bind under the certificate's and the tailnet's names only", async () => {
    const served = daemon({ host: "0.0.0.0", allowRemoteTransport: true, tls: { cert: certificate, key }, tailnetHost: "workshop.example.ts.net" })
    const { port } = await served.start()
    const local = { host: "127.0.0.1", port, tls: true }
    const path = await artifactPath(await rpc(`wss://127.0.0.1:${port}/rpc`, served.authToken, true), "preview")
    for (const host of [`${name}:${port}`, `workshop.example.ts.net:${port}`]) {
      expect(await fetchFrom(local, path, { host }), host).toMatchObject({ status: 200, body: "<h1>Preview</h1>" })
    }
    for (const host of [`0.0.0.0:${port}`, `127.0.0.1:${port}`, `localhost:${port}`]) {
      expect(await fetchFrom(local, path, { host }), host).toMatchObject({ status: 404 })
    }
  })

  // Plan section 3.4 and 3.8 under the tailnet name: the shared origin keeps
  // every artifact document sandboxed, without allow-same-origin.
  it("sandboxes every artifact document it returns under the certificate's name", async () => {
    const served = daemon({ webApp: loaded, tls: { cert: certificate, key } })
    const { port } = await served.start()
    const call = await rpc(`wss://127.0.0.1:${port}/rpc`, served.authToken, true)
    const previews = [
      await artifactPath(call, "preview"),
      await artifactPath(call, "preview", { channel: "a".repeat(32), parentOrigin: `https://${name}:${port}` }),
    ]
    const paths = [...previews, await artifactPath(call, "print"), await artifactPath(call, "download")]
    for (const path of paths) {
      const response = await fetchFrom({ host: "127.0.0.1", port, tls: true }, path, { host: `${name}:${port}` })
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8")
      expect(response.headers["x-content-type-options"]).toBe("nosniff")
      const csp = String(response.headers["content-security-policy"])
      expect(csp).toMatch(/(?:^|; )sandbox(?: allow-scripts)?(?:;|$)/)
      expect(csp).not.toContain("allow-same-origin")
      // A preview may be framed by the page served under that name.
      if (previews.includes(path)) expect(frameAncestors(csp)).toContain(`https://${name}:${port}`)
      expect(response.headers["content-security-policy-report-only"]).toBeUndefined()
    }
  })
})

describe("the web app on the tailnet listener", () => {
  function tailnetDaemon(expiryRecheckMs?: number) {
    return daemon({
      webApp: loaded, allowRemoteTransport: true,
      tailnetListener: { address: "::1", tls: { cert: certificate, key }, ...(expiryRecheckMs ? { expiryRecheckMs } : {}) },
    })
  }

  it("serves the app on both listeners, each admitting only its own origins", async (context) => {
    if (!ipv6) context.skip()
    const served = tailnetDaemon()
    const { port } = await served.start()
    const tailnet = { host: "::1", port, tls: true }

    expect(await fetchFrom(tailnet, "/", { host: `${name}:${port}` })).toMatchObject({ status: 200, body: indexHtml.toString() })
    expect(await fetchFrom({ host: "127.0.0.1", port }, "/")).toMatchObject({ status: 200 })

    const loopbackRpc = `ws://127.0.0.1:${port}/rpc`
    const tailnetRpc = `wss://[::1]:${port}/rpc`
    // Each listener admits the page it served.
    expect(await admitted(loopbackRpc, `http://127.0.0.1:${port}`)).toBe(true)
    expect(await admitted(tailnetRpc, `https://${name}:${port}`, true)).toBe(true)
    // Neither admits the other's.
    expect(await admitted(loopbackRpc, `https://${name}:${port}`)).toBe(false)
    expect(await admitted(tailnetRpc, `http://127.0.0.1:${port}`, true)).toBe(false)
    expect(await admitted(tailnetRpc, `http://localhost:${port}`, true)).toBe(false)

    // frame-ancestors names the listener the preview was fetched from.
    const call = await rpc(loopbackRpc, served.authToken)
    const path = await artifactPath(call, "preview")
    const overLoopback = frameAncestors((await fetchFrom({ host: "127.0.0.1", port }, path)).headers["content-security-policy"])
    const overTailnet = frameAncestors((await fetchFrom(tailnet, path, { host: `${name}:${port}` })).headers["content-security-policy"])
    expect(overLoopback).toContain(`http://127.0.0.1:${port}`)
    expect(overLoopback).not.toContain(`https://${name}:${port}`)
    expect(overTailnet).toContain(`https://${name}:${port}`)
    expect(overTailnet).not.toContain(`http://127.0.0.1:${port}`)
  })

  it("admits the tailnet page's origin nowhere once the certificate expires", async (context) => {
    if (!ipv6) context.skip()
    const served = tailnetDaemon(50)
    const { port } = await served.start()
    expect(await admitted(`wss://[::1]:${port}/rpc`, `https://${name}:${port}`, true)).toBe(true)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(new Date(new X509Certificate(certificate).validTo).getTime() + 1_000)
      await vi.waitFor(async () => {
        expect(await admitted(`wss://[::1]:${port}/rpc`, `https://${name}:${port}`, true)).toBe(false)
      }, { timeout: 3_000 })
    } finally {
      vi.useRealTimers()
    }
    expect(await admitted(`ws://127.0.0.1:${port}/rpc`, `https://${name}:${port}`)).toBe(false)
    expect(await admitted(`ws://127.0.0.1:${port}/rpc`, `http://127.0.0.1:${port}`)).toBe(true)
  })
})
