import { Button } from "./components/ui/button"

export function WorkspaceConnectionStatus(props: {
  connected: boolean
  reconnecting: boolean
  authenticationRequired: string | null
  protocolError: string | null
  connectionError: string
  machineName: string | undefined
  onChangeCredential?: (() => void) | undefined
  onReconnect: () => void
}) {
  return (
    <>
      {props.protocolError ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-2.5 text-[12.5px] text-[var(--danger-fg)]"
        >
          <span aria-hidden="true" data-status-dot="" className="size-2 shrink-0 rounded-full bg-destructive" />
          <span className="min-w-0 flex-1 break-words">
            This client is out of date with the daemon. {props.protocolError}
          </span>
        </div>
      ) : null}
      {!props.connected ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-2.5 text-[12.5px] text-[var(--danger-fg)]"
        >
          <span aria-hidden="true" data-status-dot="" className="size-2 shrink-0 rounded-full bg-destructive" />
          <span className="min-w-0 flex-1 break-words">
            {props.connectionError
              ? `Reconnect failed: ${props.connectionError}`
              : props.authenticationRequired
                ? (props.machineName
                  ? `The daemon on ${props.machineName} refused this connection: ${props.authenticationRequired}`
                  : `The daemon refused this connection: ${props.authenticationRequired}`)
                : props.machineName
                  ? `Lost the daemon on ${props.machineName}. Existing session state remains on that machine.`
                  : "Cannot reach the daemon. Workspace state is waiting for a verified response."}
          </span>
          {props.authenticationRequired ? null : props.reconnecting ? (
            <span className="ml-auto font-machine text-[10px] text-[var(--danger-dim)]">retrying</span>
          ) : null}
          {props.onChangeCredential ? (
            <Button variant="outline" size="sm" onClick={props.onChangeCredential}>
              Change credential
            </Button>
          ) : null}
          <Button variant="destructive" size="sm" onClick={props.onReconnect}>
            Reconnect now
          </Button>
        </div>
      ) : null}
    </>
  )
}
