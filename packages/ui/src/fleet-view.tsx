import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  CheckIcon,
  CircleStopIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
  MonitorIcon,
  PlusIcon,
  ServerIcon,
  SmartphoneIcon,
  TabletIcon,
  TerminalIcon,
  UnplugIcon,
} from "lucide-react"

import {
  deviceRenameLabelSchema,
  maximumPairedDeviceLabelLength,
  transportPreference,
  type ClientKind,
  type DeviceCredentialBinding,
  type DevicePairResult,
  type FleetEntry,
  type FleetForgetResult,
  type FleetHealth,
  type FleetMachine,
  type FleetSnapshotOverflow,
  type PairedDeviceSummary,
  type TransportCandidate,
} from "@getdomovoi/protocol"

import {
  pendingOperationNote,
  pendingOperationWord,
  shortMachineId,
  unenrolledNote,
} from "./fleet-entries.js"
import { fleetOverflowNotice } from "./fleet-overflow.js"
import { fleetUpdateAvailable } from "./fleet-updates.js"
import { forgetMachineNotice, type ForgetMachineNotice } from "./forget-machine.js"
import { machineAttachment } from "./machine-selection.js"
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
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./components/ui/input-group"
import { ScrollArea } from "./components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip"
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
  "pairing-required": "Pair again",
  "credential-store-unavailable": "Keychain unavailable",
}

const healthVariant: Record<FleetHealth, "success" | "warning" | "destructive"> = {
  healthy: "success",
  reconnecting: "warning",
  degraded: "warning",
  unreachable: "destructive",
  "version-mismatch": "destructive",
  "upgrade-required": "warning",
  "pairing-required": "destructive",
  "credential-store-unavailable": "warning",
}

// The two credential states need a sentence, not a badge: one is fixed by
// pairing again and the other is not, and a bare word cannot tell them apart.
const healthNote: Record<FleetHealth, ((label: string) => string) | undefined> = {
  healthy: undefined,
  reconnecting: undefined,
  degraded: undefined,
  unreachable: undefined,
  "version-mismatch": undefined,
  "upgrade-required": undefined,
  "pairing-required": (label) =>
    `${label} refused the credential this machine holds for it. Pair it again to restore it.`,
  "credential-store-unavailable": (label) =>
    `The keychain on this machine could not be read, so nothing was presented to ${label}. Pairing again would not fix it.`,
}

// Forgetting is destructive on this side and only a request on the other, so
// the sentence says both before the confirmation opens.
const forgetConsequence =
  "Deletes the credential this machine holds for it. Sessions there keep running, and revoking this machine on that side may still be yours to do."

// Transports are shown in the order the dialer would try them. The relay is
// left out because Domovoi runs no relay, and a listed row would claim one.
export function orderedMachineTransports(machine: FleetMachine): TransportCandidate[] {
  return [...machine.transports]
    .filter((transport) => transport.kind !== "relay")
    .sort((left, right) =>
      transportPreference.indexOf(left.kind) - transportPreference.indexOf(right.kind))
}

type DeviceRevocationReason = NonNullable<PairedDeviceSummary["revocationReason"]>

// An upgrade revokes credentials that predate identity binding. That is not the
// operator revoking a device, and it has a different remedy, so the row says so
// instead of leaving a bare Revoked badge to explain it. Both migration reasons
// read identically to the person: one upgrade with one remedy, rather than two
// stories that sound like the pairing broke twice. The distinction stays in the
// record for auditing. A reason added here has to decide its own copy.
const revokedByUpgradeReason: Record<DeviceRevocationReason, boolean> = {
  "legacy-unbound-credential": true,
  "legacy-unbound-client-kind": true,
}

const migrationNote =
  "This pairing predates bound credentials. Pair this device again to restore it."

// The handoff's Fleet idioms: eyebrow labels at 9px and .1em in --faint, values
// under them in the machine face at 11.5px.
const eyebrow = "text-[9px] tracking-[.1em] text-faint uppercase"
const panelEyebrow = "text-[9.5px] tracking-[.1em] text-faint uppercase"
const monoValue = "font-machine text-[11.5px]"

// The handoff's secondary control: a bordered ghost, 7px 11px, 11px in
// --muted-foreground, hovering one neutral step to --accent.
const secondaryControl =
  "h-auto rounded-sm border-border bg-transparent px-[11px] py-[7px] text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-transparent dark:hover:bg-accent"

