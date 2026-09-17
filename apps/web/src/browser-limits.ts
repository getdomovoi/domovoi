import type { BrowserPlatformEnvironment } from "./browser-platform"
import { browserRefusalMessage } from "./platform-refusals"

// The design's third step: what a browser tab can and cannot do, stated
// before a person hits a refusal rather than at the moment they do. Every
// row that can be measured is measured against this browser, so the panel
// says what is true here, not what a browser in general might do. Each
// difference follows from one fact: no daemon, no repository, no keychain.

export type BrowserLimitTone = "same" | "conditional" | "refused" | "never"

export type BrowserLimitRow = {
  what: string
  state: string
  tone: BrowserLimitTone
  why: string
}

function routeName(rpcUrl: string): "loopback" | "the tailnet" | "the route" {
  try {
    const url = new URL(rpcUrl)
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") return "loopback"
    if (url.protocol === "wss:" || url.protocol === "https:") return "the tailnet"
  } catch {
    return "the route"
  }
  return "the route"
}

function notifications(environment: BrowserPlatformEnvironment): BrowserLimitRow {
  const what = "Notifications"
  const host = environment.notifications
  if (!host) {
    const reason = environment.install.homeScreenOnly && !environment.install.installed()
      ? "notifications-requires-install"
      : "notifications-unsupported"
    return { what, state: "refused", tone: "refused", why: browserRefusalMessage[reason] }
  }
  const permission = host.permission()
  if (permission === "granted") {
    return { what, state: "same as desktop", tone: "same", why: "This browser has allowed Domovoi to raise them." }
  }
  if (permission === "denied") {
    return { what, state: "refused", tone: "refused", why: browserRefusalMessage["notifications-denied"] }
  }
  return { what, state: "asks first", tone: "conditional", why: "This browser will ask once, the first time a session needs you while the tab is in the background." }
}

function clipboard(environment: BrowserPlatformEnvironment): BrowserLimitRow {
  const what = "Copy to the clipboard"
  if (!environment.clipboard) {
    return { what, state: "refused", tone: "refused", why: browserRefusalMessage["clipboard-unsupported"] }
  }
  if (!environment.secureContext) {
    return { what, state: "refused", tone: "refused", why: browserRefusalMessage["clipboard-insecure-context"] }
  }
  return { what, state: "same as desktop", tone: "same", why: "This page is on a secure origin and the browser provides the clipboard." }
}

function install(environment: BrowserPlatformEnvironment): BrowserLimitRow {
  const what = "Install as an app"
  if (environment.install.installed()) {
    return { what, state: "installed", tone: "same", why: "This tab is already running as an installed app." }
  }
  if (environment.install.promptable()) {
    return { what, state: "one prompt away", tone: "conditional", why: "This browser offers an install prompt, and an installed app can raise notifications." }
  }
  return { what, state: "from the browser menu", tone: "conditional", why: browserRefusalMessage["install-unsupported"] }
}

export function browserLimits(
  environment: BrowserPlatformEnvironment,
  rpcUrl: string,
  // Whether this tab could hold a credential at all: session storage is what
  // keeps it, and a browser can block that.
  credentialStorable: boolean,
): BrowserLimitRow[] {
  const route = routeName(rpcUrl)
  return [
    { what: "Watch a session live", state: "same as desktop", tone: "same", why: `The daemon streams the thread and the plan over ${route}.` },
    { what: "Answer a gate", state: "same as desktop", tone: "same", why: "The decision is a message, and the daemon records this browser as the device that sent it." },
    { what: "Read diffs", state: "same as desktop", tone: "same", why: "Diffs are computed on the machine and sent as text." },
    { what: "Terminal", state: "same as desktop", tone: "same", why: `At the machine itself, on ${route}, the terminal is never gated.` },
    notifications(environment),
    clipboard(environment),
    install(environment),
    { what: "Choose a folder", state: "type the path", tone: "conditional", why: browserRefusalMessage["dialogs-unsupported"] },
    { what: "Attach a local file", state: "not yet", tone: "conditional", why: "There is no shared filesystem, so a file from this device would have to travel to the machine, and that path is not built." },
    { what: "Open the repository", state: "not possible", tone: "never", why: "Nothing is cloned into the browser. Paths are read on the machine, one directory at a time." },
    credentialStorable
      ? { what: "Hold the credential", state: "this tab only", tone: "conditional", why: "The device credential lives in this tab's session storage. Closing the tab forgets it; pairing again mints another." }
      : { what: "Hold the credential", state: "refused", tone: "refused", why: browserRefusalMessage["credentials-unavailable"] },
  ]
}
