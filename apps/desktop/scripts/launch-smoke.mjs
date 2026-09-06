#!/usr/bin/env node

import { spawn } from "node:child_process"
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

import electronPath from "electron"

import { launchSmokeElectronArgs, launchSmokeEnvironment, launchSmokeTimeoutMs } from "./launch-smoke-args.mjs"

const successMarker = "DOMOVOI_DESKTOP_LAUNCH_SMOKE_OK"
const timeoutMs = launchSmokeTimeoutMs({ platform: process.platform, env: process.env })
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))

async function executableOnPath(name) {
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

const profileRoot = await mkdtemp(join(tmpdir(), "domovoi-desktop-smoke-"))
await Promise.all([
  mkdir(join(profileRoot, "config")),
  mkdir(join(profileRoot, "cache")),
  mkdir(join(profileRoot, "data")),
])

const electronArgs = launchSmokeElectronArgs({
  platform: process.platform,
  ci: process.env.CI === "true",
  desktopRoot,
})
const xvfb = process.platform === "linux" ? await executableOnPath("xvfb-run") : undefined
const command = xvfb ?? electronPath
const args = xvfb ? ["--auto-servernum", electronPath, ...electronArgs] : electronArgs
const env = launchSmokeEnvironment({ env: process.env, profileRoot, timeoutMs })

let stdout = ""
let stderr = ""
let timedOut = false

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

try {
  const result = await new Promise((resolve, reject) => {
    let closed = false
    const child = spawn(command, args, {
      cwd: desktopRoot,
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
      resolve({ code, signal })
    })
  })

  if (timedOut) throw new Error(`desktop launch smoke timed out after ${timeoutMs}ms`)
  if (result.code !== 0) {
    throw new Error(`desktop launch smoke exited with code ${result.code ?? "null"} (${result.signal ?? "no signal"})`)
  }
  if (!stdout.split(/\r?\n/u).includes(successMarker)) {
    throw new Error(`desktop launch smoke did not emit ${successMarker}`)
  }
  // Renderer readiness alone is not daemon assembly. The production factory
  // must have opened its persistent store in this isolated profile.
  const daemonState = join(profileRoot, ".domovoi", "state.sqlite")
  if (!await access(daemonState).then(() => true, () => false)) {
    throw new Error("desktop launch smoke never started the production daemon: state.sqlite is missing")
  }
  const owner = JSON.parse(await readFile(join(profileRoot, ".domovoi", "local-owner.json"), "utf8"))
  if (owner.state !== "none") throw new Error("desktop launch smoke did not release its daemon owner")
  // Read the store only after Electron exits. The positive witness is a
  // credential minted, used for hello and revoked through real renderer RPC.
  const database = new DatabaseSync(daemonState, { readOnly: true })
  try {
    const devices = database.prepare("SELECT label, credential_role, client_kind, last_seen_at, revoked_at FROM paired_devices").all()
    if (devices.length !== 1 || devices[0].label !== "Desktop launch smoke"
      || devices[0].credential_role !== "client" || devices[0].client_kind !== "desktop"
      || !devices[0].last_seen_at || !devices[0].revoked_at) {
      throw new Error("desktop launch smoke has no persisted authenticated and revoked client pairing")
    }
  } finally { database.close() }

  process.stdout.write(`${successMarker}\n`)
} catch (error) {
  if (stdout) process.stderr.write(`desktop stdout:\n${stdout}`)
  if (stderr) process.stderr.write(`desktop stderr:\n${stderr}`)
  throw error
} finally {
  await rm(profileRoot, { force: true, recursive: true })
}