// Revoke stays quiet until approached: bare 11px --faint text that turns
// destructive only on hover. Padding gives the hover tint a shape to fill.
const destructiveControl =
  "h-auto rounded-sm px-[7px] py-[5px] text-[11px] font-normal text-faint hover:bg-[color-mix(in_oklab,var(--destructive)_18%,transparent)] hover:text-destructive dark:hover:bg-[color-mix(in_oklab,var(--destructive)_18%,transparent)]"

// Rename and Undo are quiet like Revoke, but never destructive: they hover
// one neutral step rather than turning red.
const quietControl =
  "h-auto rounded-sm px-[7px] py-[5px] text-[11px] font-normal text-faint hover:bg-accent hover:text-accent-foreground"

// The label row and the label field share one height, so opening or closing
// the editor never moves the rows around it.
const labelLine = "flex h-7 items-center gap-2"

// Save and Cancel sit inside the field as pills, so the field is the whole
// control and the row never grows a second line of buttons.
const pill = "h-5 rounded-full px-2 text-[10.5px] font-medium"
const savePill = `${pill} bg-primary text-primary-foreground hover:bg-primary/90`
const cancelPill = `${pill} text-muted-foreground hover:bg-accent hover:text-accent-foreground`

// The handoff's primary control: 8px 15px, radius-md, 11.5px at 500.
const primaryControl =
  "h-auto gap-1.5 rounded-md px-[15px] py-[8px] text-[11.5px] font-medium hover:bg-[color-mix(in_oklab,var(--primary)_90%,transparent)]"

const dangerControl =
  "h-auto rounded-md border border-[var(--danger-border)] bg-[var(--danger-bg)] px-[15px] py-[8px] text-[11.5px] font-medium text-[var(--danger-fg)] hover:bg-[color-mix(in_oklab,var(--danger-bg),var(--destructive)_25%)]"

// Radix tooltips open on hover and on keyboard focus, and never on touch. The
// same sentence is a tooltip wherever a pointer can hover, and standing text
// wherever one cannot: pointer-coarse is the tablet and phone case.
const coarseFallback = "hidden pointer-coarse:block"

// A run of a fixed length, so the mask never leaks how long the secret is.
const maskedRun = "•".repeat(20)

const clientIcon: Record<ClientKind, typeof SmartphoneIcon> = {
  phone: SmartphoneIcon,
  tablet: TabletIcon,
  web: GlobeIcon,
  desktop: MonitorIcon,
  cli: TerminalIcon,
}

const clientWord: Record<ClientKind, string> = {
  phone: "Phone",
  tablet: "Tablet",
  web: "Browser",
  desktop: "Desktop",
  cli: "Terminal",
}

function kindIcon(binding: DeviceCredentialBinding): typeof SmartphoneIcon {
  if (binding.kind === "client") return clientIcon[binding.client]
  if (binding.kind === "machine") return ServerIcon
  return UnplugIcon
}

function kindWord(binding: DeviceCredentialBinding): string {
  if (binding.kind === "client") return clientWord[binding.client]
  if (binding.kind === "machine") return "Machine"
  return "Unbound"
}

// The word for the thing a person holds, in a sentence: "that phone", "that browser".
function heldWord(binding: DeviceCredentialBinding): string {
  return binding.kind === "client" ? clientWord[binding.client].toLowerCase() : "device"
}

// The one sentence an operator needs before the confirmation opens, not after.
// A person's device and a fleet machine lose different things.
function revokeConsequence(binding: DeviceCredentialBinding): string {
  if (binding.kind === "machine") {
    return "Cuts this machine off. Its sessions keep running there; transfers to it are refused."
  }
  return "Signs this device out. Someone has to pair it again from the device."
}

function rotationInstruction(binding: DeviceCredentialBinding): string {
  if (binding.kind === "machine") {
    return "Nobody has to be at that machine. Save it on the machine itself. It is shown once, the old credential no longer works, and sessions already running there are untouched."
  }
  return `Enter it on that ${heldWord(binding)}. It is shown once, and the old credential no longer works.`
}

const timestamp = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

function when(value: string | undefined): string {
  if (value === undefined) return "never"
  return timestamp.format(new Date(value)).replace(",", "")
}

