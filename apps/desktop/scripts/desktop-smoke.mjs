import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

// The main process prints this once the renderer has answered over real IPC.
export const successMarker = "DOMOVOI_DESKTOP_LAUNCH_SMOKE_OK"
// The label the desktop pairs itself under while the smoke flag is set.
export const smokeDeviceLabel = "Desktop launch smoke"

export async function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

export async function createSmokeProfile(prefix) {
  const profileRoot = await mkdtemp(join(tmpdir(), prefix))
  await Promise.all([
    mkdir(join(profileRoot, "config")),
    mkdir(join(profileRoot, "cache")),
    mkdir(join(profileRoot, "data")),
  ])
  return profileRoot
}

function stopProcessTree(child) {
  if (!child.pid) return
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    })
    taskkill.once("error", () => child.kill())
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {}
}

// The parent bounds the whole child lifetime, including its own children, so a
// hung renderer cannot leave an Electron process behind after the run reports.
export function runSmokeProcess({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let closed = false
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })

    const timeout = setTimeout(() => {
      timedOut = true
      stopProcessTree(child)
      setTimeout(() => {
        if (!closed && process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch {}
        }
      }, 2_000).unref()
    }, timeoutMs)

    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.once("close", (code, signal) => {
      closed = true
      clearTimeout(timeout)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}

export function assertSmokeProcess(result, { timeoutMs, description }) {
  if (result.timedOut) throw new Error(`${description} timed out after ${timeoutMs}ms`)
  if (result.code !== 0) {
    throw new Error(`${description} exited with code ${result.code ?? "null"} (${result.signal ?? "no signal"})`)
  }
  if (!result.stdout.split(/\r?\n/u).includes(successMarker)) {
    throw new Error(`${description} did not emit ${successMarker}`)
  }
}

// Renderer readiness alone is not daemon assembly. The production factory must
// have opened its persistent store in this isolated profile, minted a
// credential, used it for hello and revoked it through real renderer RPC.
export async function assertDaemonProfile(profileRoot, description) {
  const daemonState = join(profileRoot, ".domovoi", "state.sqlite")
  if (!await access(daemonState).then(() => true, () => false)) {
    throw new Error(`${description} never started the production daemon: state.sqlite is missing`)
  }
  const owner = JSON.parse(await readFile(join(profileRoot, ".domovoi", "local-owner.json"), "utf8"))
  if (owner.state !== "none") throw new Error(`${description} did not release its daemon owner`)
  // Read the store only after Electron exits.
  const database = new DatabaseSync(daemonState, { readOnly: true })
  try {
    const devices = database.prepare(
      "SELECT label, credential_role, client_kind, last_seen_at, revoked_at FROM paired_devices",
    ).all()
    if (devices.length !== 1 || devices[0].label !== smokeDeviceLabel
      || devices[0].credential_role !== "client" || devices[0].client_kind !== "desktop"
      || !devices[0].last_seen_at || !devices[0].revoked_at) {
      throw new Error(`${description} has no persisted authenticated and revoked client pairing`)
    }
  } finally { database.close() }
}

export function reportSmokeOutput({ stdout, stderr }) {
  if (stdout) process.stderr.write(`desktop stdout:\n${stdout}`)
  if (stderr) process.stderr.write(`desktop stderr:\n${stderr}`)
}
