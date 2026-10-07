#!/usr/bin/env node

import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import electronPath from "electron"

import { launchSmokeCommand, launchSmokeElectronArgs, launchSmokeEnvironment, launchSmokeTimeoutMs } from "./launch-smoke-args.mjs"
import {
  assertDaemonProfile,
  assertSmokeProcess,
  createSmokeProfile,
  executableOnPath,
  reportSmokeOutput,
  runSmokeProcess,
  successMarker,
} from "./desktop-smoke.mjs"
import { liveProfileSnapshot, liveProfileVerdict } from "./launch-smoke-live-profile.mjs"

const description = "desktop launch smoke"
const timeoutMs = launchSmokeTimeoutMs({ platform: process.platform, env: process.env })
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const liveProfile = await liveProfileSnapshot()
const profileRoot = await createSmokeProfile("domovoi-desktop-smoke-")
let result, failed = false
try {
  const electronArgs = launchSmokeElectronArgs({
    platform: process.platform,
    ci: process.env.CI === "true",
    desktopRoot,
    loginServiceOff: true,
  })
  const xvfb = process.platform === "linux" ? await executableOnPath("xvfb-run") : undefined
  const { command, args } = launchSmokeCommand({ platform: process.platform, env: process.env, electronPath, electronArgs, xvfb })
  result = await runSmokeProcess({
    command,
    args,
    cwd: desktopRoot,
    env: launchSmokeEnvironment({ env: process.env, profileRoot, timeoutMs }),
    timeoutMs,
  })
  assertSmokeProcess(result, { timeoutMs, description })
  await assertDaemonProfile(profileRoot, description)
  process.stdout.write(`${successMarker}\n`)
} catch (error) {
  failed = true
  if (result) reportSmokeOutput(result)
  throw error
} finally {
  // Taken before the cleanup, so a cleanup failure cannot skip it. It never
  // throws. A failure already on its way out keeps its own error, and the
  // others are printed beside it.
  const touched = await liveProfileVerdict(liveProfile)
  let cleanup
  try {
    await rm(profileRoot, { force: true, recursive: true })
  } catch (error) { cleanup = error }
  if (failed) {
    if (touched) console.error(touched)
    if (cleanup) console.error("Desktop launch smoke could not remove its profile", cleanup)
  } else if (touched) {
    if (cleanup) console.error("Desktop launch smoke could not remove its profile", cleanup)
    throw new Error(touched)
  } else if (cleanup) throw cleanup
}
