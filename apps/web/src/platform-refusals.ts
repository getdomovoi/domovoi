export const browserRefusalReasons = [
  "dialogs-unsupported",
  "notifications-unsupported",
  "notifications-requires-install",
  "notifications-not-allowed",
  "notifications-denied",
  "clipboard-unsupported",
  "clipboard-insecure-context",
  "clipboard-denied",
  "install-unsupported",
  "credentials-unavailable",
] as const

export type BrowserRefusalReason = (typeof browserRefusalReasons)[number]

// Every capability the browser cannot honour has copy here before it compiles,
// so a refused surface always says what stopped it and what the reader can do
// instead. A control that quietly does nothing is the failure this replaces.
export const browserRefusalMessage: Record<BrowserRefusalReason, string> = {
  "dialogs-unsupported": "A browser cannot open a folder picker on the execution machine, so type the repository path instead.",
  "notifications-unsupported": "This browser does not provide the Notifications API, so Domovoi cannot raise one here.",
  "notifications-requires-install": "This browser raises notifications only for an installed web app, so add Domovoi to the Home Screen first.",
  "notifications-not-allowed": "This browser has not been allowed to raise Domovoi notifications, so allow them under Notifications in settings.",
  "notifications-denied": "This browser has blocked notifications for Domovoi, so allow them in its site settings.",
  "clipboard-unsupported": "This browser does not provide the async clipboard, so copy the value by hand.",
  "clipboard-insecure-context": "The browser clipboard needs an HTTPS or localhost origin, so this page cannot write to it.",
  "clipboard-denied": "This browser refused clipboard access for Domovoi, so copy the value by hand.",
  "install-unsupported": "This browser offers no install prompt, so use its own add to Home Screen or install menu item.",
  "credentials-unavailable": "This browser blocked session storage, so Domovoi cannot hold a daemon credential for this tab.",
}

export class BrowserCapabilityError extends Error {
  readonly reason: BrowserRefusalReason

  constructor(reason: BrowserRefusalReason) {
    super(browserRefusalMessage[reason])
    this.name = "BrowserCapabilityError"
    this.reason = reason
  }
}
