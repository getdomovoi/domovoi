import { useCallback, useEffect, useState } from "react"
import { CircleStopIcon, KeyRoundIcon, PlusIcon, ServerIcon } from "lucide-react"

import {
  transportPreference,
  type DevicePairResult,
  type FleetHealth,
  type FleetMachine,
  type PairedDeviceSummary,
  type TransportCandidate,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { PairMachineDialog } from "./pair-machine-dialog.js"
import type { PairedMachine, PairMachineRequest } from "./pair-machine.js"
import type { DomovoiRequestOptions } from "./client"

const healthLabel: Record<FleetHealth, string> = {
  healthy: "Online",
  reconnecting: "Reconnecting",
  degraded: "Not responding",
  unreachable: "Unreachable",
  "version-mismatch": "Version mismatch",
  "upgrade-required": "Upgrade required",
}

const healthVariant: Record<FleetHealth, "success" | "warning" | "destructive"> = {
  healthy: "success",
  reconnecting: "warning",
  degraded: "warning",
  unreachable: "destructive",
  "version-mismatch": "destructive",
  "upgrade-required": "warning",
}

// Transports are shown in the order the dialer would try them. The relay is
// left out because Domovoi runs no relay, and a listed row would claim one.
export function orderedMachineTransports(machine: FleetMachine): TransportCandidate[] {
  return [...machine.transports]
    .filter((transport) => transport.kind !== "relay")
    .sort((left, right) =>
      transportPreference.indexOf(left.kind) - transportPreference.indexOf(right.kind))
}

function sessionSummary(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`
}

function MachineCard({
  machine,
  sessionCount,
  inUse,
  onUse,
  onOpenTerminal,
}: {
  machine: FleetMachine
  sessionCount: number | undefined
  inUse: boolean
  onUse?: ((machineId: string) => void) | undefined
  onOpenTerminal?: ((machineId: string) => void) | undefined
}) {
  const transports = orderedMachineTransports(machine)
  return (
    <div role="group" aria-label={machine.label} className="rounded-xl border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-strong">{machine.label}</span>
        <Badge variant={healthVariant[machine.health]}>{healthLabel[machine.health]}</Badge>
        {machine.self ? <Badge variant="outline">This machine</Badge> : null}
        <span className="ml-auto flex items-center gap-1.5">
          {inUse ? (
            <span className="font-machine text-[10px] text-faint">In use</span>
          ) : onUse ? (
            <Button variant="outline" size="sm" aria-label={`Use ${machine.label}`} onClick={() => onUse(machine.id)}>
              Use
            </Button>
          ) : null}
          {onOpenTerminal && machine.capabilities.includes("terminals") ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Terminal on ${machine.label}`}
              onClick={() => onOpenTerminal(machine.id)}
            >
              Terminal
            </Button>
          ) : null}
        </span>
      </div>
      <p className="mt-1.5 m-0 font-machine text-[10px] text-faint">
        {machine.platform} · {machine.arch} · {machine.version} · {machine.connection}
        {sessionCount === undefined ? "" : ` · ${sessionSummary(sessionCount)}`}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {machine.capabilities.length === 0
          ? <span className="font-machine text-[10px] text-faint">No capability reported</span>
          : machine.capabilities.map((capability) => (
            <Badge key={capability} variant="machine">{capability}</Badge>
          ))}
      </div>
      <p className="mt-3 m-0 text-[11px] font-semibold" id={`transports-${machine.id}`}>
        Transports
      </p>
      {transports.length === 0 ? (
        <p className="m-0 font-machine text-[10px] text-faint">No usable transport advertised</p>
      ) : (
        <ol
          aria-labelledby={`transports-${machine.id}`}
          className="mt-1 m-0 flex flex-col gap-0.5 pl-4 font-machine text-[10px] text-faint"
        >
          {transports.map((transport) => (
            <li key={`${transport.kind}-${transport.endpoint}`}>
              {transport.kind} · {transport.endpoint}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function FleetView({
  connected,
  machines,
  currentMachineId,
  currentSessionCount,
  onOpenSkills,
  onListDevices,
  onRevokeDevice,
  onRotateDevice,
  onPairMachine,
  onUseMachine,
  onOpenMachineTerminal,
}: {
  connected: boolean
  machines: FleetMachine[]
  currentMachineId: string
  currentSessionCount: number
  onOpenSkills: () => void
  onListDevices: (
    options?: DomovoiRequestOptions,
  ) => Promise<{ devices: PairedDeviceSummary[] }>
  onRevokeDevice: (params: { deviceId: string }) => Promise<{ device: PairedDeviceSummary }>
  onRotateDevice: (params: { deviceId: string }) => Promise<DevicePairResult>
  onPairMachine?: ((request: PairMachineRequest) => Promise<PairedMachine>) | undefined
  onUseMachine?: ((machineId: string) => void) | undefined
  onOpenMachineTerminal?: ((machineId: string) => void) | undefined
}) {
  const [devices, setDevices] = useState<PairedDeviceSummary[] | null>(null)
  const [devicesError, setDevicesError] = useState("")
  const [actionError, setActionError] = useState("")
  const [pendingDeviceId, setPendingDeviceId] = useState("")
  const [revoking, setRevoking] = useState<PairedDeviceSummary | null>(null)
  const [rotated, setRotated] = useState<{ label: string; token: string } | null>(null)
  const [pairing, setPairing] = useState(false)

  const loadDevices = useCallback(async () => {
    try {
      const result = await onListDevices()
      setDevices(result.devices)
      setDevicesError("")
    } catch (cause) {
      setDevices(null)
      setDevicesError(cause instanceof Error ? cause.message : "Paired devices could not be listed")
    }
  }, [onListDevices])

  useEffect(() => {
    if (!connected) return
    void loadDevices()
  }, [connected, loadDevices])

  const replaceDevice = (device: PairedDeviceSummary) => {
    setDevices((current) => current
      ? current.map((candidate) => candidate.id === device.id ? device : candidate)
      : current)
  }

  const revokeDevice = async (device: PairedDeviceSummary) => {
    setPendingDeviceId(device.id)
    setActionError("")
    try {
      const result = await onRevokeDevice({ deviceId: device.id })
      replaceDevice(result.device)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "That device could not be revoked")
    } finally {
      setPendingDeviceId("")
      setRevoking(null)
    }
  }

  const rotateDevice = async (device: PairedDeviceSummary) => {
    setPendingDeviceId(device.id)
    setActionError("")
    setRotated(null)
    try {
      const result = await onRotateDevice({ deviceId: device.id })
      replaceDevice(result.device)
      setRotated({ label: result.device.label, token: result.token })
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "That device credential could not be rotated")
    } finally {
      setPendingDeviceId("")
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Settings navigation" className="hidden w-[236px] shrink-0 flex-col border-r bg-sidebar p-2.5 sm:flex">
        <div className="px-2 py-2 text-base font-semibold">Settings</div>
        <Button variant="ghost" className="justify-start" onClick={onOpenSkills}>Skills</Button>
        <Button variant="secondary" className="justify-start">Fleet</Button>
      </aside>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="mx-auto flex w-full max-w-[900px] flex-col px-4 py-5 sm:px-8 sm:py-7">
          <nav aria-label="Settings" className="mb-3 -ml-2 flex flex-wrap items-center gap-1 self-start sm:hidden">
            <Button variant="ghost" className="min-h-11" onClick={onOpenSkills}>Skills</Button>
          </nav>

          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="m-0 text-[17px] font-semibold">Fleet</h1>
              <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
                Machines this daemon can reach, and the devices paired with it. Every connection is
                direct between your own machines.
              </p>
            </div>
            {onPairMachine ? (
              <Button variant="outline" onClick={() => setPairing(true)}>
                <PlusIcon data-icon="inline-start" />
                Pair a machine
              </Button>
            ) : null}
          </div>

          {actionError ? (
            <Alert variant="destructive" className="mt-4">
              <CircleStopIcon />
              <AlertTitle>Device action failed</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}

          {rotated ? (
            <Alert role="status" className="mt-4">
              <KeyRoundIcon />
              <AlertTitle>New credential for {rotated.label}</AlertTitle>
              <AlertDescription>
                Enter it on that device. It is shown once and the old credential no longer works.
                <span className="mt-1.5 block break-all font-machine text-[11px] text-strong">
                  {rotated.token}
                </span>
              </AlertDescription>
            </Alert>
          ) : null}

          <section className="mt-5 flex flex-col gap-2.5" aria-label="Machines">
            <h2 className="m-0 text-[13px] font-semibold">Machines</h2>
            {machines.map((machine) => (
              <MachineCard
                key={machine.id}
                machine={machine}
                {...(machine.id === currentMachineId ? { sessionCount: currentSessionCount } : { sessionCount: undefined })}
                inUse={machine.id === currentMachineId}
                {...(onUseMachine ? { onUse: onUseMachine } : {})}
                {...(onOpenMachineTerminal ? { onOpenTerminal: onOpenMachineTerminal } : {})}
              />
            ))}
          </section>

          <section className="mt-7" aria-label="Paired devices">
            <h2 className="m-0 text-[13px] font-semibold">Paired devices</h2>
            <p className="mt-1.5 max-w-[68ch] text-[12px] leading-relaxed text-muted-foreground">
              A revoked device cannot reconnect. Rotating issues a new credential and retires the
              old one.
            </p>

            {devicesError ? (
              <Alert variant="destructive" className="mt-3">
                <CircleStopIcon />
                <AlertTitle>Paired devices unavailable</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-3">
                  {devicesError}
                  <Button variant="outline" size="sm" onClick={() => void loadDevices()}>Retry</Button>
                </AlertDescription>
              </Alert>
            ) : null}

            {devices && devices.length > 0 ? (
              <table className="mt-3 w-full border-collapse text-[12px]">
                <caption className="sr-only">Devices paired with this machine</caption>
                <thead>
                  <tr className="text-left text-faint">
                    <th scope="col" className="border-b py-2 pr-3 font-medium">Device</th>
                    <th scope="col" className="border-b py-2 pr-3 font-medium">Paired</th>
                    <th scope="col" className="border-b py-2 pr-3 font-medium">Last seen</th>
                    <th scope="col" className="border-b py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((paired) => {
                    const revoked = paired.revokedAt !== undefined
                    const busy = pendingDeviceId === paired.id
                    return (
                      <tr key={paired.id}>
                        <th scope="row" className="border-b py-2 pr-3 text-left font-medium text-strong">
                          {paired.label}
                          {revoked ? <Badge variant="destructive" className="ml-2">Revoked</Badge> : null}
                        </th>
                        <td className="border-b py-2 pr-3 font-machine text-[10px] text-faint">
                          {paired.pairedAt}
                        </td>
                        <td className="border-b py-2 pr-3 font-machine text-[10px] text-faint">
                          {paired.lastSeenAt ?? "never"}
                        </td>
                        <td className="border-b py-2">
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!connected || revoked || busy}
                              aria-label={`Rotate ${paired.label}`}
                              onClick={() => void rotateDevice(paired)}
                            >
                              Rotate
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={!connected || revoked || busy}
                              aria-label={`Revoke ${paired.label}`}
                              onClick={() => setRevoking(paired)}
                            >
                              Revoke
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : null}

            {devices && devices.length === 0 ? (
              <Empty className="mt-3 min-h-40 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><ServerIcon /></EmptyMedia>
                  <EmptyTitle>No device is paired with this machine</EmptyTitle>
                  <EmptyDescription>
                    Run <span className="font-machine">domovoid pair</span> on the other machine to
                    pair one.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}

            {!devices && !devicesError ? (
              <p role="status" className="p-6 text-center font-machine text-[10px] text-faint">
                Loading paired devices
              </p>
            ) : null}
          </section>
        </main>
      </ScrollArea>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(next) => { if (!next) setRevoking(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.label}</AlertDialogTitle>
            <AlertDialogDescription>
              That device loses access to this machine immediately and has to be paired again to
              come back. Sessions already on this machine are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep device</AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingDeviceId !== ""}
              onClick={(event) => {
                event.preventDefault()
                if (revoking) void revokeDevice(revoking)
              }}
            >
              Revoke device
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {onPairMachine ? (
        <PairMachineDialog
          open={pairing}
          onOpenChange={setPairing}
          onClaim={onPairMachine}
          onPaired={() => {
            setPairing(false)
            void loadDevices()
          }}
        />
      ) : null}
    </div>
  )
}
