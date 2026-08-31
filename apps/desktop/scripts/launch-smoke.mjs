#!/usr/bin/env node

import { spawn } from "node:child_process"
import { access, mkdtemp, mkdir, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import electronPath from "electron"

import { launchSmokeElectronArgs } from "./launch-smoke-args.mjs"

const successMarker = "DOMOVOI_DESKTOP_LAUNCH_SMOKE_OK"
const timeoutMs = 15_000
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
const env = {
  ...process.env,
  APPDATA: join(profileRoot, "config"),
  DOMOVOI_AUTH_TOKEN: "desktop-launch-smoke-token",
  DOMOVOI_DESKTOP_LAUNCH_SMOKE: "1",
  HOME: profileRoot,
  LOCALAPPDATA: join(profileRoot, "data"),
  XDG_CACHE_HOME: join(profileRoot, "cache"),
  XDG_CONFIG_HOME: join(profileRoot, "config"),
  XDG_DATA_HOME: join(profileRoot, "data"),
}

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

  process.stdout.write(`${successMarker}\n`)
} catch (error) {
  if (stdout) process.stderr.write(`desktop stdout:\n${stdout}`)
  if (stderr) process.stderr.write(`desktop stderr:\n${stderr}`)
  throw error
} finally {
  await rm(profileRoot, { force: true, recursive: true })
}
