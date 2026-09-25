import type { LocalDaemonHandle } from "@getdomovoi/daemon"

import type { DesktopDaemonSeam } from "./desktop-daemon.js"

// The development loop points the watched window at either the fixture or an
// already-running local daemon. Both live outside Electron, so a renderer reload
// and a main relaunch return to the same state rather than to a first run.
//
// A packaged build has no path to it: the environment variable is read only
// when the app is unpackaged, and the URL must be loopback WebSocket. The
// packaged refusal is a test, not a comment.
export const devFixtureUrlVariable = "DOMOVOI_DEV_FIXTURE_URL"
export const devDaemonUrlVariable = "DOMOVOI_DEV_DAEMON_URL"
export const devDaemonTokenVariable = "DOMOVOI_DEV_DAEMON_TOKEN"

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
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") return null
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

export function devLoopEndpoint(options: {
  isPackaged: boolean
  environment: NodeJS.ProcessEnv
}): { kind: "fixture" | "daemon"; endpoint: { url: string; token: string } } | null {
  if (options.isPackaged) return null
  const fixtureConfigured = Boolean(options.environment[devFixtureUrlVariable])
  const daemonConfigured = Boolean(
    options.environment[devDaemonUrlVariable] || options.environment[devDaemonTokenVariable],
  )
  if (fixtureConfigured && daemonConfigured) return null
  if (fixtureConfigured) {
    const endpoint = devFixtureEndpoint(options)
    return endpoint ? { kind: "fixture", endpoint } : null
  }
  if (!daemonConfigured) return null
  const url = loopbackFixtureUrl(options.environment[devDaemonUrlVariable])
  const token = options.environment[devDaemonTokenVariable]
  if (!url || !token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null
  return { kind: "daemon", endpoint: { url: url.href, token } }
}

// A main or preload edit relaunches the window, and the outgoing process still
// holds the single-instance lock while the incoming one starts. The incoming
// window then quits and the loop ends on every main edit. A development-loop
// window owns no daemon: the fixture is external, and the real mode attaches to
// an explicitly selected external daemon. Those watched windows skip the app
// lock; every other window, packaged or not, still takes it.
export function shouldRequireSingleInstanceLock(options: {
  isPackaged: boolean
  environment: NodeJS.ProcessEnv
}): boolean {
  return devLoopEndpoint(options) === null
}

// The production seam is returned untouched whenever no development endpoint
// applies, so ordinary Desktop acquisition keeps its existing shape.
export function resolveDesktopDaemonSeam(options: {
  isPackaged: boolean
  environment: NodeJS.ProcessEnv
  acquire: DesktopDaemonSeam
}): DesktopDaemonSeam {
  const selected = devLoopEndpoint(options)
  if (!selected) return options.acquire
  const handle: LocalDaemonHandle = selected.kind === "fixture"
    ? { kind: "owned", endpoint: selected.endpoint, stop: () => Promise.resolve() }
    : {
        kind: "attached",
        owner: "daemon",
        endpoint: selected.endpoint,
        closed: new Promise<void>(() => {}),
        detach: () => {},
      }
  return () => Promise.resolve(handle)
}
