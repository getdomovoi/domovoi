import { useEffect, useState, type CSSProperties, type ReactNode, type Ref } from "react"

import { previewGrantFresh } from "./preview-grant"

// The one place a preview document is framed (AGENTS.md: preview documents
// execute only inside sandboxed artifact containers). The sandbox allows
// scripts and nothing else: no same origin, forms, popups or top navigation,
// so the page runs on an opaque origin. It is fixed here and is not a prop;
// preview-frame-sandbox.test.ts keeps every other module from framing a
// preview itself.
//
// A frame keeps the URL it first loaded for a document. A renewed grant
// changes the URL but must not reload the page on screen, so only a new
// document (or a new bridge channel, which is part of `documentKey`) or the
// loss of the URL moves the frame. With `expiresAtMs` (the grant's expiry on
// this client's clock), a grant about to lapse is not loaded; the frame waits
// for the renewal instead.
export function PreviewFrame({
  url,
  expiresAtMs,
  documentKey,
  title,
  frameRef,
  onLoad,
  className,
  style,
  unavailable,
}: {
  url: string | undefined
  expiresAtMs?: number | undefined
  documentKey: string
  title: string
  frameRef?: Ref<HTMLIFrameElement> | undefined
  onLoad?: (() => void) | undefined
  className?: string | undefined
  style?: CSSProperties | undefined
  unavailable?: ReactNode
}) {
  const loadableUrl = expiresAtMs === undefined || previewGrantFresh(expiresAtMs) ? url : undefined
  const [latched, setLatched] = useState(() => loadableUrl === undefined ? undefined : { documentKey, url: loadableUrl })
  // No URL at all (no grant, offline, refused) blanks the frame as before.
  const current = url !== undefined && latched?.documentKey === documentKey ? latched.url : undefined

  useEffect(() => {
    if (url === undefined) setLatched(undefined)
    else if (current === undefined && loadableUrl !== undefined) setLatched({ documentKey, url: loadableUrl })
  }, [current, documentKey, loadableUrl, url])

  // Nothing loaded yet and only a lapsed grant to load: say why, if told.
  if (current === undefined && url !== undefined && loadableUrl === undefined && unavailable) return unavailable

  return (
    <iframe
      ref={frameRef}
      className={className}
      style={style}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={current ?? "about:blank"}
      title={title}
      onLoad={onLoad}
    />
  )
}
