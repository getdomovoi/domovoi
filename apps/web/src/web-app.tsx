import { useState, type ReactNode } from "react"

import type { ClientKind } from "@getdomovoi/protocol"
import { BrowserLimitsPanel, DaemonCredentialPrompt } from "@getdomovoi/ui"

import { browserLimits } from "./browser-limits"
import { browserLimitsSeen, markBrowserLimitsSeen } from "./browser-limits-seen"
import type { BrowserPlatformEnvironment } from "./browser-platform"
import { browserDeviceLabel, clearDaemonSession, loadDaemonSession, saveDaemonSession } from "./credential"
import { pairBrowserDevice, type PairingClientFactory } from "./daemon-pairing"

export type WebAppProps = {
  rpcUrl: string
  clientKind: ClientKind
  environment: BrowserPlatformEnvironment
  // The tab's session storage: it holds the device credential and whether the
  // limits were shown, and a browser can block it.
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem">
  createClient: PairingClientFactory
  labelSuffix: () => string
  workspace: (session: { token: string, onChangeCredential: () => void }) => ReactNode
}

// What a browser tab shows first: the credential prompt until this tab holds a
// paired device credential, then the limits, then the session.
export function WebApp({ rpcUrl, clientKind, environment, storage, createClient, labelSuffix, workspace }: WebAppProps) {
  const [session, setSession] = useState(() => loadDaemonSession(storage))
  const [pairing, setPairing] = useState(false)
  const [pairingError, setPairingError] = useState("")
  // The limits are stated once per tab, after pairing and before the session,
  // so a refusal inside the session is never the first time a person hears
  // of it. A tab that cannot keep session storage sees them every time,
  // which is itself one of the rows.
  const [limitsSeen, setLimitsSeen] = useState(() => browserLimitsSeen(storage))

  if (!session) {
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
        }).then((paired) => {
          saveDaemonSession(storage, paired)
          setSession(paired)
        }).catch((cause: unknown) => {
          setPairingError(cause instanceof Error ? cause.message : "This browser could not be paired with the daemon")
        }).finally(() => {
          setPairing(false)
        })
      }}
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
      setSession(undefined)
    },
  })
}
