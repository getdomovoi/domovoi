const { app, BrowserWindow, protocol } = require("electron")
const assert = require("node:assert/strict")
const { createRequire } = require("node:module")
const { join } = require("node:path")
const { pathToFileURL } = require("node:url")
const { WebSocketServer } = createRequire(join(__dirname, "../../daemon/package.json"))("ws")
const directory = process.argv.at(-1)
app.setPath("userData", join(directory, "profile"))
protocol.registerSchemesAsPrivileged([{ scheme: "domovoi-app", privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }])
const timer = setTimeout(() => { console.error("Fleet origin proof expired"); app.exit(1) }, 25_000)
app.whenReady().then(async () => {
  const { FleetOriginAdmission } = await import(pathToFileURL(join(directory, "fleet-origin.js")))
  const { rendererResource } = await import(pathToFileURL(join(directory, "renderer-resources.js")))
  const servers = [0, 1].map(() => new WebSocketServer({ host: "127.0.0.1", port: 0 }))
  await Promise.all(servers.map((server) => new Promise((resolve) => server.on("listening", resolve))))
  const urls = servers.map((server) => `ws://127.0.0.1:${server.address().port}/rpc`)
  const hits = [0, 0]
  servers.forEach((server, index) => server.on("connection", () => { hits[index]++ }))
  let verifiedEndpoint = urls[0]
  const admission = new FleetOriginAdmission(async (machineId) => ({ outcome: "ready", machineId,
    transport: { kind: verifiedEndpoint.startsWith("ws:") ? "local" : "lan", endpoint: verifiedEndpoint, authenticated: true } }))
  protocol.handle("domovoi-app", request => rendererResource({ url: request.url, method: request.method,
    directory, endpoint: undefined, origins: admission }))
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL("domovoi-app://desktop/index.html")
  const connect = (url, ticket) => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const worker = new Worker('/fleet-socket.js?route=' + ${JSON.stringify(ticket)});
    worker.onerror = event => { worker.terminate(); reject(Error(event.message)) };
    worker.onmessage = ({data}) => { if (data.type === 'open' || data.type === 'error') { worker.terminate(); resolve(data.type) } };
    worker.postMessage({ type: 'open', url: ${JSON.stringify(url)} });
  })`)
  assert.equal(await connect(urls[0], "unverified"), "error", "An unverified origin must not open")
  const first = await admission.authorize("machine-peer", 5_000)
  assert.equal(await connect(urls[0], first.ticket), "open", "Verified origin must open")
  const second = await admission.authorize("machine-peer", 5_000)
  assert.equal(await connect(urls[1], second.ticket), "error", "Verification must not authorize another port")
  assert.equal(await connect(urls[0], first.ticket), "error", "A consumed ticket must not be replayed")
  // A semicolon ends a directive and a comma starts another policy. Observe
  // Chromium's network boundary: a socket error alone could be a DNS or TLS
  // failure after CSP already permitted the unverified hostname prefix.
  const craftedRequests = []
  const unverifiedPrefix = "wss://csp-prefix.example/rpc"
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["wss://csp-prefix.example/*"] }, (details, callback) => {
    craftedRequests.push(details.url)
    callback({ cancel: true })
  })
  for (const separator of [";", "%3b", "%3B", ",", "%2c"]) {
    verifiedEndpoint = `wss://csp-prefix.example${separator}other.example/rpc`
    const crafted = await admission.authorize("machine-peer", 5_000)
    assert.equal(await connect(unverifiedPrefix, crafted.outcome === "ready" ? crafted.ticket : "refused-route"), "error")
    assert.deepEqual(craftedRequests, [], `A crafted host must not permit an unverified origin: ${verifiedEndpoint}`)
    assert.deepEqual(crafted, { outcome: "refused", reason: "client-route-unavailable" })
  }
  assert.deepEqual(hits, [1, 0], "Refused workers must not reach a socket")
  window.destroy()
  for (const server of servers) { for (const socket of server.clients) socket.terminate(); server.close() }
  clearTimeout(timer)
  console.info("DOMOVOI_FLEET_ORIGIN_PROOF_OK verified=1 unverified=0 other=0 replay=0 crafted=0")
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
