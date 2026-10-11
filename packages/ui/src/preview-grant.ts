import { useEffect, useState } from "react"
import type { ArtifactAccess } from "@getdomovoi/protocol"

// The daemon signs a preview grant for one document, revision, bridge channel
// and parent origin, with a short expiry (artifact.authorize). A frame needs a
// live grant only when it loads; a page already loaded keeps running after its
// grant lapses. Q379 A keeps authorization automatic and renews on expiry, so
// the client asks for the next grant this far ahead of the current one's end,
// and a frame that mounts never loads a grant about to lapse.
export const previewGrantRenewLeadMs = 5_000

export function previewGrantMsLeft(access: Pick<ArtifactAccess, "expiresAt">, now: number): number {
  return access.expiresAt * 1_000 - now
}

export function previewGrantFresh(access: Pick<ArtifactAccess, "expiresAt">, now = Date.now()): boolean {
  return previewGrantMsLeft(access, now) > previewGrantRenewLeadMs
}

export function previewGrantRenewDelay(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt * 1_000 - previewGrantRenewLeadMs - now)
}

export function previewGrantLabel(msLeft: number): string {
  if (msLeft <= 0) return "authorization expired"
  const seconds = Math.ceil(msLeft / 1_000)
  return `authorized · ${seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`} left`
}

type AuthorizePreview = (input: {
  sessionId: string
  artifactId: string
  revision: number
  purpose: "preview"
  bridgeChannel: string
  parentOrigin: string
}) => Promise<ArtifactAccess>

// A failed renewal is retried after 1 s, then 2, 4, 8 and 16, and every 30 s
// after that, for as long as the preview stays on screen.
export const previewGrantRetryCapMs = 30_000

export function previewGrantRetryDelay(failures: number): number {
  return Math.min(previewGrantRetryCapMs, 1_000 * 2 ** Math.max(0, failures - 1))
}

type GrantState = {
  key: string
  access?: ArtifactAccess
  error: string
  renewalError: string
  renewalFailures: number
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

// One preview document's grant, asked for only while the preview is on screen
// (`active`): a dock opened on another tab signs nothing, and a hidden one
// stops renewing. On screen, the first grant is asked for at once and renewed
// ahead of expiry. A failed request is retried with backoff, and hiding the
// preview starts the backoff over, so showing it again asks at once. The
// first request's failure is `error`; a renewal's is `renewalError`.
export function usePreviewGrant({
  sessionId,
  artifactId,
  revision,
  bridgeChannel,
  enabled,
  active,
  authorize,
}: {
  sessionId: string | undefined
  artifactId: string | undefined
  revision: number | undefined
  bridgeChannel: string
  enabled: boolean
  active: boolean
  authorize: AuthorizePreview
}): { access: ArtifactAccess | undefined, error: string, renewalError: string } {
  const key = JSON.stringify([sessionId, artifactId, revision, bridgeChannel, enabled])
  const empty: GrantState = { key, error: "", renewalError: "", renewalFailures: 0 }
  const [state, setState] = useState<GrantState>(empty)
  const current = state.key === key ? state : empty
  const access = current.access
  const failures = current.renewalFailures

  // A new document, channel or connection drops what was held: a grant from
  // before a disconnect may be signed with a secret the daemon no longer has.
  useEffect(() => {
    setState((previous) => previous.key === key ? previous : { key, error: "", renewalError: "", renewalFailures: 0 })
  }, [key])

  useEffect(() => {
    // The state may still hold the previous document's; start from empty then.
    const base = (previous: GrantState): GrantState =>
      previous.key === key ? previous : { key, error: "", renewalError: "", renewalFailures: 0 }
    if (!active || !enabled || sessionId === undefined || artifactId === undefined || revision === undefined) {
      if (failures > 0) setState((previous) => ({ ...base(previous), renewalFailures: 0 }))
      return
    }
    let live = true
    const delay = failures > 0
      ? previewGrantRetryDelay(failures)
      : access ? previewGrantRenewDelay(access.expiresAt, Date.now()) : 0
    const timer = setTimeout(() => {
      void authorize({ sessionId, artifactId, revision, purpose: "preview", bridgeChannel, parentOrigin: window.location.origin }).then(
        (granted) => {
          if (live) setState({ key, access: granted, error: "", renewalError: "", renewalFailures: 0 })
        },
        (cause: unknown) => {
          // Counting the failure re-runs this effect, which schedules the retry.
          if (!live) return
          setState((previous) => {
            const state = base(previous)
            return state.access
              ? { ...state, renewalError: errorText(cause, "The preview grant could not be renewed"), renewalFailures: state.renewalFailures + 1 }
              : { ...state, error: errorText(cause, "Preview access could not be authorized"), renewalFailures: state.renewalFailures + 1 }
          })
        },
      )
    }, delay)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [access, active, artifactId, authorize, bridgeChannel, enabled, failures, key, revision, sessionId])

  return { access, error: current.error, renewalError: current.renewalError }
}
