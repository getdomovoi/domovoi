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

type GrantState = {
  key: string
  access?: ArtifactAccess
  error: string
  renewalError: string
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

// One preview document's grant. It is requested when the document changes and
// renewed ahead of expiry only while the preview is on screen (`active`), so a
// hidden dock does not keep signing grants; when it shows again an expired
// grant is renewed at once.
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
  const [state, setState] = useState<GrantState>({ key, error: "", renewalError: "" })
  const current = state.key === key ? state : { key, error: "", renewalError: "" }
  const access = current.access

  useEffect(() => {
    let live = true
    setState({ key, error: "", renewalError: "" })
    if (!enabled || sessionId === undefined || artifactId === undefined || revision === undefined) {
      return () => { live = false }
    }
    void authorize({ sessionId, artifactId, revision, purpose: "preview", bridgeChannel, parentOrigin: window.location.origin }).then(
      (granted) => { if (live) setState({ key, access: granted, error: "", renewalError: "" }) },
      (cause: unknown) => {
        if (live) setState({ key, error: errorText(cause, "Preview access could not be authorized"), renewalError: "" })
      },
    )
    return () => { live = false }
  }, [artifactId, authorize, bridgeChannel, enabled, key, revision, sessionId])

  useEffect(() => {
    if (!access || !active || !enabled) return
    let live = true
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
          if (live) setState((previous) => previous.key === key ? { ...previous, access: granted, renewalError: "" } : previous)
        },
        (cause: unknown) => {
          if (live) setState((previous) => previous.key === key
            ? { ...previous, renewalError: errorText(cause, "The preview grant could not be renewed") }
            : previous)
        },
      )
    }, previewGrantRenewDelay(access.expiresAt, Date.now()))
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [access, active, authorize, bridgeChannel, enabled, key])

  return { access, error: current.error, renewalError: current.renewalError }
}
