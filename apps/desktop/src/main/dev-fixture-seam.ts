import type { LocalDaemonHandle } from "@getdomovoi/daemon"

import type { DesktopDaemonSeam } from "./desktop-daemon.js"

// The development loop points the window at a fixture daemon so the chrome can
// be rebuilt without a live machine. The fixture is a separate process holding
// its own state, so a renderer reload and a main relaunch both come back to the
// same fixture rather than to a first run.
//
// A packaged build has no path to it: the environment variable is read only
// when the app is unpackaged, and the URL must be loopback WebSocket. The
// packaged refusal is a test, not a comment.
export const devFixtureUrlVariable = "DOMOVOI_DEV_FIXTURE_URL"

// The daemon's own token format: 43 base64url characters. The fixture accepts
// any well-formed token, but a token the protocol refuses would fail the
// handshake, so this one is checked by the seam's tests rather than assumed.
export const devFixtureToken = "domovoi-development-fixture-token-000000000"

function loopbackFixtureUrl(value: string | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "ws:") return null
    if (url.username || url.password) return null
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null
    return url
  } catch {
    return null
  }
}

export function devFixtureEndpoint(options: {
  isPackaged: boolean
  environment: NodeJS.ProcessEnv
}): { url: string; token: string } | null {
  if (options.isPackaged) return null
  const url = loopbackFixtureUrl(options.environment[devFixtureUrlVariable])
  if (!url) return null
  return { url: url.href, token: devFixtureToken }
}

// A main or preload edit relaunches the window, and the outgoing process still
// holds the single-instance lock while the incoming one starts. The incoming
// window then quits and the loop ends on every main edit. Against the fixture
// the lock has nothing to protect, since no profile is claimed and no daemon is
// owned, so the fixture window skips it. Every other window, packaged or not,
// still takes the lock.
export function shouldRequireSingleInstanceLock(options: {
  isPackaged: boolean
  environment: NodeJS.ProcessEnv
}): boolean {
  return devFixtureEndpoint(options) === null
}

// The real seam is returned untouched whenever the fixture does not apply, so
// nothing about the production acquisition path changes shape in development.
export function resolveDesktopDaemonSeam(options: {
  isPackaged: boolean
  environment: NodeJS.ProcessEnv
  acquire: DesktopDaemonSeam
}): DesktopDaemonSeam {
  const endpoint = devFixtureEndpoint(options)
  if (!endpoint) return options.acquire
  const handle: LocalDaemonHandle = { kind: "owned", endpoint, stop: () => Promise.resolve() }
  return () => Promise.resolve(handle)
}
