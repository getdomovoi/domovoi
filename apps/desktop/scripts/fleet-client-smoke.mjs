import assert from "node:assert/strict"
import { fork, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import electron from "electron"
import { launchSmokeEnvironment } from "./launch-smoke-args.mjs"

const desktopRoot = fileURLToPath(new URL("../", import.meta.url))
const daemonRequire = createRequire(new URL("../../daemon/package.json", import.meta.url))
const { WebSocket } = daemonRequire("ws")
const directory = await mkdtemp(join(tmpdir(), "domovoi-fleet-client-proof-"))
const images = process.argv.find(arg => arg.startsWith("--screenshots="))?.slice("--screenshots=".length)
// One clock, running before either child or any debugging socket exists.
const end = Date.now() + (process.platform === "win32" ? 110_000 : 80_000)
const remaining = () => Math.max(0, end - Date.now())
function proofEnvironment() {
  const env = launchSmokeEnvironment({ env: process.env, profileRoot: join(directory, "Home"), timeoutMs: remaining() })
  delete env.DOMOVOI_DESKTOP_LAUNCH_SMOKE
  delete env.DOMOVOI_LAUNCH_SMOKE_PROFILE
  delete env.DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS
  return env
}
async function bounded(promise, label, maximum = 15_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fleet Desktop proof timed out: ${label}`)), Math.min(maximum, remaining()))
    })])
  } finally { clearTimeout(timer) }
}
let backend, desktop, socket
let backendOutput = "", desktopOutput = ""
try {
  const tsconfig = join(directory, "tsconfig.json")
  await writeFile(tsconfig, JSON.stringify({ compilerOptions: { paths: {} } }))
  backend = fork(new URL("../../daemon/test-fixtures/fleet-desktop.mjs", import.meta.url), [directory], {
    execArgv: ["--import", pathToFileURL(daemonRequire.resolve("tsx")).href],
    cwd: desktopRoot, env: { ...proofEnvironment(), TSX_TSCONFIG_PATH: tsconfig }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  backend.stdout.on("data", data => { backendOutput = (backendOutput + data).slice(-16_384) })
  backend.stderr.on("data", data => { backendOutput = (backendOutput + data).slice(-16_384) })
  const [fixture] = await bounded(Promise.race([once(backend, "message"), once(backend, "exit").then(() => { throw new Error("Fleet backend exited before ready") })]), "production daemon fixtures", 45_000)
  assert.equal(fixture.ready, true)
  console.info("Fleet proof: production daemons ready")
  const env = proofEnvironment()
  desktop = spawn(electron, ["--no-sandbox", "--headless", "--disable-gpu", "--remote-debugging-port=0", desktopRoot], {
    cwd: desktopRoot, env, stdio: ["ignore", "pipe", "pipe"],
  })
  const debugging = new Promise((resolve, reject) => {
    desktop.once("error", reject)
    desktop.once("exit", () => reject(new Error("Desktop exited before debugging was available")))
    const received = data => {
      desktopOutput = (desktopOutput + data).slice(-16_384)
      const address = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/u.exec(desktopOutput)?.[1]
      if (address) resolve(address)
    }
    desktop.stdout.on("data", received)
    desktop.stderr.on("data", received)
  })
  socket = new WebSocket(await bounded(debugging, "Desktop startup", 30_000), { handshakeTimeout: Math.min(5_000, remaining()), maxPayload: 32 * 1024 * 1024 })
  await bounded(once(socket, "open"), "debugging connection")
  let sequence = 0
  const waiting = new Map()
  const workers = new Map()
  let inventoryCount = 0, observationError
  socket.on("message", data => {
    const reply = JSON.parse(data.toString())
    if (reply.method === "Target.attachedToTarget" && reply.params.targetInfo.type === "worker") {
      const id = reply.params.sessionId
      workers.set(id, { receiptId: undefined, inventoryId: undefined, client: false, verified: false })
      void command("Network.enable", {}, id).then(() => command("Runtime.runIfWaitingForDebugger", {}, id))
        .catch(error => { observationError = error })
    }
    const worker = workers.get(reply.sessionId)
    if (worker && ["Network.webSocketFrameSent", "Network.webSocketFrameReceived"].includes(reply.method)) {
      let frame
      try { frame = JSON.parse(reply.params.response.payloadData) } catch { return }
      if (reply.method === "Network.webSocketFrameSent") {
        if (frame.method === "system.hello") worker.client = frame.params.client === "desktop" && frame.params.authToken === fixture.credential
        if (frame.method === "device.current") worker.receiptId = frame.id
        if (frame.method === "skill.inventory") worker.inventoryId = frame.id
      } else {
        if (frame.id !== undefined && frame.id === worker.receiptId) worker.verified = frame.result?.kind === "client"
          && frame.result.deviceId === fixture.deviceId && frame.result.machineId === fixture.machineId
        if (frame.id !== undefined && frame.id === worker.inventoryId && frame.result?.machine.id === fixture.machineId) {
          if (!worker.client || !worker.verified) observationError = new Error("Inventory arrived without client authority")
          else inventoryCount += 1
        }
      }
    }
    const pending = waiting.get(reply.id)
    if (!pending) return
    waiting.delete(reply.id)
    if (reply.error) pending.reject(new Error(reply.error.message))
    else pending.resolve(reply.result)
  })
  socket.on("close", () => { for (const pending of waiting.values()) pending.reject(new Error("Debugging socket closed")); waiting.clear() })
  const command = async (method, params = {}, sessionId) => {
    const id = ++sequence
    try {
      return await bounded(new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      }), method)
    } finally { waiting.delete(id) }
  }
  const poll = async (read, label) => {
    while (remaining() > 0) {
      const value = await read()
      if (value) return value
      await bounded(new Promise(resolve => setTimeout(resolve, 50)), label)
    }
    throw new Error(`Fleet Desktop proof expired: ${label}`)
  }
  const page = await poll(async () => (await command("Target.getTargets")).targetInfos.find(target => target.type === "page" && target.url.startsWith("domovoi-app://desktop/")), "renderer target")
  const { sessionId } = await command("Target.attachToTarget", { targetId: page.targetId, flatten: true })
  await command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
  const evaluate = async expression => {
    const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (response.exceptionDetails) throw new Error(`Renderer evaluation failed: ${String(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text).replaceAll(fixture.credential, "[test credential]")}`)
    return response.result?.value
  }
  const buttons = "[...document.querySelectorAll('button')].filter(button => button.getClientRects().length)"
  const click = async name => poll(() => evaluate(`(() => {
    const button = ${buttons}.find(button => (button.getAttribute('aria-label') || button.textContent.trim()) === ${JSON.stringify(name)});
    if (!button || button.disabled) return false; button.click(); return true;
  })()`), `button ${name}`)
  const text = value => poll(() => evaluate(`document.body?.innerText.includes(${JSON.stringify(value)})`), `text ${value}`)
  const capture = async (name, width) => {
    if (!images) return
    await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
    await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))")
    const image = await command("Page.captureScreenshot", { format: "png" }, sessionId)
    await mkdir(resolve(images), { recursive: true })
    await writeFile(join(resolve(images), `${name}-${width}.png`), Buffer.from(image.data, "base64"))
  }
  await text("Home")
  await evaluate(`${buttons}.find(button => button.textContent.trim() === 'Skip for now')?.click()`)
  await click("Settings")
  await click("Fleet & machines")
  await text("Studio")
  console.info("Fleet proof: enrolled row rendered")
  assert.equal(await evaluate(`${buttons}.find(button => button.getAttribute('aria-label') === 'Use Studio').disabled`), true)
  await click("Authorize this client for Studio")
  await text('domovoid pair --client desktop --label "My desktop"')
  await capture("authorize", 1280)
  await capture("authorize", 430)
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
  await evaluate(`(() => {
    const input = document.querySelector('input[type=password]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(fixture.credential)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await click("Verify client access")
  await text("Client credential verified")
  console.info("Fleet proof: client credential verified")
  await capture("admitted", 1280)
  await capture("admitted", 430)
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
  // With home still selected, this read can only come from admitted fan-out.
  await click("Skills")
  await poll(async () => {
    if (observationError) throw observationError
    return inventoryCount > 0
  }, "admitted inventory fan-out")
  console.info("Fleet proof: admitted inventory observed")
  await click("Settings")
  await click("Fleet & machines")
  await click("Use Studio")
  await text("Remote proof session")
  await click("Settings")
  await click("Skills")
  await text("Machine comparison")
  await poll(() => evaluate(`(() => {
    const title = [...document.querySelectorAll('[data-slot=card-title]')].find(node => node.textContent === 'Machine comparison');
    const text = title?.closest('[data-slot=card]')?.textContent ?? '';
    return text.includes('Home') && text.includes('Studio') && text.includes('Missing');
  })()`), "two-daemon inventory comparison")
  await click("Return to home daemon")
  await click("Settings")
  await click("Fleet & machines")
  await click("Terminal on Studio")
  await text("desktop-owned")
  await click("Return to home daemon")
  await click("Settings")
  await click("Fleet & machines")
  await click("Remove local access")
  await text("Devices list")
  assert.equal(await evaluate(`${buttons}.find(button => button.getAttribute('aria-label') === 'Use Studio').disabled`), true)
  console.info("DOMOVOI_FLEET_CLIENT_PROOF_OK use=1 terminal=1 inventory=1 comparison=1 remove=1")
} catch (error) {
  console.error(backendOutput, desktopOutput)
  throw error
} finally {
  socket?.terminate()
  // These exact child handles were created above in this worktree. Do not
  // signal names, patterns or process groups shared with other worktrees.
  async function retire(child, stop) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    let force, deadline
    const exited = new Promise((resolve, reject) => {
      const onExit = () => { clearTimeout(deadline); resolve() }
      child.once("exit", onExit)
      deadline = setTimeout(() => {
        child.removeListener("exit", onExit)
        reject(new Error(`Fleet proof child did not exit; fixture retained at ${directory}`))
      }, 15_000)
    })
    // The cleanup has its own finite budget after the proof's clock expires.
    force = setTimeout(() => child.kill("SIGKILL"), 10_000)
    try {
      try { stop() } catch { child.kill() }
      await exited
    } finally { clearTimeout(force); clearTimeout(deadline) }
  }
  const retired = await Promise.allSettled([
    retire(desktop, () => desktop.kill()),
    retire(backend, () => backend.connected ? backend.send("stop", () => {}) : backend.kill()),
  ])
  const failure = retired.find(result => result.status === "rejected")
  if (failure) throw failure.reason
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