function sessionSummary(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`
}

function MachineCard({
  machine,
  fleet,
  sessionCount,
  inUse,
  connected,
  onUse,
  onOpenTerminal,
  onForget,
}: {
  machine: FleetMachine
  fleet: readonly FleetEntry[]
  sessionCount: number | undefined
  inUse: boolean
  connected: boolean
  onUse?: ((machineId: string) => void) | undefined
  onOpenTerminal?: ((machineId: string) => void) | undefined
  onForget?: ((machine: FleetMachine) => void) | undefined
}) {
  const transports = orderedMachineTransports(machine)
  const updateVersion = fleetUpdateAvailable(machine, fleet)
  const note = healthNote[machine.health]?.(machine.label)
  // Attaching and a terminal are client dials, and a remote machine has no
  // client credential to dial with. The controls stay, disabled, with the
  // reason beside them, so nobody hunts for a setting that does not exist.
  const attachment = machineAttachment(machine)
  const canControl = connected && attachment.selectable
  const showsTerminal = onOpenTerminal && machine.capabilities.includes("terminals")
  return (
    <div role="group" aria-label={machine.label} className="rounded-xl border bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-strong">{machine.label}</span>
        <Badge variant={healthVariant[machine.health]}>{healthLabel[machine.health]}</Badge>
        {machine.self ? <Badge variant="outline">This machine</Badge> : null}
        {updateVersion ? (
          <Badge variant="warning" title={`This machine runs ${machine.version}`}>
            UPDATE {updateVersion}
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {inUse ? (
            <span className="font-machine text-[10px] text-faint">In use</span>
          ) : onUse ? (
            <Button variant="outline" size="sm" disabled={!canControl} aria-label={`Use ${machine.label}`} onClick={() => onUse(machine.id)}>
              Use
            </Button>
          ) : null}
          {showsTerminal ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!canControl}
              aria-label={`Terminal on ${machine.label}`}
              onClick={() => onOpenTerminal(machine.id)}
            >
              Terminal
            </Button>
          ) : null}
          {onForget && !machine.self ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className={destructiveControl}
                  disabled={!connected}
                  aria-label={`Forget ${machine.label}`}
                  onClick={() => onForget(machine)}
                >
                  Forget
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[38ch] text-[11.5px] leading-relaxed">
                {forgetConsequence}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      </div>
      {!attachment.selectable && (onUse || showsTerminal) && !inUse ? (
        <p className="mt-1.5 m-0 max-w-[68ch] text-[11px] leading-relaxed text-muted-foreground">
          {attachment.reason}
        </p>
      ) : null}
      {onForget && !machine.self ? (
        <p className={`${coarseFallback} mt-1.5 m-0 max-w-[68ch] text-[11px] leading-relaxed text-muted-foreground`}>
          {forgetConsequence}
        </p>
      ) : null}
      {note ? (
        <p className="mt-1.5 m-0 max-w-[68ch] text-[11px] leading-relaxed text-muted-foreground">{note}</p>
      ) : null}
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

// A pending row sits where the machine will be, or was. There is no button:
// the daemon resumes the operation on its own, and a client cannot.
function PendingCard({ entry }: { entry: Extract<FleetEntry, { kind: "pending" }> }) {
  const title = `${pendingOperationWord[entry.operation]} ${shortMachineId(entry.machineId)}`
  return (
    <div role="group" aria-label={title} className="rounded-xl border border-dashed bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-strong">{pendingOperationWord[entry.operation]}</span>
        <Badge variant="machine" title={entry.machineId}>{shortMachineId(entry.machineId)}</Badge>
        <Badge variant="warning">In progress</Badge>
      </div>
      <p className="mt-1.5 m-0 text-[11px] leading-relaxed text-muted-foreground">{pendingOperationNote}</p>
      <p className="mt-1.5 m-0 font-machine text-[10px] text-faint" title={entry.startedAt}>
        started {when(entry.startedAt)}
      </p>
    </div>
  )
}

function UnenrolledCard({ entry }: { entry: Extract<FleetEntry, { kind: "unenrolled" }> }) {
  const title = `Never enrolled ${shortMachineId(entry.machineId)}`
  return (
    <div role="group" aria-label={title} className="rounded-xl border border-dashed bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-strong">Never enrolled</span>
        <Badge variant="machine" title={entry.machineId}>{shortMachineId(entry.machineId)}</Badge>
      </div>
      <p className="mt-1.5 m-0 max-w-[68ch] text-[11px] leading-relaxed text-muted-foreground">{unenrolledNote}</p>
    </div>
  )
}

// One card per lifecycle kind. Each case returns, so a kind the protocol adds
// later fails to compile here instead of rendering nothing.
function entryCard(entry: FleetEntry, machineCard: (machine: FleetMachine) => ReactNode): ReactNode {
  switch (entry.kind) {
    case "machine":
      return machineCard(entry.machine)
    case "pending":
      return <PendingCard key={entry.machineId} entry={entry} />
    case "unenrolled":
      return <UnenrolledCard key={entry.machineId} entry={entry} />
  }
}

function StatusChip({ tone, children }: { tone: "warning" | "destructive"; children: ReactNode }) {
  const skin =
    tone === "warning"
      ? "bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-warning"
      : "bg-[color-mix(in_oklab,var(--destructive)_16%,transparent)] text-destructive"
  return (
    <span
      className={`inline-flex items-center rounded-[4px] px-[7px] py-[2px] text-[9px] tracking-[.06em] uppercase ${skin}`}
    >
      {children}
    </span>
  )
}

const headCell = `border-b py-2 pr-3 text-left align-bottom font-normal ${eyebrow}`

function DeviceTableHead() {
  return (
    <thead>
      <tr>
        <th scope="col" className={`${headCell} w-[14%]`}>Kind</th>
        <th scope="col" className={headCell}>Device</th>
        <th scope="col" className={`${headCell} w-[11%]`}>Paired</th>
        <th scope="col" className={`${headCell} w-[14%]`}>Last seen</th>
        <th scope="col" className={`${headCell} w-[22%] pr-0`}>Actions</th>
      </tr>
    </thead>
  )
}

function LoadingRow({ wide }: { wide: boolean }) {
  return (
    <tr aria-hidden="true">
      <td className="border-b py-2.5 pr-3 align-top">
        <span className="block h-3 w-16 rounded-sm bg-muted" />
        <span className="mt-1.5 block h-3 w-24 rounded-sm bg-muted/60" />
      </td>
      <td className="border-b py-2.5 pr-3 align-top">
        <span className={`block h-3 rounded-sm bg-muted ${wide ? "w-56" : "w-32"}`} />
      </td>
      <td className="border-b py-2.5 pr-3 align-top">
        <span className="block h-3 w-20 rounded-sm bg-muted/60" />
      </td>
      <td className="border-b py-2.5 pr-3 align-top">
        <span className="block h-3 w-20 rounded-sm bg-muted/60" />
      </td>
      <td className="border-b py-2.5 align-top">
        <span className="block h-8 w-40 rounded-sm bg-muted/60" />
      </td>
    </tr>
  )
}

const rowCell = "border-b py-2.5"

function KindCell({ binding, dimmed }: { binding: DeviceCredentialBinding; dimmed: boolean }) {
  const Icon = kindIcon(binding)
  return (
    <td className={`${rowCell} pr-3 align-top ${dimmed ? "opacity-55" : ""}`}>
      <span className="flex items-center gap-1.5 leading-none">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-[12px] font-medium text-foreground">{kindWord(binding)}</span>
      </span>
      <span className="mt-1.5 block">
        {binding.kind === "machine" ? (
          <Badge variant="machine" title={binding.machineId}>
            {shortMachineId(binding.machineId)}
          </Badge>
        ) : (
          <span className="font-machine text-[10px] text-faint">
            {binding.kind === "client"
              ? "client"
              : binding.previousRole === "unknown" ? "role not recorded" : `was ${binding.previousRole}`}
          </span>
        )}
      </span>
    </td>
  )
}

// The label is only ever what a person calls this row, so it is set in the sans
// face. The machine id in the Kind column stays in the machine face and cannot
// be edited, so a renamed row can never borrow a machine's identity.
function LabelCell({
  device,
  disabled,
  undoable,
  onRename,
  onUndo,
}: {
  device: PairedDeviceSummary
  disabled: boolean
  undoable: boolean
  onRename: (label: string) => Promise<void>
  onUndo: () => void
}) {
  const revoked = device.revokedAt !== undefined
  const revokedByUpgrade = device.revocationReason !== undefined
    && revokedByUpgradeReason[device.revocationReason]
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)

  const close = () => {
    setDraft(null)
    setInvalid(false)
  }
  const save = async () => {
    if (draft === null) return
    const label = deviceRenameLabelSchema.safeParse(draft)
    if (!label.success) {
      setInvalid(true)
      return
    }
    if (label.data === device.label) {
      close()
      return
    }
    await onRename(label.data)
    close()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      void save()
    } else if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
  }

  return (
    <th scope="row" className={`${rowCell} pr-3 text-left align-top font-medium`}>
      {draft === null ? (
        <span className={labelLine}>
          <span
            className={`min-w-0 max-w-[34ch] truncate text-[12.5px] leading-snug font-medium ${
              revoked ? "text-muted-foreground" : "text-strong"
            }`}
            title={device.label}
          >
            {device.label}
          </span>
          {undoable ? (
            <Button variant="ghost" className={quietControl} disabled={disabled} onClick={onUndo}>
              Undo
            </Button>
          ) : (
            <Button
              variant="ghost"
              className={quietControl}
              disabled={disabled}
              aria-label={`Rename ${device.label}`}
              onClick={() => setDraft(device.label)}
            >
              Rename
            </Button>
          )}
        </span>
      ) : (
        <InputGroup className={`${labelLine} max-w-[40ch] rounded-md`}>
          <InputGroupInput
            autoFocus
            aria-label={`Name for ${device.label}`}
            aria-invalid={invalid || undefined}
            maxLength={maximumPairedDeviceLabelLength}
            className="h-7 px-2 text-[12.5px] font-medium text-strong md:text-[12.5px]"
            disabled={disabled}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setInvalid(false)
            }}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon align="inline-end" className="gap-1 pr-1">
            <InputGroupButton className={savePill} disabled={disabled} onClick={() => void save()}>
              Save
            </InputGroupButton>
            <InputGroupButton className={cancelPill} disabled={disabled} onClick={close}>
              Cancel
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      )}
      {revoked && !revokedByUpgrade ? (
        <span className="mt-2 block">
          <StatusChip tone="destructive">Revoked</StatusChip>
        </span>
      ) : null}
      {revokedByUpgrade ? (
        <>
          <span className="mt-2 block">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="rounded-[4px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
                >
                  <StatusChip tone="warning">Revoked by upgrade</StatusChip>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[42ch] text-[11.5px] leading-relaxed">
                {migrationNote}
              </TooltipContent>
            </Tooltip>
          </span>
          <p
            className={`${coarseFallback} mt-2 max-w-[46ch] text-[11px] leading-relaxed font-normal text-muted-foreground`}
          >
            {migrationNote}
          </p>
        </>
      ) : null}
    </th>
  )
}

function DeviceRow({
  device,
  disabled,
  undoable,
  onRotate,
  onRevoke,
  onRename,
  onUndoRename,
}: {
  device: PairedDeviceSummary
  disabled: boolean
  undoable: boolean
  onRotate: () => void
  onRevoke: () => void
  onRename: (label: string) => Promise<void>
  onUndoRename: () => void
}) {
  const revoked = device.revokedAt !== undefined
  const isMachine = device.binding.kind === "machine"
  return (
    <tr>
      <KindCell binding={device.binding} dimmed={revoked} />
      <LabelCell
        device={device}
        disabled={disabled}
        undoable={undoable}
        onRename={onRename}
        onUndo={onUndoRename}
      />
      <td className={`${rowCell} pr-3 align-top ${monoValue} text-muted-foreground`} title={device.pairedAt}>
        {when(device.pairedAt)}
      </td>
      <td
        className={`${rowCell} pr-3 align-top ${monoValue} text-muted-foreground`}
        title={revoked ? device.revokedAt : device.lastSeenAt}
      >
        {revoked ? `revoked ${when(device.revokedAt)}` : when(device.lastSeenAt)}
      </td>
      <td className={`${rowCell} align-top`}>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className={secondaryControl}
            disabled={disabled || revoked}
            aria-label={
              isMachine
                ? `Rotate the credential ${device.label} uses`
                : `Rotate the credential on ${device.label}`
            }
            onClick={onRotate}
          >
            Rotate
          </Button>
          <span className="flex-1" />
          {revoked ? (
            <Button
              variant="ghost"
              className={destructiveControl}
              disabled
              aria-label={`Revoke ${device.label}`}
            >
              Revoke
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className={destructiveControl}
                  disabled={disabled}
                  aria-label={`Revoke ${device.label}`}
                  onClick={onRevoke}
                >
                  Revoke
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[38ch] text-[11.5px] leading-relaxed">
                {revokeConsequence(device.binding)}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {revoked ? null : (
          <p className={`${coarseFallback} mt-2 max-w-[38ch] text-[11px] leading-relaxed text-muted-foreground`}>
            {revokeConsequence(device.binding)}
          </p>
        )}
      </td>
    </tr>
  )
}

function CredentialPanel({ token }: { token: string }) {
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setCopyFailed(false)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-accent px-[15px] py-[14px]">
      <div className={panelEyebrow}>New credential, shown once</div>
      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        <span
          className={`flex-1 font-machine text-[15px] tracking-[.1em] ${
            revealed ? "break-all text-primary" : "text-faint"
          }`}
        >
          {revealed ? token : <span aria-hidden="true">{maskedRun}</span>}
          {revealed ? null : <span className="sr-only">Credential hidden</span>}
        </span>
        <div className="flex items-center gap-2">
          <Button className={primaryControl} onClick={() => void copy()}>
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            variant="outline"
            className={`${secondaryControl} px-[9px]`}
            aria-pressed={revealed}
            aria-label={revealed ? "Hide the credential" : "Show the credential"}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {copyFailed
          ? "This browser refused the clipboard. Reveal it and copy it by hand."
          : copied
            ? "Copied to the clipboard."
            : "Copy it without reading it. Nothing here needs the value on screen."}
      </p>
    </div>
  )
}

// The receipt is one live region, so a rotation announces itself and a copy
// confirmation is announced through the same region rather than a nested one.
function RotationReceipt({ device, token }: { device: PairedDeviceSummary; token: string }) {
  return (
    <tr>
      <td colSpan={5} className="border-b py-2.5">
        <div role="status" className="rounded-xl border border-border bg-card px-[15px] py-[14px]">
          <div className="text-[13.5px] font-medium">New credential for {device.label}</div>
          <p className="mt-1.5 max-w-[72ch] text-[11.5px] leading-[1.6] text-muted-foreground">
            {rotationInstruction(device.binding)}
          </p>
          <CredentialPanel token={token} />
        </div>
      </td>
    </tr>
  )
}

function RevokeConfirmation({
  device,
  busy,
  onConfirm,
  onClose,
}: {
  device: PairedDeviceSummary | null
  busy: boolean
  onConfirm: (device: PairedDeviceSummary) => void
  onClose: () => void
}) {
  const binding = device?.binding
  const isMachine = binding?.kind === "machine"
  return (
    <AlertDialog open={device !== null} onOpenChange={(next) => { if (!next) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex w-full items-center gap-2.5">
            <AlertDialogTitle className="min-w-0 flex-1 break-words text-[13.5px]">
              Revoke {device?.label}
            </AlertDialogTitle>
            {binding?.kind === "machine" ? (
              <Badge variant="machine" className="shrink-0" title={binding.machineId}>
                {shortMachineId(binding.machineId)}
              </Badge>
            ) : null}
          </div>
          <AlertDialogDescription asChild>
            <div className="text-[12px] leading-[1.6] text-muted-foreground [&>p+p]:mt-2.5">
              {isMachine ? (
                <>
                  <p className="m-0">
                    This machine stops accepting that one. Sessions running there keep running and
                    stay reachable from that machine, but this one can no longer reach them, and a
                    transfer to it is refused rather than queued.
                  </p>
                  <p className="m-0">
                    Pairing it again needs someone with access to that machine, not to this one.
                  </p>
                </>
              ) : (
                <>
                  <p className="m-0">
                    That {binding ? heldWord(binding) : "device"} loses access to this machine
                    immediately and has to be paired again, from the
                    {" "}{binding ? heldWord(binding) : "device"}, to come back.
                  </p>
                  <p className="m-0">Sessions already on this machine are untouched.</p>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className={secondaryControl}>
            {isMachine ? "Keep machine" : "Keep device"}
          </AlertDialogCancel>
          <AlertDialogAction
            className={dangerControl}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              if (device) onConfirm(device)
            }}
          >
            {isMachine ? "Revoke machine" : "Revoke device"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ForgetConfirmation({
  machine,
  busy,
  onConfirm,
  onClose,
}: {
  machine: FleetMachine | null
  busy: boolean
  onConfirm: (machine: FleetMachine) => void
  onClose: () => void
}) {
  const label = machine?.label ?? "this machine"
  return (
    <AlertDialog open={machine !== null} onOpenChange={(next) => { if (!next) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex w-full items-center gap-2.5">
            <AlertDialogTitle className="min-w-0 flex-1 break-words text-[13.5px]">
              Forget {machine?.label}
            </AlertDialogTitle>
            {machine ? (
              <Badge variant="machine" className="shrink-0" title={machine.id}>
                {shortMachineId(machine.id)}
              </Badge>
            ) : null}
          </div>
          <AlertDialogDescription asChild>
            <div className="text-[12px] leading-[1.6] text-muted-foreground [&>p+p]:mt-2.5">
              <p className="m-0">
                This machine deletes the credential it holds for {label} and stops reaching it.
                Sessions running there keep running.
              </p>
              <p className="m-0">
                There is no revocation across machines. {label} is asked to revoke this machine,
                and if it does not confirm, you revoke this machine in its Devices list yourself.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className={secondaryControl}>Keep machine</AlertDialogCancel>
          <AlertDialogAction
            className={dangerControl}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              if (machine) onConfirm(machine)
            }}
          >
            Forget machine
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// A forget answers once, and what it says decides what the operator does next,
// so the answer stands in the Machines section as a live region until the next one.
function ForgetReceipt({ notice }: { notice: ForgetMachineNotice }) {
  return (
    <div
      role="status"
      aria-label={notice.title}
      className="rounded-xl border border-border bg-card px-[15px] py-[14px]"
    >
      <div className="text-[13.5px] font-medium">{notice.title}</div>
      <p className="mt-1.5 max-w-[72ch] text-[11.5px] leading-[1.6] text-muted-foreground">{notice.detail}</p>
    </div>
  )
}

// The daemon withheld the whole list, so the cards below are this machine
// alone and must not read as the fleet. The notice says so and names the
// daemon-side CLI, since nothing on this surface can shrink the keychain.
function FleetOverflowAlert({ overflow }: { overflow: FleetSnapshotOverflow }) {
  const notice = fleetOverflowNotice(overflow)
  return (
    <Alert variant="destructive">
      <CircleStopIcon />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="[&>p+p]:mt-2">
        <p className="m-0">{notice.detail}</p>
        <p className="m-0">{notice.remedy}</p>
      </AlertDescription>
    </Alert>
  )
}

export function FleetView({
  connected,
  entries,
  fleetOverflow,
  currentMachineId,
  currentSessionCount,
  onOpenSkills,
  onListDevices,
  onRevokeDevice,
  onRotateDevice,
  onRenameDevice,
  onPairMachine,
  onForgetMachine,
  onUseMachine,
  onOpenMachineTerminal,
}: {
  connected: boolean
  entries: FleetEntry[]
  fleetOverflow: FleetSnapshotOverflow | null
  currentMachineId: string
  currentSessionCount: number
  onOpenSkills: () => void
  onListDevices: (
    options?: DomovoiRequestOptions,
  ) => Promise<{ devices: PairedDeviceSummary[] }>
  onRevokeDevice: (params: { deviceId: string }) => Promise<{ device: PairedDeviceSummary }>
  onRotateDevice: (params: { deviceId: string }) => Promise<DevicePairResult>
  onRenameDevice: (params: { deviceId: string; label: string }) => Promise<{ device: PairedDeviceSummary }>
  onPairMachine?: ((request: PairMachineRequest) => Promise<PairedMachine>) | undefined
  onForgetMachine?: ((machineId: string) => Promise<FleetForgetResult>) | undefined
  onUseMachine?: ((machineId: string) => void) | undefined
  onOpenMachineTerminal?: ((machineId: string) => void) | undefined
}) {
  const [devices, setDevices] = useState<PairedDeviceSummary[] | null>(null)
  const [devicesError, setDevicesError] = useState("")
  const [actionError, setActionError] = useState("")
  const [pendingDeviceId, setPendingDeviceId] = useState("")
  const [revoking, setRevoking] = useState<PairedDeviceSummary | null>(null)
  const [receipt, setReceipt] = useState<{ device: PairedDeviceSummary; token: string } | null>(null)
  const [undo, setUndo] = useState<{ deviceId: string; label: string } | null>(null)
  const [pairing, setPairing] = useState(false)
  const [forgetting, setForgetting] = useState<FleetMachine | null>(null)
  const [forgetPending, setForgetPending] = useState(false)
  const [forgetNotice, setForgetNotice] = useState<ForgetMachineNotice | null>(null)

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

  const renameDevice = async (device: PairedDeviceSummary, label: string) => {
    setPendingDeviceId(device.id)
    setActionError("")
    try {
      const result = await onRenameDevice({ deviceId: device.id, label })
      replaceDevice(result.device)
      setUndo({ deviceId: device.id, label: device.label })
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "That device could not be renamed")
    } finally {
      setPendingDeviceId("")
    }
  }

  // Undo is one more rename, back to the word the row had. It does not offer
  // an undo of its own: the row is back where it started.
  const undoRename = async () => {
    if (!undo) return
    setPendingDeviceId(undo.deviceId)
    setActionError("")
    try {
      const result = await onRenameDevice(undo)
      replaceDevice(result.device)
      setUndo(null)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "That device could not be renamed")
    } finally {
      setPendingDeviceId("")
    }
  }

  const forgetMachine = async (machine: FleetMachine) => {
    if (!onForgetMachine) return
    setForgetPending(true)
    setForgetNotice(null)
    try {
      setForgetNotice(forgetMachineNotice(await onForgetMachine(machine.id), machine.label))
    } catch (cause) {
      setForgetNotice({
        outcome: "refused",
        title: `${machine.label} was not forgotten`,
        detail: cause instanceof Error ? cause.message : "That machine could not be forgotten",
      })
    } finally {
      setForgetPending(false)
      setForgetting(null)
    }
  }

  const rotateDevice = async (device: PairedDeviceSummary) => {
    setPendingDeviceId(device.id)
    setActionError("")
    setReceipt(null)
    try {
      const result = await onRotateDevice({ deviceId: device.id })
      replaceDevice(result.device)
      setReceipt({ device: result.device, token: result.token })
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

          <section className="mt-5 flex flex-col gap-2.5" aria-label="Machines">
            <h2 className="m-0 text-[13px] font-semibold">Machines</h2>
            {fleetOverflow ? <FleetOverflowAlert overflow={fleetOverflow} /> : null}
            {forgetNotice?.outcome === "refused" ? (
              <Alert variant="destructive">
                <CircleStopIcon />
                <AlertTitle>{forgetNotice.title}</AlertTitle>
                <AlertDescription>{forgetNotice.detail}</AlertDescription>
              </Alert>
            ) : null}
            {forgetNotice && forgetNotice.outcome !== "refused" ? <ForgetReceipt notice={forgetNotice} /> : null}
            {entries.map((entry) => entryCard(entry, (machine) => (
              <MachineCard
                key={machine.id}
                machine={machine}
                fleet={entries}
                {...(machine.id === currentMachineId ? { sessionCount: currentSessionCount } : { sessionCount: undefined })}
                inUse={machine.id === currentMachineId}
                connected={connected}
                {...(onUseMachine ? { onUse: onUseMachine } : {})}
                {...(onOpenMachineTerminal ? { onOpenTerminal: onOpenMachineTerminal } : {})}
                {...(onForgetMachine ? { onForget: (target: FleetMachine) => setForgetting(target) } : {})}
              />
            )))}
          </section>

          <section className="mt-7" aria-label="Paired devices">
            <h2 className="m-0 text-[13.5px] font-medium">Paired devices</h2>
            <p className="mt-1.5 max-w-[620px] text-[12.5px] leading-[1.6] text-muted-foreground">
              Every credential this machine accepts, and what holds it. A revoked credential cannot
              reconnect. Rotating issues a new one and retires the old one.
            </p>

            {actionError ? (
              <Alert variant="destructive" className="mt-4">
                <CircleStopIcon />
                <AlertTitle>Device action failed</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            ) : null}

            {devicesError ? (
              <Alert variant="destructive" className="mt-4">
                <CircleStopIcon />
                <AlertTitle>Paired devices unavailable</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-3">
                  {devicesError}
                  <Button variant="outline" className={secondaryControl} onClick={() => void loadDevices()}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            {devices && devices.length > 0 ? (
              <table className="mt-4 w-full border-collapse">
                <caption className="sr-only">Devices paired with this machine</caption>
                <DeviceTableHead />
                <tbody>
                  {devices.flatMap((paired) => {
                    const row = (
                      <DeviceRow
                        key={paired.id}
                        device={paired}
                        disabled={!connected || pendingDeviceId === paired.id}
                        undoable={undo?.deviceId === paired.id}
                        onRotate={() => void rotateDevice(paired)}
                        onRevoke={() => setRevoking(paired)}
                        onRename={(label) => renameDevice(paired, label)}
                        onUndoRename={() => void undoRename()}
                      />
                    )
                    // Keyed by the credential, so a fresh receipt mounts fresh and
                    // never inherits the last one's revealed state.
                    return receipt?.device.id === paired.id
                      ? [row, <RotationReceipt key={`${paired.id}:${receipt.token}`} device={receipt.device} token={receipt.token} />]
                      : [row]
                  })}
                </tbody>
              </table>
            ) : null}

            {devices && devices.length === 0 ? (
              <Empty className="mt-4 min-h-40 border">
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
              <>
                <table className="mt-4 w-full animate-pulse border-collapse">
                  <caption className="sr-only">Devices paired with this machine</caption>
                  <DeviceTableHead />
                  <tbody>
                    <LoadingRow wide={false} />
                    <LoadingRow wide />
                    <LoadingRow wide={false} />
                  </tbody>
                </table>
                <p role="status" className="mt-3 font-machine text-[11.5px] text-faint">
                  Loading paired devices
                </p>
              </>
            ) : null}
          </section>
        </main>
      </ScrollArea>

      <RevokeConfirmation
        device={revoking}
        busy={pendingDeviceId !== ""}
        onConfirm={(device) => void revokeDevice(device)}
        onClose={() => setRevoking(null)}
      />

      <ForgetConfirmation
        machine={forgetting}
        busy={forgetPending}
        onConfirm={(machine) => void forgetMachine(machine)}
        onClose={() => setForgetting(null)}
      />

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
