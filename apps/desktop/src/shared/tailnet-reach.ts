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
// switch's settings (a hand-set DOMOVOI_HOST beyond loopback). handSet: the
// daemon inside this app takes a tailnet listener from DOMOVOI_TAILNET_* set
// by hand, which turning the switch off does not clear. kept, setAside and
// undeleted: see below.
export type TailnetReachReport =
  | ({ state: "none"; detail: string } & TailnetReachRetained)
  | ({
      state: "off" | "on"
      name: string
      address: string
      stored: string
      httpsCertificates: boolean
      certificateExpiresAt?: string
      renewalFailed?: { at: string; message: string }
      ignored?: string
      handSet?: string
    } & TailnetReachRetained)

// Codex review round 6 (P3-1): the pending directories still holding files
// of the switch's, each shortened for display and never removed for the
// person. Said with every state, since turning off does not need Tailscale.
export type TailnetReachRetained = {
  // Previous files a change could not put back.
  kept?: string
  // Previous files the sweep found when the app started. It may be from a
  // put-back that failed or from a change cut off before it finished.
  setAside?: string
  // Q417 A: the files a turn-off set aside and then could not delete, once
  // the record was gone. The switch is off.
  undeleted?: string
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
  // Codex review of PR #722 (P3-2), Q439 B: a turn-off that is done, whose
  // status read after it did not answer by its deadline. undeleted: the
  // directory holding the files it set aside and could not delete. Round 2
  // (P3-2): a turn-on that is done answers the same way, never with undeleted.
  | { ok: true; statusUnanswered: true; undeleted?: string }
  // Codex review of PR #722, round 2 (P3-R2-2), Q441 A: a turn-off that is
  // done, whose status read after it failed before its deadline. statusFailed:
  // the read's own words. undeleted: as above. A turn-on that is done answers
  // the same way, never with undeleted.
  | { ok: true; statusFailed: string; undeleted?: string }
  // undeleted (Codex review round 6, P3-2): the restart failed after a
  // turn-off deleted the record but could not delete the files it set aside,
  // which are in this directory; the deletion step is not done.
  | { ok: false; reason: TailnetReachFailure; step: TailnetReachStep; message: string; detail?: string; undeleted?: string }
