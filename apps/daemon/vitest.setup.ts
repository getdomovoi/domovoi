import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, sep, win32 } from "node:path"

import { afterAll, afterEach, beforeEach } from "vitest"

export function daemonTestHomePrefix(platform: NodeJS.Platform, temporaryDirectory: string): string {
  // A sibling of Windows Temp leaves room for long fixture filenames and Git
  // checkpoint ref locks without changing Git's path handling.
  return platform === "win32"
    ? win32.join(win32.dirname(temporaryDirectory), "dv-")
    : join(temporaryDirectory, "domovoi-vitest-home-")
}

export function createDaemonTestHome(
  platform: NodeJS.Platform,
  temporaryDirectory: string,
  mkdtemp: (prefix: string) => string,
): string {
  try {
    return mkdtemp(daemonTestHomePrefix(platform, temporaryDirectory))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code
    if (platform !== "win32" || (code !== "EACCES" && code !== "EPERM")) throw error
    // TEMP itself may be writable even when its parent refuses siblings.
    return mkdtemp(win32.join(temporaryDirectory, "dv-"))
  }
}

export function daemonTestEnvironment(platform: NodeJS.Platform, home: string): NodeJS.ProcessEnv {
  return {
    HOME: home, USERPROFILE: home,
    ...(platform === "win32" ? { TEMP: home, TMP: home } : {}),
  }
}

export function daemonTestLoginProfile(path: string): string {
  return `export PATH='${path.replaceAll("'", "'\\''")}'\n`
}

// The real service manager runner (src/service/manager-guard.ts) refuses every
// command while this names a directory, and records each refusal there. The
// name is repeated rather than imported because setup imports no project
// modules; manager-guard.test.ts pins the two together.
export const serviceManagerRefusalVariable = "DOMOVOI_TEST_SERVICE_MANAGER_REFUSALS"

// Reads and clears the refusals recorded so far.
export function takeServiceManagerRefusals(directory: string): string[] {
  const names = readdirSync(directory).sort()
  const refused = names.map((name) => readFileSync(join(directory, name), "utf8"))
  for (const name of names) rmSync(join(directory, name), { force: true })
  return refused
}

export const inheritedPath = process.env.PATH ?? ""
const inheritedHome = homedir()
const inheritedProfile = process.env.DOMOVOI_PROFILE_DIR
const protectedProfiles = [join(inheritedHome, ".domovoi"), ...(inheritedProfile ? [inheritedProfile] : [])]
const home = createDaemonTestHome(process.platform, tmpdir(), mkdtempSync)
// Outside the scratch home, so a test that empties its HOME cannot remove it.
export const serviceManagerRefusals = mkdtempSync(join(tmpdir(), "domovoi-vitest-refusals-"))
// Login-shell tool PATH must match the runner's. An empty HOME on macOS
// otherwise falls back to /usr/bin xcrun shims instead of Homebrew tools.
if (process.platform !== "win32") {
  const profile = daemonTestLoginProfile(inheritedPath)
  for (const name of [".profile", ".bash_profile", ".zprofile"]) {
    writeFileSync(join(home, name), profile, { mode: 0o600 })
  }
}
const environment = daemonTestEnvironment(process.platform, home)
// Windows staging stays inside USERPROFILE. Reuse the created home as TEMP
// itself so the redirect adds no further directory components.

// setupFiles run before each test file is imported. Assign directly so a test's
// vi.unstubAllEnvs() restores this scratch home, never the runner's live home.
// DomovoiDaemon's direct constructor reads homedir(), not DOMOVOI_PROFILE_DIR.
Object.assign(process.env, environment)
// An inherited explicit profile would escape HOME isolation in production
// entry points and override the homes supplied by child-process fixtures.
delete process.env.DOMOVOI_PROFILE_DIR
// Set for every file, so a native file's opt-in ends with that file.
// Children that inherit this environment refuse the same way.
process.env[serviceManagerRefusalVariable] = serviceManagerRefusals
assert.equal(homedir(), home, "Daemon tests must resolve the scratch HOME")

function assertIsolatedProfile() {
  assert.notEqual(homedir(), inheritedHome, "Daemon tests must not restore the inherited HOME")
  const profile = process.env.DOMOVOI_PROFILE_DIR ?? join(homedir(), ".domovoi")
  for (const protectedProfile of protectedProfiles) {
    const path = relative(protectedProfile, profile)
    assert.ok(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path),
      "Daemon tests must not select an inherited profile")
  }
}

// A refusal fails the test that caused it, even where the code under test
// caught the error. One recorded after the last test fails the file.
function assertNoServiceManagerRefusals() {
  const refused = takeServiceManagerRefusals(serviceManagerRefusals)
  if (refused.length > 0) {
    throw new Error(`A daemon test reached the real service manager, which refused: ${refused.join("; ")}. `
      + "Inject fake run and capture effects, or gate the test as a native service test.")
  }
}

beforeEach(assertIsolatedProfile)
afterEach(assertIsolatedProfile)
afterEach(assertNoServiceManagerRefusals)
afterAll(() => {
  try { assertNoServiceManagerRefusals() }
  finally { rmSync(serviceManagerRefusals, { recursive: true, force: true }) }
})
// Registered before test-file hooks, so Vitest's reverse afterAll order lets
// file-owned daemons and child processes stop before their home is removed.
// Do not import project helpers here: setup imports are cached before a test
// file can mock their dependencies. Node retries handles held during cleanup.
afterAll(() => rm(home, { recursive: true, force: true, maxRetries: 25, retryDelay: 20 }))
