// One command for the desktop chrome loop: start the fixture daemon, then run
// Electron against it. The fixture is a separate process from the window, so a
// main or preload edit relaunches the window and comes back to the same fixture
// rather than to a first run.
//
// Fixture mode never touches a profile. Real mode reads the selected local
// profile's endpoint and token but never acquires, starts or stops its daemon.
// Both reach the window through a development seam a packaged build cannot take.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { start } from "./dev-fixture-daemon.mjs"
import { realDevEndpoint } from "./dev-real-endpoint.mjs"

const mode = process.argv[2] ?? "fixture"
if (mode !== "fixture" && mode !== "real") {
  throw new Error(`Unknown desktop development loop mode: ${mode}`)
}
const fixture = mode === "fixture"
  ? await start({ port: Number(process.env.DOMOVOI_DEV_FIXTURE_PORT ?? 0) })
  : undefined
const real = mode === "real"
  ? realDevEndpoint({ homeDirectory: homedir(), environment: process.env })
  : undefined
const stateDirectory = mkdtempSync(join(tmpdir(), "domovoi-dev-loop-"))

if (fixture) {
  console.log(`[loop] fixture daemon listening on ${fixture.url} (pid ${process.pid}).`)
  console.log("[loop] fixture state survives a window relaunch. Stop this command to discard it.")
} else {
  console.log(`[loop] real daemon at ${real.url}. Token read from the selected profile's daemon.token.`)
  console.log("[loop] daemon state survives a window relaunch. This command will not start or stop it.")
}

const childEnvironment = {
  ...process.env,
  DOMOVOI_DEV_LOOP_KIND: mode === "real" ? "daemon" : "fixture",
  DOMOVOI_DEV_LOOP_STATE: join(stateDirectory, "boots"),
}
if (fixture) {
  childEnvironment.DOMOVOI_DEV_FIXTURE_URL = fixture.url
  delete childEnvironment.DOMOVOI_DEV_DAEMON_URL
  delete childEnvironment.DOMOVOI_DEV_DAEMON_TOKEN
} else {
  childEnvironment.DOMOVOI_DEV_DAEMON_URL = real.url
  childEnvironment.DOMOVOI_DEV_DAEMON_TOKEN = real.token
  delete childEnvironment.DOMOVOI_DEV_FIXTURE_URL
}

// The child runs in its own process group so stopping this command stops the
// Electron processes with it. Killing the wrapper alone leaves them running,
// and a surviving window holds the single-instance lock that makes the next
// run quit before it opens.
// --watch is what rebuilds and relaunches on a main or preload edit. Without
// it the renderer still hot reloads, so the window looks alive while main-side
// edits do nothing at all.
const electron = spawn("npx", ["electron-vite", "dev", "--watch"], {
  stdio: "inherit",
  detached: true,
  env: childEnvironment,
})

const shutdown = async (code) => {
  await fixture?.close()
  rmSync(stateDirectory, { recursive: true, force: true })
  process.exit(code ?? 0)
}

const stopElectronGroup = (signal) => {
  if (electron.pid === undefined) return
  try {
    process.kill(-electron.pid, signal)
  } catch {
    // The group is already gone, which is the outcome this asks for.
  }
}

electron.on("exit", (code) => void shutdown(code ?? 0))
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopElectronGroup(signal))
}
process.on("exit", () => stopElectronGroup("SIGTERM"))
