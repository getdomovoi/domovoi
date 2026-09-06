// Runs inside the packaged Electron binary with ELECTRON_RUN_AS_NODE set, so
// every module below is resolved out of the archive the installer ships rather
// than out of the repository. Prints one marked JSON line and exits.
const { join } = require("node:path")
const { pathToFileURL } = require("node:url")
const { Worker } = require("node:worker_threads")

const marker = "DOMOVOI_PACKAGED_NATIVE_PROBE "
const asar = process.argv[2]
const operationMs = 15_000

function withTimeout(promise, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not answer in ${operationMs}ms`)), operationMs)
    }),
  ])
}

function probeNodePty() {
  const pty = require(join(asar, "node_modules", "node-pty"))
  const windows = process.platform === "win32"
  const shell = windows ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh"
  const shellArgs = windows ? ["/c", "echo domovoi-pty-alive"] : ["-c", "echo domovoi-pty-alive"]
  const terminal = pty.spawn(shell, shellArgs, {
    name: "xterm-256color",
    cwd: windows ? (process.env.SystemRoot ?? "C:\\") : "/",
    cols: 80,
    rows: 24,
    env: process.env,
  })
  return withTimeout(new Promise((resolve) => {
    let output = ""
    terminal.onData((chunk) => {
      output += chunk
      if (output.includes("domovoi-pty-alive")) resolve({ loaded: true, pid: terminal.pid, wroteToPty: true })
    })
    terminal.onExit(() => resolve({ loaded: true, pid: terminal.pid, wroteToPty: output.includes("domovoi-pty-alive") }))
  }), "node-pty").finally(() => { try { terminal.kill() } catch {} })
}

function probeKeyringBinding() {
  const keyring = require(join(asar, "node_modules", "@napi-rs", "keyring"))
  const probe = { loaded: true, hasEntry: typeof keyring.Entry === "function" }
  try {
    // A reachable keychain answers with null for an account nothing wrote.
    probe.keychainRead = new keyring.Entry("domovoi.packaged-native-probe", "probe").getPassword()
  } catch (error) {
    probe.keychainError = String(error && error.message)
  }
  return probe
}

// The daemon reaches the keychain from a worker thread, never from the main
// one, so loading the binding on the main thread does not prove the shipped
// path works. This is that same require, in a real worker.
function probeKeyringInWorker() {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads")
    try {
      const keyring = require(require("node:path").join(workerData.asar, "node_modules", "@napi-rs", "keyring"))
      parentPort.postMessage({ loaded: typeof keyring.Entry === "function" })
    } catch (error) {
      parentPort.postMessage({ loaded: false, error: String(error && error.message) })
    }
  `
  const worker = new Worker(source, { eval: true, workerData: { asar } })
  return withTimeout(new Promise((resolve, reject) => {
    worker.once("message", resolve)
    worker.once("error", (error) => reject(error))
  }), "keyring worker thread").finally(() => worker.terminate())
}

// The daemon resolves this entry relative to its own module URL, which inside
// a packaged application is a path within the archive.
function probeDaemonKeyringWorker() {
  const entry = join(asar, "node_modules", "@getdomovoi", "daemon", "dist", "machine-keyring-worker.js")
  const worker = new Worker(pathToFileURL(entry))
  return withTimeout(new Promise((resolve, reject) => {
    worker.once("message", (message) => resolve({ replied: message.id === 1, keychainAnswered: message.ok === true }))
    worker.once("error", (error) => reject(error))
    worker.postMessage({
      id: 1,
      request: { kind: "machines" },
      cancelled: new SharedArrayBuffer(4),
      expiresAt: process.hrtime.bigint() + BigInt(operationMs) * 1_000_000n,
    })
  }), "daemon keyring worker").finally(() => worker.terminate())
}

async function settle(probe) {
  try {
    return await probe()
  } catch (error) {
    return { loaded: false, replied: false, error: String(error && error.message) }
  }
}

async function main() {
  const report = {
    asar,
    nodePty: await settle(probeNodePty),
    keyring: await settle(probeKeyringBinding),
    keyringInWorker: await settle(probeKeyringInWorker),
    daemonKeyringWorker: await settle(probeDaemonKeyringWorker),
  }
  process.stdout.write(`${marker}${JSON.stringify(report)}\n`)
}

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`${String(error && error.stack)}\n`)
  process.exit(1)
})
