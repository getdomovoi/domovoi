import { useEffect, useRef, useState, type ReactNode } from "react"

import type { ClientKind } from "@getdomovoi/protocol"
import { BrowserLimitsPanel, DaemonCredentialPrompt, WebConnectPage, WebPageHeader, type PairingOutcome } from "@getdomovoi/ui"
import { routeOfEndpoint } from "@/route-word"

import { browserLimits, type LimitsRoute } from "./browser-limits"
import { browserLimitsSeen, markBrowserLimitsSeen } from "./browser-limits-seen"
import type { BrowserPlatformEnvironment } from "./browser-platform"
import { browserDeviceLabel, clearConfirmedDaemonSession, clearDaemonSession, loadDaemonSession, saveDaemonSession, type DaemonSession } from "./credential"
import { codeNameFor, isLoopbackPageOrigin, pageOriginAgainstDaemon, pairBrowserDevice, pairingNextStep, pairingOutcomeFor, redeemBrowserCode, type PairingClientFactory } from "./daemon-pairing"

export type WebAppProps = {
  rpcUrl: string
  // The page's own origin, location.origin. Off loopback the page offers
  // code pairing only.
  pageOrigin: string
  clientKind: ClientKind
  environment: BrowserPlatformEnvironment
  // The tab's session storage: it holds the device credential and whether the
  // limits were shown, and a browser can block it.
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem">
  // Longer-lived storage, for one fact only: that this browser paired before,
  // so a reopened tab can say why it is asked again. Optional and never read
  // for anything that decides access.
  memory?: Pick<Storage, "getItem" | "setItem"> | undefined
  // A code carried in the address bar by the machine's QR, already removed
  // from the bar by the entry point before this renders.
  codeFromUrl?: string | undefined
  createClient: PairingClientFactory
  labelSuffix: () => string
  // onOpenLimits reopens the limits over the session (Q367 A), handed the
  // control to give focus back to on the way out and the route the shell's
  // chip names, or undefined while that route is not resolved.
  workspace: (session: { token: string, deviceId: string, onSignedOut: (result: unknown) => void, onChangeCredential: () => void, onOpenLimits: (opener: HTMLElement | null, route: LimitsRoute | undefined) => void }) => ReactNode
}

const pairedBeforeKey = "domovoi.paired-before"

// The design's app label for the limits page.
const limitsLabel = "What a tab can do"

// The pages before a session draw the Web v2 bar, with its theme toggle
// (Q382 A). Inside the session the workspace keeps the desktop bar.
function PreSessionPage({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <WebPageHeader label={label} />
      {children}
    </div>
  )
}

function readPairedBefore(memory: WebAppProps["memory"]): boolean {
  try { return memory?.getItem(pairedBeforeKey) === "1" } catch { return false }
}

function hostOf(rpcUrl: string): { host: string; secure: boolean } {
  try {
    const url = new URL(rpcUrl)
    return { host: url.host, secure: url.protocol === "wss:" }
  } catch {
    return { host: rpcUrl, secure: false }
  }
}

