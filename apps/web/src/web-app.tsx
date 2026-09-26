import { useState, type ReactNode } from "react"

import type { ClientKind } from "@getdomovoi/protocol"
import { BrowserLimitsPanel, DaemonCredentialPrompt, WebConnectPage, type PairingOutcome } from "@getdomovoi/ui"

import { browserLimits } from "./browser-limits"
import { browserLimitsSeen, markBrowserLimitsSeen } from "./browser-limits-seen"
import type { BrowserPlatformEnvironment } from "./browser-platform"
import { browserDeviceLabel, clearDaemonSession, loadDaemonSession, saveDaemonSession, type DaemonSession } from "./credential"
import { pairBrowserDevice, pairingOutcomeFor, redeemBrowserCode, type PairingClientFactory } from "./daemon-pairing"

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
// paired device credential, then the limits, then the session. The code the
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
  const { host, secure } = hostOf(rpcUrl)

  const keep = (next: DaemonSession) => {
    saveDaemonSession(storage, next)
    try { memory?.setItem(pairedBeforeKey, "1") } catch { /* a convenience, never a gate */ }
    setSession(next)
  }

  if (!session) {
    if (path === "credential") {
      return <DaemonCredentialPrompt
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
      />
    }
    return <WebConnectPage
      host={host}
      secure={secure}
      reached={reached}
      reopened={reopened}
      {...(codeFromUrl ? { initialCode: codeFromUrl, fromUrl: true } : {})}
      pending={pairing}
      outcome={outcome}
      onPair={(code) => {
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
          setOutcome({ ...refusal, action: { label: "Type a new code", run: () => setOutcome(undefined) } })
        }).finally(() => {
          setPairing(false)
        })
      }}
      onOpenLimits={() => setLimitsSeen(false)}
      onUseCredential={() => setPath("credential")}
    />
  }

  if (!limitsSeen) {
    return <BrowserLimitsPanel
      rows={browserLimits(environment, rpcUrl, markBrowserLimitsSeen(storage))}
      onContinue={() => setLimitsSeen(true)}
    />
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
