import { useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react"
import { ArrowUpIcon, Maximize2Icon, PaperclipIcon, SquareIcon, TerminalIcon, XIcon } from "lucide-react"
import type {
  ProviderModel,
  ProviderRuntime,
  Runtime,
  RuntimeDiscoverResult,
  SessionAttachment,
  SessionTurn,
  SessionUsage,
  UsageWindow,
} from "@getdomovoi/protocol"

import { Button } from "./components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Input } from "./components/ui/input"
import { Textarea } from "./components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { composerPlaceholder, composerPlatform, sendHint } from "./composer-keys"
import { slashArgument, slashCommands, type SlashCommand, type SlashIntentContext } from "./composer-slash"
import {
  attachmentFromBrowserFile,
  attachmentMeta,
  attachmentName,
  desktopAttachmentLimit,
  inlineTextPreview,
  terminalOutputAttachment,
  workspacePathAttachment,
} from "./desktop-attachments"
import { FloatingSurface } from "./floating-surface"
import { cn } from "./lib/utils"
import { EffortChip, ModeChip } from "./mode-chip.js"
import { ModelPopover } from "./model-popover.js"
import { deliveryLabel, type FailedAttempt, type QueuedMessage } from "./turn-queue"
import { UsageChip } from "./usage-chip.js"

// The composer card under the thread: notices, the queue, attachments, the
// field and its slash list, and the action row. Thread owns the draft and the
// send, so a session switch that remounts Thread resets this with it.
export function ThreadComposer({
  notice,
  failures,
  onQueuedChange,
  onDismissFailure,
  sending,
  queued,
  turnRunning,
  pending,
  connected,
  readOnly,
  watching,
  emergencyStopPending,
  providerRestartRequired,
  surface,
  machineName,
  prompt,
  onPromptChange,
  attachments,
  onAttachmentsChange,
  slashOpen,
  slashContext,
  onSlashDismissedChange,
  onSubmit,
  runtime,
  providers,
  runtimePending,
  forkCheckpointId,
  forkBlockedReason,
  onListModels,
  onDiscoverRuntime,
  onRuntimeChange,
  onFork,
  effortModel,
  effortDropped,
  onOpenSheet,
  onOpenPromptEditor,
  usage,
  usageToday,
  loadLatestTurn,
  onStop,
  children,
}: {
  // The watching or read-only notice the session needs, drawn first.
  notice: ReactNode
  // Already narrowed to this session.
  failures: readonly FailedAttempt[]
  onQueuedChange: (next: QueuedMessage | undefined) => void
  onDismissFailure?: ((id: string) => void) | undefined
  sending: string | null
  // Already narrowed to this session.
  queued: QueuedMessage | undefined
  turnRunning: boolean
  pending: boolean
  connected: boolean
  readOnly: boolean
  watching: boolean
  emergencyStopPending: boolean
  providerRestartRequired: boolean
  surface: "desktop" | "web"
  machineName: string
  prompt: string
  onPromptChange: (prompt: string) => void
  attachments: SessionAttachment[]
  onAttachmentsChange: Dispatch<SetStateAction<SessionAttachment[]>>
  slashOpen: boolean
  // What this session offers the slash commands: the list names it.
  slashContext: SlashIntentContext
  onSlashDismissedChange: (dismissed: boolean) => void
  onSubmit: () => void
  runtime: Runtime
  providers: readonly ProviderRuntime[]
  runtimePending: boolean
  forkCheckpointId?: string | undefined
  forkBlockedReason?: string | undefined
  onListModels: (provider: string) => Promise<ProviderModel[]>
  onDiscoverRuntime?: ((provider: string) => Promise<RuntimeDiscoverResult>) | undefined
  onRuntimeChange: (runtime: Runtime) => void
  onFork: (runtime: Runtime, checkpointId: string, requestId: string) => Promise<void>
  effortModel: ProviderModel | undefined
  effortDropped: { from: string, to: string, toDefault: boolean } | undefined
  onOpenSheet?: (() => void) | undefined
  onOpenPromptEditor: () => void
  usage: SessionUsage | null
  usageToday: UsageWindow | null | undefined
  loadLatestTurn?: ((signal: AbortSignal) => Promise<SessionTurn | undefined>) | undefined
  onStop: () => void
  // The machine menu and the dialogs it opens, kept inside the card.
  children?: ReactNode
}) {
  const [attachmentPathMode, setAttachmentPathMode] = useState<"repo" | "machine" | null>(null)
  const [attachmentPath, setAttachmentPath] = useState("")
  const [attachmentError, setAttachmentError] = useState("")
  const attachmentInput = useRef<HTMLInputElement>(null)
  const composerField = useRef<HTMLTextAreaElement>(null)
  const composerCard = useRef<HTMLDivElement>(null)
  const slashListId = useId()
  const slashQuery = prompt.split(/\s/u, 1)[0] ?? ""
  const paletteShortcut = composerPlatform() === "darwin" ? "⌘K" : "Ctrl+K"

  const addAttachments = (next: SessionAttachment[]) => {
    const combined = [...attachments, ...next]
    if (combined.length > desktopAttachmentLimit) {
      setAttachmentError(`Attach up to ${desktopAttachmentLimit} items per message.`)
      return
    }
    setAttachmentError("")
    onAttachmentsChange(combined)
  }
  const attachWorkspacePath = () => {
    try {
      addAttachments([workspacePathAttachment(attachmentPath)])
      setAttachmentPath("")
      setAttachmentPathMode(null)
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "That path cannot be attached")
    }
  }
  const attachClipboardOutput = async () => {
    try {
      const content = await navigator.clipboard.readText()
      addAttachments([terminalOutputAttachment(content)])
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "Terminal output could not be read from the clipboard")
    }
  }
  const takeSlashCommand = (command: SlashCommand) => {
    if (watching) return
    const accepted = `${command.name} `
    onPromptChange(accepted)
    onSlashDismissedChange(true)
    queueMicrotask(() => {
      const field = composerField.current
      field?.focus()
      field?.setSelectionRange(accepted.length, accepted.length)
    })
  }

  return (
    <div ref={composerCard} data-workspace-composer="" className={cn(
      "relative mx-auto flex max-w-[var(--shell-thread)] flex-col gap-[11px] rounded-[16px] border bg-card pt-[13px] pr-[15px] pb-[11px] pl-[15px]",
      readOnly && "[&_button:disabled]:opacity-[.45]",
    )}>
      {notice}
      {failures.map((attempt) => (
        <div key={attempt.id} className="flex items-center gap-2 rounded-lg border border-danger-border bg-danger-background px-3 py-2">
          <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-danger-foreground" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-danger-foreground">{attempt.text}</span>
          <span className="text-[10.5px] whitespace-nowrap text-danger-dim">{deliveryLabel(attempt)}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={readOnly}
              onClick={() => {
              // Queueing it again replaces whatever is waiting, which the
              // person can see beside it before they press.
              onQueuedChange({
                sessionId: attempt.sessionId,
                text: attempt.text,
                state: "waiting",
                ...(attempt.skillIds ? { skillIds: attempt.skillIds } : {}),
              })
              onDismissFailure?.(attempt.id)
            }}
          >
            {attempt.delivery === "refused" ? "Queue again" : "Send anyway"}
          </Button>
          <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => onDismissFailure?.(attempt.id)}>Dismiss</Button>
        </div>
      ))}
      {sending !== null ? (
        <div role="status" aria-label="Sending" className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
          <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-faint" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-strong">{sending}</span>
          <span className="font-machine text-[10.5px] whitespace-nowrap text-faint">sending</span>
        </div>
      ) : null}
      {queued ? (
        <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
          <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-faint" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-strong">{queued.text}</span>
          <span className="font-machine text-[10.5px] whitespace-nowrap text-faint">
            {queued.state === "held"
              ? queued.reason ?? "held"
              : turnRunning ? "queued, sends when this turn ends" : "queued"}
          </span>
          {queued.state === "held" ? (
            <Button variant="ghost" size="sm" disabled={readOnly || turnRunning || pending || emergencyStopPending || providerRestartRequired} onClick={() => onQueuedChange({ ...queued, state: "waiting" })}>Send</Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" aria-label="Unqueue the message" className="size-6 flex-none text-faint" disabled={readOnly} onClick={() => onQueuedChange(undefined)}><XIcon className="size-3" /></Button>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div role="region" className="flex min-w-0 items-center gap-[7px] overflow-hidden" aria-label="Attachments">
          {attachments.map((attachment, index) => {
            return (
              <div key={`${attachmentName(attachment)}-${index}`} className="flex min-w-0 max-w-[260px] items-center gap-[7px] rounded-md border bg-background px-2 py-1">
                <span className="font-machine text-[10.5px] text-primary">{"kind" in attachment && attachment.kind === "text" ? "TXT" : "FILE"}</span>
                <span className="min-w-0 truncate font-machine text-[10.5px] text-strong">{attachmentName(attachment)}</span>
                <span className="font-machine text-[10px] text-faint">{attachmentMeta(attachment)}</span>
                <Button variant="ghost" size="icon-sm" className="size-5 flex-none text-faint" aria-label={`Remove ${attachmentName(attachment)}`} onClick={() => onAttachmentsChange((current) => current.filter((_, candidate) => candidate !== index))}><XIcon className="size-3" /></Button>
              </div>
            )
          })}
        </div>
      ) : null}
      {attachments.some((attachment) => Boolean(inlineTextPreview(attachment))) ? (
        <p className="m-0 text-[10.5px] leading-[1.45] text-warning">Too long to send inline. The prompt carries the first 40 lines, the agent reads the rest on request.</p>
      ) : null}
      {attachmentPathMode ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            aria-label={attachmentPathMode === "repo" ? "File in this repo" : `Path on ${machineName}`}
            value={attachmentPath}
            onChange={(event) => setAttachmentPath(event.target.value)}
            placeholder={attachmentPathMode === "repo" ? "src/path/to/file.ts" : "relative/path/on/machine"}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); attachWorkspacePath() } }}
          />
          <Button type="button" size="sm" disabled={!attachmentPath.trim()} onClick={attachWorkspacePath}>Attach</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAttachmentPathMode(null)}>Cancel</Button>
        </div>
      ) : null}
      <input
        ref={attachmentInput}
        type="file"
        accept="image/png,image/jpeg,text/plain,.md,.json,.csv,.log"
        className="sr-only"
        aria-label="Choose an image or file"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.currentTarget.value = ""
          void Promise.all(files.map(attachmentFromBrowserFile)).then(addAttachments, (cause: unknown) => {
            setAttachmentError(cause instanceof Error ? cause.message : "The file could not be attached")
          })
        }}
      />
      {attachmentError ? <p role="alert" className="m-0 text-[11px] text-destructive">{attachmentError}</p> : null}
      {slashOpen ? (
        <div aria-hidden className="flex min-h-[22px] items-center gap-px">
          <span className="font-machine text-[13.5px] text-foreground">{prompt}</span>
          <span className="h-[15px] w-[1.5px] bg-primary animate-[dv-composer-caret_1.1s_steps(1)_infinite]" />
        </div>
      ) : null}
      <Textarea
        ref={composerField}
        aria-label="Message"
        aria-expanded={slashOpen}
        aria-controls={slashOpen ? slashListId : undefined}
        rows={2}
        disabled={readOnly}
        // v2 draws the field with no box of its own: it sits straight on
        // the card. The dark variant on the shared Textarea has to be
        // turned off by name, or it paints a panel the design never draws.
        // Its md:text-sm is overridden the same way, at the same breakpoint,
        // or the field renders at 14px on every desktop width.
        className={slashOpen
          ? "sr-only"
          : "max-h-[172px] min-h-[22px] resize-none overflow-y-auto border-0 bg-transparent p-0 text-[13.5px] leading-[1.6] shadow-none [field-sizing:content] focus-visible:ring-0 md:text-[13.5px] dark:bg-transparent"}
        placeholder={surface === "web" && connected
          ? "Steer it, or queue the next message"
          : composerPlaceholder({ offline: !connected, working: turnRunning })}
        value={prompt}
        onChange={(event) => {
          const next = event.target.value
          onPromptChange(next)
          if (!next.startsWith("/")) onSlashDismissedChange(false)
        }}
        onKeyDown={(event) => {
          // Enter sends, as the hint beside the send control says. Shift
          // keeps the newline, and the old modifier still sends so a hand
          // trained on it is not left pressing a dead key.
          if (event.key !== "Enter" || event.shiftKey) return
          event.preventDefault()
          onSubmit()
        }}
      />
      <FloatingSurface
        open={slashOpen}
        onClose={() => onSlashDismissedChange(true)}
        label="Slash commands"
        placement="above"
        trigger={composerCard}
        className="w-[380px] overflow-hidden rounded-[calc(var(--radius)-2px)] p-0"
      >
        <div
          id={slashListId}
          role="listbox"
          aria-labelledby={`${slashListId}-label`}
        >
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span id={`${slashListId}-label`} className="text-[10.5px] font-medium tracking-[.13em] text-faint">THIS TURN</span>
            <span className="flex-1" />
            <span className="text-[11px] text-faint">{paletteShortcut} to go somewhere</span>
          </div>
          <div className="max-h-[216px] overflow-y-auto">
            {slashCommands.map((command) => {
              const match = command.name.startsWith(slashQuery)
              const argument = slashArgument(command, slashContext)
              return (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-label={`${command.name} ${argument}`}
                  aria-selected={false}
                  data-match={match}
                  title={command.note}
                  onClick={() => takeSlashCommand(command)}
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2.5 border-t px-3 text-left first:border-t-0",
                    !match && "opacity-50",
                  )}
                >
                  <span className={cn(
                    "w-[70px] flex-none font-machine text-[11.5px]",
                    match ? "text-primary" : "text-muted-foreground",
                  )}>{command.name}</span>
                  <span className="min-w-0 flex-1 truncate font-machine text-[10.5px] text-faint">{argument}</span>
                </button>
              )
            })}
          </div>
        </div>
      </FloatingSurface>
      <div data-workspace-composer-actions="" className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Attach" className="size-7 rounded-full" disabled={readOnly || attachments.length >= desktopAttachmentLimit}>
                <PaperclipIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-[400px] p-0">
              <DropdownMenuItem aria-label="File in this repo" className="items-start gap-[11px] rounded-none px-[13px] py-[11px]" onSelect={() => setAttachmentPathMode("repo")}>
                <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">TS</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-foreground">File in this repo</span>
                  <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">A path in the worktree. Nothing is copied, the agent reads it where it is.</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem aria-label={`Path on ${machineName}`} className="items-start gap-[11px] rounded-none border-t px-[13px] py-[11px]" onSelect={() => setAttachmentPathMode("machine")}>
                <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">DIR</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-foreground">Path on {machineName}</span>
                  <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">Anything else on that machine, including files outside the project. Reading outside the project asks first.</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem aria-label="Image or file from this device" className="items-start gap-[11px] rounded-none border-t px-[13px] py-[11px]" onSelect={() => attachmentInput.current?.click()}>
                <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">FILE</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-foreground">Image or file from this device</span>
                  <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">The selected file is copied to {machineName} with the next message.</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem aria-label="Paste terminal output" className="items-start gap-[11px] rounded-none border-t px-[13px] py-[11px]" onSelect={() => void attachClipboardOutput()}>
                <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">LOG</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-foreground">Paste terminal output</span>
                  <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">Pasted text, kept as a file in the session rather than inline in the message.</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* v2's model chip follows the attachment control and opens the flat,
              searchable list of what every harness here reports. */}
          <ModelPopover
            runtime={runtime}
            providers={providers}
            machineName={machineName}
            pending={runtimePending || readOnly}
            turnRunning={turnRunning}
            {...(forkCheckpointId ? { forkCheckpointId } : {})}
            {...(forkBlockedReason ? { forkBlockedReason } : {})}
            onListModels={onListModels}
            onDiscoverRuntime={onDiscoverRuntime}
            onChange={onRuntimeChange}
            onFork={onFork}
          />
          {/* v2's mode chip sits beside the model, and the effort chip
              after it. */}
          <ModeChip runtime={runtime} pending={runtimePending || readOnly} onSetRuntime={onRuntimeChange} />
          <EffortChip
            runtime={runtime}
            model={effortModel}
            dropped={effortDropped}
            pending={runtimePending || readOnly}
            onSetRuntime={onRuntimeChange}
          />
          {/* v2 opens the machine surfaces from the row itself, on Changes.
              It is the only control here that looks at the machine rather
              than at what the next turn sends. */}
          {onOpenSheet ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open the sheet"
              className="size-7 flex-none rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={onOpenSheet}
            >
              <TerminalIcon className="size-4" />
            </Button>
          ) : null}
          {/* The editor is the same draft in a larger field. v2 draws its
              control here, beside the surfaces it runs against, not out at
              the send end of the row. */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Expand prompt editor"
            className="size-7 flex-none rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            disabled={readOnly}
            onClick={onOpenPromptEditor}
          >
            <Maximize2Icon className="size-4" />
          </Button>
          {/* v2 draws no checkpoint control in the composer. /revert
              rewinds to one, and the Checkpoints sheet tab lists them. */}
          {/* Archiving lives on the session's own row in the drawer, which
              asks with these same words. v2 draws no archive control in
              the composer, so this row no longer carries a second one. */}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* v2's usage chip belongs to the composer, at the right of its
              action row. The sidebar reorganisation moves the row with it. */}
          <UsageChip usage={usage} today={usageToday} loadLatestTurn={loadLatestTurn} />
          <span role="status" className="flex flex-col items-end font-machine text-mono-xs leading-[1.35] text-faint">
            {providerRestartRequired
              ? <span>Restart the provider before sending</span>
              : sendHint(composerPlatform()).split(" · ").map((line) => (
                  <span key={line} className="whitespace-nowrap">{line}</span>
                ))}
          </span>
          {/* v2 draws stop as a 28px round bordered control beside send,
              not as a labelled button out among the chips. */}
          {turnRunning ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Stop the agent"
                    className="size-7 flex-none rounded-full"
                    disabled={readOnly || pending || !connected}
                    onClick={onStop}
                  >
                    <SquareIcon className="size-2.5 fill-current" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8} className="block w-[220px] bg-card px-[11px] py-[9px] text-foreground ring-1 ring-border">
                  <span className="block text-[11.5px]">Stop the agent</span>
                  <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">Ends this turn at its next tool boundary. The session, plan and worktree stay as they are.</span>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}<Button size="icon-sm" className="rounded-full" aria-label="Send message" disabled={readOnly || !prompt.trim() || pending || !connected || providerRestartRequired || emergencyStopPending} onClick={onSubmit}><ArrowUpIcon /></Button></div>
      </div>
      {children}
    </div>
  )
}
