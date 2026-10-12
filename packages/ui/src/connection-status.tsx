import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

import { Button } from "./components/ui/button"
import { StatusDot } from "./status-dot"

// What the shell knows about its connection to the daemon, for the surfaces
// that speak about it: the banner, the thread's Reconnect action and the
// loading skeleton.
export type WorkspaceConnection = {
  connected: boolean
  reconnecting: boolean
  authenticationRequired: string | null
  protocolError: string | null
  connectionError: string
  machineName: string | undefined
  onChangeCredential?: (() => void) | undefined
  onReconnect: () => void
  // When this client saw an open loopback connection to this machine close.
  // While a connection is open the daemon counts as heard now (as on
  // Machines), and a daemon on this machine that stops or dies closes its
  // socket at once, so the close is the last moment it was heard. Undefined
  // when this client does not know: it never saw the connection open, the
  // machine changed, or the daemon is reached over a network, where a link
  // can die silently and the socket report the close minutes later.
  lastHeardAt?: Date | undefined
}

const ConnectionContext = createContext<WorkspaceConnection | null>(null)

export function useWorkspaceConnection(): WorkspaceConnection | null {
  return useContext(ConnectionContext)
}

type Link = { connected: boolean, machineId: string | undefined, endpoint: string, lastHeardAt?: Date }

function loopback(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname
    return host === "localhost" || host === "[::1]" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host)
  } catch {
    return false
  }
}

// Mounted once by the shell, so last heard survives a session switch that
// remounts the thread.
export function WorkspaceConnectionProvider({ children, machineId, endpoint, ...state }: Omit<WorkspaceConnection, "lastHeardAt"> & {
  // The machine the snapshot is from, by id: two machines can share a name.
  machineId: string | undefined
  // The address this client dialled.
  endpoint: string
  children: ReactNode
}) {
  const [link, setLink] = useState<Link>(() => ({ connected: state.connected, machineId, endpoint }))
  if (link.connected !== state.connected || link.machineId !== machineId || link.endpoint !== endpoint) {
    // Heard only from the machine this client was connected to, at the
    // address it dialled. A switch to another machine clears the snapshot,
    // and with it the id, so the time does not follow the switch.
    const same = machineId !== undefined && machineId === link.machineId && endpoint === link.endpoint
    const lastHeardAt = state.connected || !same ? undefined
      : link.connected ? (loopback(endpoint) ? new Date() : undefined)
        : link.lastHeardAt
    setLink({ connected: state.connected, machineId, endpoint, ...(lastHeardAt ? { lastHeardAt } : {}) })
  }
  const value: WorkspaceConnection = { ...state, ...(link.lastHeardAt ? { lastHeardAt: link.lastHeardAt } : {}) }
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

function heardAgo(at: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3_600)}h ago`
}

// Ticks once a second while there is a last-heard time to age.
function useNow(active: boolean, fixed: Date | undefined): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!active || fixed) return
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(timer)
  }, [active, fixed])
  return fixed ?? now
}

const bannerClass = "flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-2.5 text-[12.5px] text-[var(--danger-fg)]"

// The daemon-lost banner alone. The shell draws it at the top of the thread
// column, as the design does, and across the window only where there is no
// thread column to put it in.
export function DaemonLostBanner(props: WorkspaceConnection & { now?: Date | undefined }) {
  const now = useNow(!props.connected && props.lastHeardAt !== undefined, props.now)
  if (props.connected) return null
  const lostOn = !props.connectionError && !props.authenticationRequired ? props.machineName : undefined
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className={bannerClass}>
      <StatusDot meaning="offline" label="Disconnected" size="default" labelHidden className="shrink-0" />
      {lostOn ? (
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-[11px] gap-y-1">
          {props.lastHeardAt ? (
            // The age ticks every second, and every change inside the live
            // region would be announced again. The ticking words are hidden
            // from assistive technology, which reads the clock time instead.
            <span className="break-words">
              <span aria-hidden>{`Lost the daemon on ${lostOn}, last heard ${heardAgo(props.lastHeardAt, now)}`}</span>
              <span className="sr-only">{`Lost the daemon on ${lostOn}, last heard at ${props.lastHeardAt.toLocaleTimeString()}`}</span>
            </span>
          ) : (
            <span className="break-words">{`Lost the daemon on ${lostOn}`}</span>
          )}
          <span className="font-machine text-[10.5px] text-[var(--danger-dim)]">
            the worktree and this thread are intact on the machine, nothing was rolled back
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 break-words">
          {props.connectionError
            ? `Reconnect failed: ${props.connectionError}`
            : props.authenticationRequired
              ? (props.machineName
                ? `The daemon on ${props.machineName} refused this connection: ${props.authenticationRequired}`
                : `The daemon refused this connection: ${props.authenticationRequired}`)
              : "Cannot reach the daemon. Workspace state is waiting for a verified response."}
        </span>
      )}
      {props.authenticationRequired ? null : props.reconnecting ? (
        <span className="ml-auto font-machine text-[10px] text-[var(--danger-dim)]">retrying</span>
      ) : null}
      {props.onChangeCredential ? (
        <Button variant="outline" size="sm" onClick={props.onChangeCredential}>
          Change credential
        </Button>
      ) : null}
      {/* An outline in the banner's own tones, as drawn: a filled
          destructive button reads as an action that destroys something. */}
      <Button
        variant="outline"
        size="sm"
        className="border-danger-border bg-transparent text-danger-foreground hover:bg-danger-background hover:text-danger-foreground dark:border-danger-border dark:bg-transparent"
        onClick={props.onReconnect}
      >
        Retry now
      </Button>
    </div>
  )
}

export function WorkspaceConnectionStatus({ lostBanner = true, ...props }: WorkspaceConnection & {
  // False where the thread column draws the lost banner itself.
  lostBanner?: boolean | undefined
  now?: Date | undefined
}) {
  return (
    <>
      {props.protocolError ? (
        <div role="status" aria-live="polite" aria-atomic="true" className={bannerClass}>
          <StatusDot meaning="offline" label="Disconnected" size="default" labelHidden className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            This client is out of date with the daemon. {props.protocolError}
          </span>
        </div>
      ) : null}
      {lostBanner ? <DaemonLostBanner {...props} /> : null}
    </>
  )
}

// The shell's status row, read from the provider the shell mounts.
export function ShellConnectionStatus({ threadColumn }: { threadColumn: boolean }) {
  const connection = useWorkspaceConnection()
  return connection ? <WorkspaceConnectionStatus {...connection} lostBanner={!threadColumn} /> : null
}

// The banner at the top of the thread column. Nothing without a provider.
export function ThreadConnectionBanner() {
  const connection = useWorkspaceConnection()
  return connection ? <DaemonLostBanner {...connection} /> : null
}
