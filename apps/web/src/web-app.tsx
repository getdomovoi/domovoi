import { useEffect, useRef, useState, type ReactNode } from "react"

import type { ClientKind } from "@getdomovoi/protocol"
import { BrowserLimitsPanel, DaemonCredentialPrompt, WebConnectPage, WebPageHeader, type PairingOutcome } from "@getdomovoi/ui"

import { browserLimits } from "./browser-limits"
import { browserLimitsSeen, markBrowserLimitsSeen } from "./browser-limits-seen"
import type { BrowserPlatformEnvironment } from "./browser-platform"
import { browserDeviceLabel, clearDaemonSession, loadDaemonSession, saveDaemonSession, type DaemonSession } from "./credential"
import { codeNameFor, pairBrowserDevice, pairingNextStep, pairingOutcomeFor, redeemBrowserCode, type PairingClientFactory } from "./daemon-pairing"

export type WebAppProps = {
  rpcUrl: string
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
  workspace: (session: { token: string, onChangeCredential: () => void }) => ReactNode
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
// for a machine with no desktop to show a code on.
export function WebApp({ rpcUrl, clientKind, environment, storage, memory, codeFromUrl, createClient, labelSuffix, workspace }: WebAppProps) {
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
  useEffect(() => {
    if (limitsOpen) return
    limitsOpener.current?.focus()
    limitsOpener.current = null
  }, [limitsOpen])
  const { host, secure } = hostOf(rpcUrl)

  const keep = (next: DaemonSession) => {
    saveDaemonSession(storage, next)
    try { memory?.setItem(pairedBeforeKey, "1") } catch { /* a convenience, never a gate */ }
    setSession(next)
  }

  function redeem(code: string) {
    setPairing(true)
    setOutcome(undefined)
    void redeemBrowserCode({
      url: rpcUrl,
      client: clientKind,
      code,
      label: browserDeviceLabel(clientKind, labelSuffix()),
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
        mono: `credential ${next.deviceId.slice(-8)} · this tab only`,
        body: "Close the tab and the credential goes with it. You pair again with a new code.",
        action: { label: "Open sessions", run: () => setSession(next) },
      })
    }).catch((cause: unknown) => {
      const refusal = pairingOutcomeFor(cause, host)
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
    if (path === "credential") {
      return <PreSessionPage label="Connect this browser"><DaemonCredentialPrompt
        pending={pairing}
        error={pairingError}
        onSubmit={(bearer) => {
          setPairing(true)
          setPairingError("")
          void pairBrowserDevice({
            url: rpcUrl,
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
      onUseCredential={() => setPath("credential")}
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
      <div hidden={limitsOpen} className="flex min-h-0 flex-1 flex-col">{connect}</div>
    </PreSessionPage>
  }

  if (!limitsSeen) {
    return <PreSessionPage label={limitsLabel}><BrowserLimitsPanel
      rows={browserLimits(environment, rpcUrl, markBrowserLimitsSeen(storage))}
      onContinue={() => setLimitsSeen(true)}
    /></PreSessionPage>
  }
  return workspace({
    token: session.token,
    onChangeCredential: () => {
      clearDaemonSession(storage)
      setOutcome(undefined)
      setPath("code")
      setSession(undefined)
    },
  })
}
