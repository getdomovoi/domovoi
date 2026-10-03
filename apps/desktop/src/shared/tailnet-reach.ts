// TailnetReach (Q404 A), what the main process tells Settings. The same shapes
// are declared for the renderer in packages/ui (desktop-platform.ts); the
// preload checks every value against them before the renderer sees it.

// none: no tailnet to reach. Tailscale is not installed, not running, or gives
// this machine no name. detail says which, in Tailscale's words where it gave any.
// off and on: the switch, with the name and address read from Tailscale (off)
// or saved when it was turned on (on). certificateExpiresAt: the stored
// certificate's notAfter, when one is stored and readable. stored: where the
// certificate and key are kept, shortened for display. renewalFailed: the
// last renewal check failed, when and why; the stored certificate is still
// the one in use. ignored: why the daemon inside this app does not use the
// switch's settings (a hand-set DOMOVOI_HOST beyond loopback).
export type TailnetReachReport =
  | { state: "none"; detail: string }
  | {
      state: "off" | "on"
      name: string
      address: string
      stored: string
      httpsCertificates: boolean
      certificateExpiresAt?: string
      renewalFailed?: { at: string; message: string }
      ignored?: string
    }

// The step a change stopped at, in the order the card lists them.
export const tailnetReachSteps = ["status", "certificate", "store", "restart", "delete"] as const
export type TailnetReachStep = (typeof tailnetReachSteps)[number]

// busy: another change is running. none: no tailnet. https-off: tailscale
// status lists no certificate domain for this machine, so the tailnet's admin
// has not turned on HTTPS certificates. refused: nothing was changed,
// for the reason in message. failed: the step failed; message says what was
// left as it was.
export const tailnetReachFailures = ["busy", "none", "https-off", "refused", "failed"] as const
export type TailnetReachFailure = (typeof tailnetReachFailures)[number]

export type TailnetReachOutcome =
  | { ok: true; report: TailnetReachReport }
  | { ok: false; reason: TailnetReachFailure; step: TailnetReachStep; message: string; detail?: string }
