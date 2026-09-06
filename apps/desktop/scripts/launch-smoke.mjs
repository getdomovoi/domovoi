#!/usr/bin/env node

import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import electronPath from "electron"

import { launchSmokeElectronArgs, launchSmokeEnvironment, launchSmokeTimeoutMs } from "./launch-smoke-args.mjs"
import {
  assertDaemonProfile,
  assertSmokeProcess,
  createSmokeProfile,
  executableOnPath,
  reportSmokeOutput,
  runSmokeProcess,
  successMarker,
} from "./desktop-smoke.mjs"

const description = "desktop launch smoke"
const timeoutMs = launchSmokeTimeoutMs({ platform: process.platform, env: process.env })
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const profileRoot = await createSmokeProfile("domovoi-desktop-smoke-")
const electronArgs = launchSmokeElectronArgs({
  platform: process.platform,
  ci: process.env.CI === "true",
  desktopRoot,
})
const xvfb = process.platform === "linux" ? await executableOnPath("xvfb-run") : undefined
const command = xvfb ?? electronPath
const args = xvfb ? ["--auto-servernum", electronPath, ...electronArgs] : electronArgs

let result
try {
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
  if (result) reportSmokeOutput(result)
  throw error
} finally {
  await rm(profileRoot, { force: true, recursive: true })
}