// What a browser tab shows first: the connect page until this tab holds a
// paired device credential, then the limits unless the person already read
// them from the connect page, then the session. The code the
// machine shows is the way in; the daemon's root credential stays reachable
// for a machine with no desktop to show a code on, and only on a page opened
// on that machine (Q5 A).
export function WebApp({ rpcUrl, pageOrigin, clientKind, environment, storage, memory, codeFromUrl, createClient, labelSuffix, workspace }: WebAppProps) {
  const [session, setSession] = useState(() => loadDaemonSession(storage))
  const [pairing, setPairing] = useState(false)
  const [pairingError, setPairingError] = useState("")
  const [path, setPath] = useState<"code" | "credential">("code")
  const [outcome, setOutcome] = useState<PairingOutcome | undefined>(undefined)
  const [reached, setReached] = useState(false)
  const [reopened] = useState(() => readPairedBefore(memory))
  // The limits are stated once per tab, after pairing and before the session,
  // so a refusal inside the session is never the first time a person hears
  // of it. A tab that cannot keep session storage sees them every time,
  // which is itself one of the rows.
  const [limitsSeen, setLimitsSeen] = useState(() => browserLimitsSeen(storage))
  // The same limits, asked for from the connect page before this tab pairs.
  // Read there, they count as stated, so pairing goes on to the session.
  const [limitsOpen, setLimitsOpen] = useState(false)
  // The link that opened the limits gets focus back once the connect page is
  // shown again, so the way back does not drop focus to the document body.
  const limitsOpener = useRef<HTMLElement | null>(null)
  const connectPage = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (limitsOpen) return
    const opener = limitsOpener.current
    limitsOpener.current = null
    if (!opener) return
    // A pairing that finished while the limits were open replaces the form's
    // link with the outcome card, which carries the same link, so focus falls
    // back to that one. The form's link shows exactly when no card does, so
    // one of the two is always on the page.
    const target = opener.isConnected ? opener : connectPage.current?.querySelector<HTMLElement>("[data-limits-link]")
    target?.focus()
  }, [limitsOpen])
  // Inside the session the limits open as a dialog over it (Q99 A), and give
  // focus back to the control that opened the palette.
  const [sessionLimits, setSessionLimits] = useState<{ open: boolean; opener: HTMLElement | null; route: LimitsRoute | undefined }>({ open: false, opener: null, route: undefined })
  const { host, secure } = hostOf(rpcUrl)
  const route = routeOfEndpoint(rpcUrl)
  const credentialOffered = isLoopbackPageOrigin(pageOrigin)

  const keep = (next: DaemonSession) => {
    saveDaemonSession(storage, next)
    try { memory?.setItem(pairedBeforeKey, "1") } catch { /* a convenience, never a gate */ }
    setSession(next)
  }

  function redeem(code: string) {
    setPairing(true)
    setOutcome(undefined)
    // The label the daemon enrols this browser under, so a card can name the
    // device to revoke.
    const label = browserDeviceLabel(clientKind, labelSuffix())
    void redeemBrowserCode({
      url: rpcUrl,
      client: clientKind,
      code,
      label,
      createClient,
      onConnected: () => setReached(true),
    }).then((next) => {
      // Kept in the tab at once, so a closed page after this point did
      // pair; the card only says so and offers the way on.
      keep(next)
      setSession(undefined)
      setOutcome({
        tone: "ok",
        pill: "accepted",
        title: `This browser is paired with ${host}`,
        // Web v2 leads with the route, by the chip's rule (route-word.ts).
        mono: `${route === "unknown" ? "" : `${route} · `}credential ${next.deviceId.slice(-8)} · this tab only`,
        body: "Close the tab and the credential goes with it. You pair again with a new code.",
        action: { label: "Open sessions", run: () => setSession(next) },
      })
    }).catch((cause: unknown) => {
      const refusal = pairingOutcomeFor(cause, host, label)
      const reloadPage = environment.reloadPage
      const next = pairingNextStep(cause)
      // A host with no page to reload gets no button: another code would
      // meet the same refusal, and the card says to reload. No answer sends
      // the same code again.
      const action = next === "new-code" ? { label: "Type a new code", run: () => setOutcome(undefined) }
        : next === "retry" ? { label: "Try again", run: () => redeem(code) }
          : next === "reload" && reloadPage ? { label: "Reload this page", run: () => reloadPage() } : undefined
      setOutcome({ ...refusal, action })
    }).finally(() => {
      setPairing(false)
    })
  }

  if (!session) {
    if (path === "credential" && credentialOffered) {
      return <PreSessionPage label="Connect this browser"><DaemonCredentialPrompt
        pending={pairing}
        error={pairingError}
        onSubmit={(bearer) => {
          setPairing(true)
          setPairingError("")
          void pairBrowserDevice({
            url: rpcUrl,
            pageOrigin,
            client: clientKind,
            bearer,
            label: browserDeviceLabel(clientKind, labelSuffix()),
            createClient,
          }).then(keep).catch((cause: unknown) => {
            setPairingError(cause instanceof Error ? cause.message : "This browser could not be paired with the daemon")
          }).finally(() => {
            setPairing(false)
          })
        }}
      /></PreSessionPage>
    }
    const connect = <WebConnectPage
      host={host}
      pageOrigin={pageOriginAgainstDaemon(pageOrigin, rpcUrl)}
      codeName={codeNameFor(clientKind)}
      secure={secure}
      reached={reached}
      reopened={reopened}
      {...(codeFromUrl ? { initialCode: codeFromUrl, fromUrl: true } : {})}
      pending={pairing}
      outcome={outcome}
      onPair={redeem}
      onOpenLimits={(opener) => {
        limitsOpener.current = opener
        setLimitsOpen(true)
        setLimitsSeen(true)
      }}
      {...(credentialOffered ? { onUseCredential: () => setPath("credential") } : {})}
    />
    // The connect page stays mounted under the limits, so a typed code and a
    // drawn outcome are still there on the way back. One bar serves both, so
    // a theme chosen on either page is the one the other shows.
    return <PreSessionPage label={limitsOpen ? limitsLabel : "Connect this browser"}>
      {limitsOpen ? <BrowserLimitsPanel
        rows={browserLimits(environment, rpcUrl, markBrowserLimitsSeen(storage))}
        // From the accepted card this tab is already paired, so the way back
        // is only back.
        continueLabel={outcome?.tone === "ok" ? "Back" : "Back to pairing"}
        onContinue={() => setLimitsOpen(false)}
      /> : null}
      <div ref={connectPage} hidden={limitsOpen} className="flex min-h-0 flex-1 flex-col">{connect}</div>
    </PreSessionPage>
  }

  if (!limitsSeen) {
    return <PreSessionPage label={limitsLabel}><BrowserLimitsPanel
      rows={browserLimits(environment, rpcUrl, markBrowserLimitsSeen(storage))}
      onContinue={() => setLimitsSeen(true)}
    /></PreSessionPage>
  }
  // A session that ends with the limits open takes them with it, so the next
  // session does not open on limits it did not ask for.
  const leaveSession = () => {
    setSessionLimits({ open: false, opener: null, route: undefined })
    setOutcome(undefined)
    setPath("code")
    setSession(undefined)
  }
  // Reopened from the workspace (Q367 A), the limits are a dialog over the
  // live session (Q99 A), which stays on screen and keeps what it holds.
  return <>
    {workspace({
      token: session.token,
      deviceId: session.deviceId,
      onSignedOut: (result) => {
        clearConfirmedDaemonSession(storage, result)
        leaveSession()
      },
      onChangeCredential: () => {
        clearDaemonSession(storage)
        leaveSession()
      },
      // Asked for again while open (the palette over the dialog), the dialog
      // keeps the control that first opened it: the new opener is inside it.
      onOpenLimits: (opener, route) => setSessionLimits((current) => current.open ? current : { open: true, opener, route }),
    })}
    <BrowserLimitsPanel
      // The session's route as its chip names it, which for an attached
      // machine is not the home endpoint's.
      rows={browserLimits(environment, { route: sessionLimits.route }, markBrowserLimitsSeen(storage))}
      continueLabel="Back"
      onContinue={() => setSessionLimits((current) => ({ ...current, open: false }))}
      dialog={{ open: sessionLimits.open, returnFocusTo: sessionLimits.opener }}
    />
  </>
}
