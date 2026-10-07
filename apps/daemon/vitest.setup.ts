import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, sep, win32 } from "node:path"

import { afterAll, afterEach, beforeEach } from "vitest"

export function daemonTestEnvironment(platform: NodeJS.Platform, home: string): NodeJS.ProcessEnv {
  return {
    HOME: home, USERPROFILE: home,
    ...(platform === "win32" ? { TEMP: win32.join(home, "tmp"), TMP: win32.join(home, "tmp") } : {}),
  }
}

const inheritedHome = homedir()
const inheritedProfile = process.env.DOMOVOI_PROFILE_DIR
const protectedProfiles = [join(inheritedHome, ".domovoi"), ...(inheritedProfile ? [inheritedProfile] : [])]
const home = mkdtempSync(join(tmpdir(), "domovoi-vitest-home-"))
const environment = daemonTestEnvironment(process.platform, home)
// Windows runtime staging requires temp paths to remain inside USERPROFILE.
if (environment.TEMP !== undefined) mkdirSync(environment.TEMP)

// setupFiles run before each test file is imported. Assign directly so a test's
// vi.unstubAllEnvs() restores this scratch home, never the runner's live home.
// DomovoiDaemon's direct constructor reads homedir(), not DOMOVOI_PROFILE_DIR.
Object.assign(process.env, environment)
// An inherited explicit profile would escape HOME isolation in production
// entry points and override the homes supplied by child-process fixtures.
delete process.env.DOMOVOI_PROFILE_DIR
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

beforeEach(assertIsolatedProfile)
afterEach(assertIsolatedProfile)
// Registered before test-file hooks, so Vitest's reverse afterAll order lets
// file-owned daemons and child processes stop before their home is removed.
// Do not import project helpers here: setup imports are cached before a test
// file can mock their dependencies. Node retries handles held during cleanup.
afterAll(() => rm(home, { recursive: true, force: true, maxRetries: 25, retryDelay: 20 }))
