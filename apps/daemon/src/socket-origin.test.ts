

import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { WebSocket } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"
import { removeScratchDirectories } from "./test-scratch.js"

// Every other socket test in this repository connects with the `ws` client,
// which sends no Origin header at all, so the origin check is never exercised
// by them and a client that does send one can be refused while the whole suite
// stays green. That is what happened: the phone could not pair with any daemon
// over wss because React Native sets Origin from the URL it dials, and no
// fixed allow-list can hold an address that differs per machine.
//
// A browser is the only client that cannot choose its own Origin, so the check
// is worth keeping for pages; a request whose Origin names this same daemon is
// same-origin and belongs to a client dialling it directly.
//
// Same-origin is read off the request's own Host, which the caller controls.
// A DNS-rebinding page makes its own name resolve to this daemon, so its
// Origin and Host would match each other; that only works over plaintext,
// because a TLS handshake for a name this certificate does not carry fails
// before any header is read. So the same-host rule holds on TLS listeners
// only, and a plaintext listener keeps the allow-list alone.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const scratchDirectories: string[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratchDirectories.splice(0))
})

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

async function selfSignedMaterial(): Promise<{ cert: Buffer, key: Buffer }> {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-origin-tls-"))
  scratchDirectories.push(scratch)
  const certPath = join(scratch, "cert.pem")
  const keyPath = join(scratch, "key.pem")
  await writeFile(keyPath, "")
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=localhost",
  ], { stdio: "ignore" })
  return { cert: await readFile(certPath), key: await readFile(keyPath) }
}

async function daemonOnPort(tls?: { cert: Buffer, key: Buffer }) {
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", ...(tls ? { tls } : {}) })
  daemons.push(daemon)
  await daemon.start()
  return daemon
}

type Attempt = { admitted: true } | { admitted: false, status?: number }

async function connectWithOrigin(daemon: DomovoiDaemon, origin?: string, secure = false): Promise<Attempt> {
  const address = daemon.address!
  const url = `${secure ? "wss" : "ws"}://${address.host}:${address.port}/rpc`
  const socket = new WebSocket(url, {
    ...(origin === undefined ? {} : { origin }),
    ...(secure ? { rejectUnauthorized: false } : {}),
  })
  sockets.push(socket)
  return await new Promise<Attempt>((resolve) => {
    const settle = (result: Attempt) => { clearTimeout(timer); resolve(result) }
    const timer = setTimeout(() => settle({ admitted: false }), 5_000)
    socket.once("open", () => settle({ admitted: true }))
    socket.once("unexpected-response", (_request, response) => settle(
      response.statusCode === undefined ? { admitted: false } : { admitted: false, status: response.statusCode },
    ))
    socket.once("error", () => settle({ admitted: false }))
  })
}

describe.skipIf(!opensslAvailable())("which origins may open a TLS socket", () => {
  it("admits a client that names this daemon, the way a phone does", async () => {
    const daemon = await daemonOnPort(await selfSignedMaterial())
    const address = daemon.address!
    // React Native derives Origin from the URL it dials. On a real machine that
    // is the daemon's own DNS name and port, which no fixed list can contain.
    expect(await connectWithOrigin(daemon, `https://${address.host}:${address.port}`, true)).toEqual({ admitted: true })
  })

  it("still refuses a page served by somewhere else", async () => {
    const daemon = await daemonOnPort(await selfSignedMaterial())
    expect(await connectWithOrigin(daemon, "https://evil.example", true)).toMatchObject({ admitted: false, status: 401 })
  })
})

describe("which origins may open a plaintext socket", () => {
  it("refuses an origin that names this daemon, because plaintext cannot tell it from a rebound name", async () => {
    const daemon = await daemonOnPort()
    const address = daemon.address!
    expect(await connectWithOrigin(daemon, `http://${address.host}:${address.port}`)).toMatchObject({ admitted: false, status: 401 })
  })

  it("admits a client that sends no origin at all", async () => {
    const daemon = await daemonOnPort()
    expect(await connectWithOrigin(daemon)).toEqual({ admitted: true })
  })

  it("admits the configured clients", async () => {
    const daemon = await daemonOnPort()
    expect(await connectWithOrigin(daemon, "http://127.0.0.1:5178")).toEqual({ admitted: true })
    expect(await connectWithOrigin(daemon, "domovoi-app://desktop")).toEqual({ admitted: true })
  })

  it("refuses a page served by somewhere else", async () => {
    const daemon = await daemonOnPort()
    const address = daemon.address!
    // The case the check exists for: a browser attaches this itself and a page
    // cannot lie about it, so a site cannot drive someone's daemon.
    expect(await connectWithOrigin(daemon, "https://evil.example")).toMatchObject({ admitted: false, status: 401 })
    // Same host, different port is a different origin and stays refused.
    expect(await connectWithOrigin(daemon, `http://${address.host}:${address.port + 1}`)).toMatchObject({ admitted: false, status: 401 })
  })
})
