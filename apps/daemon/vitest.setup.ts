import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
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

export function daemonTestEnvironment(platform: NodeJS.Platform, home: string): NodeJS.ProcessEnv {
  return {
    HOME: home, USERPROFILE: home,
    ...(platform === "win32" ? { TEMP: home, TMP: home } : {}),
  }
}

const inheritedHome = homedir()
const inheritedProfile = process.env.DOMOVOI_PROFILE_DIR
const protectedProfiles = [join(inheritedHome, ".domovoi"), ...(inheritedProfile ? [inheritedProfile] : [])]
const home = mkdtempSync(daemonTestHomePrefix(process.platform, tmpdir()))
const environment = daemonTestEnvironment(process.platform, home)
// ONE-OFF CI-2 bisection. Retain scratch allocation and cleanup, but leave
// Darwin's inherited HOME in place for one CI run. Restore isolation after it.
const isolateHome = process.platform !== "darwin"
// Windows staging stays inside USERPROFILE. Reuse the created home as TEMP
// itself so the redirect adds no further directory components.

// setupFiles run before each test file is imported. Assign directly so a test's
// vi.unstubAllEnvs() restores this scratch home, never the runner's live home.
// DomovoiDaemon's direct constructor reads homedir(), not DOMOVOI_PROFILE_DIR.
if (isolateHome) Object.assign(process.env, environment)
// An inherited explicit profile would escape HOME isolation in production
// entry points and override the homes supplied by child-process fixtures.
delete process.env.DOMOVOI_PROFILE_DIR
if (isolateHome) assert.equal(homedir(), home, "Daemon tests must resolve the scratch HOME")

function assertIsolatedProfile() {
  if (!isolateHome) return
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
