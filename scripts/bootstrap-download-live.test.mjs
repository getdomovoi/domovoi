import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer as createHttpsServer } from "node:https"
import { createServer as createTcpServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"

const execute = promisify(execFile)

async function bounded(timeoutMs, message, operation) {
  const deadline = bootstrapDeadline(timeoutMs, message)
  try { return await deadline.run(() => operation(deadline)) }
  finally { deadline.clear() }
}

test("native HTTPS inactivity closes real stalled connections", { timeout: 90_000 }, async (t) => {
  const { certificate, material } = await bounded(15_000, "TLS fixture setup expired", async (deadline) => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-download-live-"))
    t.after(() => bounded(10_000, "TLS fixture cleanup expired", () => rm(root, { recursive: true, force: true })))
    const key = join(root, "key.pem")
    const certificate = join(root, "cert.pem")
    await execute("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-keyout", key, "-out", certificate, "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1"], { timeout: 10_000, killSignal: "SIGKILL", signal: deadline.signal })
    return { certificate, material: { key: await readFile(key), cert: await readFile(certificate) } }
  })

  for (const phase of ["TLS handshake", "headers", "first body bytes", "body after progress"]) {
    await t.test(phase, { timeout: 20_000 }, async () => {
      await bounded(15_000, `Live ${phase} proof expired`, async (deadline) => {
        let observed = false
        let observedSocket
        let confirmClosed
        const closed = new Promise((resolve) => { confirmClosed = resolve })
        const sockets = new Set()
        const server = phase === "TLS handshake" ? createTcpServer((socket) => {
          socket.once("data", () => { observed = true; observedSocket = socket })
        }) : createHttpsServer(material, (request, response) => {
          observed = true
          // TLSSocket close is observed on the request, not on its raw parent.
          request.socket.once("close", confirmClosed)
          if (phase === "headers") return
          response.writeHead(200)
          response.flushHeaders()
          if (phase === "body after progress") response.write("x")
        })
        server.on("connection", (socket) => {
          sockets.add(socket)
          socket.on("error", () => {})
          socket.once("close", () => {
            sockets.delete(socket)
            if (socket === observedSocket) confirmClosed()
          })
        })
        try {
          await deadline.run(() => new Promise((resolve, reject) => {
            server.once("error", reject)
            server.listen(0, "127.0.0.1", resolve)
          }))
          const url = `https://127.0.0.1:${server.address().port}/archive.tgz`
          // Native fetch, real TLS and a separately trusted certificate. Never
          // disable certificate verification or substitute a fetch implementation.
          const source = `
            import assert from "node:assert/strict"
            import { downloadOverHttps } from ${JSON.stringify(new URL("./bootstrap-download.mjs", import.meta.url).href)}
            import { bootstrapDeadline } from ${JSON.stringify(new URL("./bootstrap-deadline.mjs", import.meta.url).href)}
            const deadline = bootstrapDeadline(6_000, "Live total expired")
            let bytes = 0
            try {
              await assert.rejects(async () => {
                for await (const chunk of downloadOverHttps(${JSON.stringify(url)}, {
                  maximumBytes: 8, deadline, inactivityTimeoutMs: 2_000,
                })) bytes += chunk.byteLength
              }, { code: "BOOTSTRAP_DOWNLOAD_INACTIVE" })
              assert.equal(bytes, ${phase === "body after progress" ? 1 : 0})
              assert.equal(deadline.signal.aborted, false)
              console.log("DOMOVOI_DOWNLOAD_INACTIVITY_OK")
            } finally { deadline.clear() }
          `
          const result = await deadline.run(() => execute(process.execPath, ["--input-type=module", "-e", source], {
            timeout: 12_000, killSignal: "SIGKILL", signal: deadline.signal,
            env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
          }))
          assert.match(result.stdout, /DOMOVOI_DOWNLOAD_INACTIVITY_OK/)
          assert.equal(observed, true, `The peer must actually reach the stalled ${phase}`)
          await deadline.run(() => closed)
          t.diagnostic(`${phase}: peer reached, inactivity refused, connection closed`)
        } finally {
          for (const socket of sockets) socket.destroy()
          await bounded(5_000, `Live ${phase} server cleanup expired`, () => new Promise((resolve) => server.close(resolve)))
        }
      })
    })
  }
})
