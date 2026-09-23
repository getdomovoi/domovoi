import { useCallback, useEffect, useRef, useState } from "react"
import { AppState } from "react-native"
import {
  applyWorkspaceDelta,
  type ClientAccess,
  type FleetEntry,
  type WorkspaceDelta,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { connectionFault, type ConnectionFault } from "./connection-fault"
import { openRelayPinStore } from "./credentials"
import { DaemonConnection, DaemonNotSentError, type DaemonCall, type DaemonStatus } from "./daemon"
import type { HandheldClient } from "./protocol-facts"
import { reconcileRelayPin } from "./relay-pin"
import { retryDelayMs } from "./reconnect"

export function useDaemon(
  url: string | undefined,
  token: string | undefined,
  client: HandheldClient,
  // Where a pushed fleet goes. Held in a ref so the connection is not torn down
  // and rebuilt every time the caller renders a new closure.
  onFleet: (entries: FleetEntry[]) => void,
) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | undefined>(undefined)
  const [status, setStatus] = useState<DaemonStatus>("closed")
  const [fault, setFault] = useState<ConnectionFault | undefined>(undefined)
  // Only a hello that said true. Missing or false means this daemon strips
  // the field and a text-only success would pass for an image delivery.
  const [imageAttachments, setImageAttachments] = useState(false)
  const [clientAccess, setClientAccess] = useState<ClientAccess>("watching")
  const [protocolProblem, setProtocolProblem] = useState<string | undefined>(undefined)
  const connection = useRef<DaemonConnection | undefined>(undefined)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Set when the daemon has given an answer it will give again to every retry.
  // Nothing reopens the connection after that except the person changing the
  // credential, which re-runs this effect and clears it.
  const givenUp = useRef(false)
  // Set by the effect that owns the socket, so asking for a connection now is
  // the same code path the app uses when the phone comes back from the
  // background rather than a second, subtly different one.
  const reopen = useRef<(() => void) | undefined>(undefined)
  const fleetSink = useRef(onFleet)
  fleetSink.current = onFleet

  useEffect(() => {
    if (!url || !token) {
      setStatus("closed")
      return
    }
    let live = true
    attempt.current = 0
    givenUp.current = false
    setFault(undefined)

    const open = () => {
      if (!live || givenUp.current) return
      connection.current?.close()
      // A connection this one replaced can still deliver a late frame or its
      // close. Only the current one speaks for the screen.
      const current = () => connection.current === daemon
      const daemon: DaemonConnection = new DaemonConnection(url, token, client, {
        onSnapshot: (next) => {
          if (!current()) return
          // A greeting that answers is the only proof the connection works, so
          // the backoff resets here rather than when the socket opens.
          attempt.current = 0
          setFault(undefined)
          setSnapshot(next)
        },
        // The token that opened this connection is what pairing proved, and
        // only the answered hello proves it. This is where the daemon's relay
        // identity is pinned or a distrusted pin is recovered; it never
        // decides the connection.
        onHello: (next) => {
          if (!current()) return
          setProtocolProblem(undefined)
          setImageAttachments(next.sessionImageAttachments === true)
          setClientAccess(next.clientAccess ?? "full")
          void reconcileRelayPin({
            store: openRelayPinStore(next.machine.id),
            machineId: next.machine.id,
            call: (method, params) => daemon.call(method, params),
          }).catch((cause: unknown) => {
            console.warn("Relay pin not reconciled:", cause instanceof Error ? cause.message : String(cause))
          })
        },
        onDelta: (delta: WorkspaceDelta) => {
          if (!current()) return
          setSnapshot((held) => held ? applyWorkspaceDelta(held, delta) : held)
        },
        onFleet: (entries) => {
          if (current()) fleetSink.current(entries)
        },
        onStatus: (next) => {
          if (!current()) return
          // A closed or reconnecting connection has not said what it can do.
          if (next !== "open") {
            setImageAttachments(false)
            setClientAccess("watching")
          }
          setStatus(next)
        },
        onError: (cause) => {
          if (!current()) return
          const next = connectionFault(cause)
          setFault(next)
          if (!next.retriable) givenUp.current = true
        },
        onProtocolError: (reason) => {
          if (!current()) return
          console.warn("Daemon protocol error:", reason)
          setProtocolProblem(reason)
        },
        onClosed: () => {
          if (!live || givenUp.current || !current()) return
          attempt.current += 1
          timer.current = setTimeout(open, retryDelayMs(attempt.current))
        },
      })
      connection.current = daemon
      daemon.connect()
    }

    // The backoff exists so a daemon that is genuinely gone is not hammered
    // from a device on a battery. Asking for it now skips the wait once,
    // without abandoning the backoff for the times nobody asked.
    const now = () => {
      if (givenUp.current) return
      if (connection.current?.isLive()) return
      if (timer.current) clearTimeout(timer.current)
      attempt.current = 0
      open()
    }
    reopen.current = now

    open()

    // Coming back from the background is the most common moment for a phone to
    // find its connection dead, and waiting out the backoff there would leave
    // the person staring at a stale screen.
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") return
      now()
    })

    return () => {
      live = false
      reopen.current = undefined
      subscription.remove()
      if (timer.current) clearTimeout(timer.current)
      connection.current?.close()
      connection.current = undefined
    }
  }, [client, token, url])

  const call = useCallback<DaemonCall>((method, params) => {
    const daemon = connection.current
    if (!daemon) return Promise.reject(new DaemonNotSentError("The daemon connection is not open"))
    return daemon.call(method, params)
  }, [])

  // A client normally resyncs through the greeting on every reconnect, so this
  // exists for the one case that is not a reconnect: a person who wants to know
  // that what they are looking at is current, right now.
  const refresh = useCallback(async () => {
    const daemon = connection.current
    if (!daemon?.isOpen()) throw new Error("The daemon connection is not open")
    setSnapshot(await daemon.call("workspace.get", {}))
  }, [])

  // Nothing here overrides a refusal the daemon will repeat: a wrong token is
  // still wrong however many times it is asked.
  const reconnect = useCallback(() => reopen.current?.(), [])

  return { snapshot, status, fault, protocolProblem, call, refresh, reconnect, imageAttachments, clientAccess }
}
