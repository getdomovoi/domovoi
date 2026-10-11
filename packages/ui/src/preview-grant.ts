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

// One preview document's grant. It is requested when the document changes and
// renewed ahead of expiry only while the preview is on screen (`active`), so a
// hidden dock does not keep signing grants; when it shows again an expired
// grant is renewed at once. A failed renewal is retried with backoff and its
// message is kept in `renewalError` until a renewal succeeds.
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
  const renewalFailures = current.renewalFailures

  useEffect(() => {
    let live = true
    const reset: GrantState = { key, error: "", renewalError: "", renewalFailures: 0 }
    setState(reset)
    if (!enabled || sessionId === undefined || artifactId === undefined || revision === undefined) {
      return () => { live = false }
    }
    void authorize({ sessionId, artifactId, revision, purpose: "preview", bridgeChannel, parentOrigin: window.location.origin }).then(
      (granted) => { if (live) setState({ ...reset, access: granted }) },
      (cause: unknown) => {
        if (live) setState({ ...reset, error: errorText(cause, "Preview access could not be authorized") })
      },
    )
    return () => { live = false }
  }, [artifactId, authorize, bridgeChannel, enabled, key, revision, sessionId])

  useEffect(() => {
    if (!access || !active || !enabled) return
    let live = true
    const delay = renewalFailures === 0
      ? previewGrantRenewDelay(access.expiresAt, Date.now())
      : previewGrantRetryDelay(renewalFailures)
    const timer = setTimeout(() => {
      void authorize({
        sessionId: access.sessionId,
        artifactId: access.artifactId,
        revision: access.revision,
        purpose: "preview",
        bridgeChannel,
        parentOrigin: window.location.origin,
      }).then(
        (granted) => {
          if (live) setState((previous) => previous.key === key
            ? { ...previous, access: granted, renewalError: "", renewalFailures: 0 }
            : previous)
        },
        (cause: unknown) => {
          // Counting the failure re-runs this effect, which schedules the retry.
          if (live) setState((previous) => previous.key === key
            ? {
                ...previous,
                renewalError: errorText(cause, "The preview grant could not be renewed"),
                renewalFailures: previous.renewalFailures + 1,
              }
            : previous)
        },
      )
    }, delay)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [access, active, authorize, bridgeChannel, enabled, key, renewalFailures])

  return { access, error: current.error, renewalError: current.renewalError }
}
