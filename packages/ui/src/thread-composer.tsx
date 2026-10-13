import { useId, useRef, useState, type ClipboardEvent, type Dispatch, type ReactNode, type SetStateAction } from "react"
import { ArrowUpIcon, LockIcon, Maximize2Icon, PaperclipIcon, SquareIcon, TerminalIcon, XIcon } from "lucide-react"
import {
  modelImageInputRefusalCode,
  type ProviderModel,
  type ProviderRuntime,
  type Runtime,
  type RuntimeDiscoverResult,
  type SessionAttachment,
  type SessionTurn,
  type SessionUsage,
  type UsageWindow,
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
import { useWorkspaceConnection } from "./connection-status"
import { slashArgument, slashCommands, type SlashCommand, type SlashIntentContext } from "./composer-slash"
import {
  attachmentFromBrowserFile,
  attachmentMark,
  attachmentMeta,
  attachmentName,
  desktopAttachmentLimit,
  inlineTextPreview,
  isImageAttachment,
  pasteOutcome,
  type PasteOutcome,
  pastedText,
  terminalOutputAttachment,
  workspacePathAttachment,
} from "./desktop-attachments"
import { PastedTextCard } from "./pasted-text-card"
import { PreviewVariantCopy } from "./preview-controls"
import { FloatingSurface } from "./floating-surface"
import { cn } from "./lib/utils"
import { EffortChip, ModeChip } from "./mode-chip.js"
import { ModelPopover } from "./model-popover.js"
import { deliveryLabel, type FailedAttempt, type QueuedMessage } from "./turn-queue"
import { UsageChip } from "./usage-chip.js"

type ChipItem = {
  key: string
  mark: string
  name: string
  meta: string
  blocked: boolean
  removeLabel: string
  onRemove: () => void
}

const lockedNoticeAction = "rounded-full border border-danger-border px-2.5 py-1 text-[11px] whitespace-nowrap text-danger-foreground disabled:opacity-50"

// J42's sentence around the model id, which the composer sets in mono.
export function lockedImagesWords(count: number): { lead: string, tail: string } {
  return count === 1
    ? { lead: "1 image cannot go to ", tail: ". Remove it or pick another model." }
    : { lead: `${count} images cannot go to `, tail: ". Remove them or pick another model." }
}

// The reason a queued message with images is held while the model takes none.
export function imagesHeldReason(modelId: string): string {
  return `Held because ${modelId} takes no image input. Change the model, or unqueue it and attach again without the images.`
}

// What the attach menu's footer says of the model, as the phone says it.
export function imageInputLine(imageInput: boolean | undefined): string {
  if (imageInput === true) return "takes image input, as its harness reports"
  if (imageInput === false) return "takes no image input, as its harness reports"
  return "image input not known"
}

// The design shows three chips and a dashed "+N more" after them. A pasted
// file is drawn as its own card, not as a chip. The prompt editor draws the
// same chips, so the draft looks the same in both.
export const visibleAttachmentChips = 3

// The preview variant chosen with Build on this. It rides every send of the
// session (Q342 A), so it is drawn first among the chips, as the design draws
// what the preview sends, and its remove is Unpick.
export type BuildBasisChip = {
  mark: string
  name: string
  meta: string
  onUnpick: () => void
}

export function AttachmentChips({
  attachments,
  machineName,
  onRemove,
  pastedAsChips = false,
  imagesBlocked = false,
  buildBasis,
}: {
  attachments: readonly SessionAttachment[]
  machineName: string
  // The index into attachments.
  onRemove: (index: number) => void
  // The editor has no pasted-file card, so a pasted file is a chip there.
  pastedAsChips?: boolean
  // The session's model reported it takes no image input.
  imagesBlocked?: boolean
  buildBasis?: BuildBasisChip | undefined
}) {
  const [expanded, setExpanded] = useState(false)
  const basisItems: ChipItem[] = buildBasis ? [{
    key: "build-basis",
    mark: buildBasis.mark,
    name: buildBasis.name,
    meta: buildBasis.meta,
    blocked: false,
    removeLabel: `${PreviewVariantCopy.unpick} ${buildBasis.name}`,
    onRemove: buildBasis.onUnpick,
  }] : []
  const items: ChipItem[] = [...basisItems, ...attachments.flatMap((attachment, index) => {
    if (!pastedAsChips && pastedText(attachment)) return []
    const name = attachmentName(attachment)
    const blocked = imagesBlocked && isImageAttachment(attachment)
    return [{
      key: `${name}-${index}`,
      mark: attachmentMark(attachment),
      name,
      meta: blocked ? "no image input" : attachmentMeta(attachment, machineName),
      blocked,
      removeLabel: `Remove ${name}`,
      onRemove: () => onRemove(index),
    }]
  })]
  // An emptied draft (a send, the last removal) starts the next one collapsed.
  if (expanded && items.length === 0) setExpanded(false)
  if (items.length === 0) return null
  const hidden = expanded ? 0 : Math.max(0, items.length - visibleAttachmentChips)
  return (
    <div role="region" aria-label="Attachments" className="flex min-w-0 items-center gap-[7px]">
      <ul className={cn("m-0 flex min-w-0 list-none items-center gap-[7px] p-0", expanded ? "flex-wrap" : "overflow-hidden")}>
        {items.slice(0, items.length - hidden).map((item) => (
          <li
            key={item.key}
            className={cn(
              "flex min-w-0 max-w-[300px] items-center gap-[7px] rounded-full border px-2.5 py-[5px]",
              item.blocked ? "border-danger-border bg-danger-background" : "bg-background",
            )}
          >
            <span className="rounded bg-muted px-[5px] py-0.5 font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">{item.mark}</span>
            <span className="min-w-0 truncate font-machine text-[10.5px] text-strong">{item.name}</span>
            {/* The meta gives way first, so a long one never hides the name. */}
            <span className={cn("min-w-0 truncate text-[10.5px]", item.blocked ? "shrink-0 text-danger-dim" : "shrink-[100] text-faint")}>{item.meta}</span>
            <Button variant="ghost" size="icon-sm" className="size-5 flex-none text-faint" aria-label={item.removeLabel} onClick={item.onRemove}><XIcon className="size-3" /></Button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          className="flex-none rounded-full border border-dashed px-2.5 py-[5px] text-[10.5px] whitespace-nowrap text-muted-foreground"
        >
          {`+${hidden} more`}
        </button>
      ) : null}
    </div>
  )
}

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
  freshProject,
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
  imageInput,
  buildBasis,
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
  // Set while nothing has run in the session: the field asks for the first
  // message in this project, as the design's fresh worktree does.
  freshProject?: string | undefined
  machineName: string
  prompt: string
  onPromptChange: (prompt: string) => void
  attachments: SessionAttachment[]
  // Applies an update at once, not at the next render (Thread's setter), so
  // an add knows whether the draft took it.
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
  // ProviderModel.imageInput of the session's model, as its harness reports.
  // Undefined is not known (not read yet, or not reported), which is not no:
  // only false locks images.
  imageInput: boolean | undefined
  // The chosen preview variant, drawn as the first chip (task 83).
  buildBasis?: BuildBasisChip | undefined
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
  const onThisComputer = useWorkspaceConnection()?.onThisComputer === true
  // Bumped by Change model in the images notice, to open the model menu.
  const [modelMenuRequest, setModelMenuRequest] = useState(0)
  const imageCount = attachments.filter(isImageAttachment).length
  const blockedImages = imageInput === false ? imageCount : 0
  const modelId = runtime.model

  // A file or clipboard read awaits before it adds, so the draft may have
  // grown or shrunk since this render. The limit is checked only against the
  // draft as it is then. The thread applies an update at once, so the refusal
  // is known here; a setter that defers it only skips the message. Says
  // whether the attachments went in.
  const addAttachments = (next: SessionAttachment[], refusal = `Attach up to ${desktopAttachmentLimit} items per message.`) => {
    let refused = false
    onAttachmentsChange((current) => {
      refused = current.length + next.length > desktopAttachmentLimit
      return refused ? current : [...current, ...next]
    })
    setAttachmentError(refused ? refusal : "")
    return !refused
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
  // A paste past the inline limit goes with the message as a file instead of
  // filling the field. When it cannot be a file, because the draft is full or
  // the text is past the attachment limit, it stays in the field as before
  // and the composer says why. The note describes the last paste, so a paste
  // without one clears what an earlier paste left.
  const pasteAsFile = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget
    const text = event.clipboardData.getData("text/plain")
    const kept = field.value.length - (field.selectionEnd - field.selectionStart)
    // Judged against the draft as it is now, for room and for the file's
    // name: a write since this render (a removal, another paste, Attach this
    // output) counts. The thread applies the update at once, so the outcome
    // is known here.
    let outcome: PasteOutcome = pasteOutcome(text, attachments, kept)
    onAttachmentsChange((current) => {
      outcome = pasteOutcome(text, current, kept)
      return outcome.kind === "file" ? [...current, outcome.attachment] : current
    })
    if (outcome.kind === "inline") {
      setAttachmentError(outcome.note ?? "")
      return
    }
    setAttachmentError("")
    event.preventDefault()
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
      // Offline the design dims the whole card to .5 and nothing in it is
      // live. The card carries the dimming, so a control that is off is not
      // dimmed a second time.
      !connected && "opacity-50 [&_button:disabled]:opacity-100",
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
              disabled={readOnly || !connected}
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
            <Button variant="ghost" size="sm" disabled={readOnly || !connected || turnRunning || pending || emergencyStopPending || providerRestartRequired || (imageInput === false && Boolean(queued.attachments?.some(isImageAttachment)))} onClick={() => onQueuedChange({ ...queued, state: "waiting" })}>Send</Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" aria-label="Unqueue the message" className="size-6 flex-none text-faint" disabled={readOnly} onClick={() => onQueuedChange(undefined)}><XIcon className="size-3" /></Button>
        </div>
      ) : null}
      <AttachmentChips
        attachments={attachments}
        machineName={machineName}
        imagesBlocked={imageInput === false}
        buildBasis={buildBasis}
        onRemove={(index) => onAttachmentsChange((current) => current.filter((_, candidate) => candidate !== index))}
      />
      {/* J42: the model's harness reports no image input, so the daemon
          would refuse the message. Send stays off until the images go or
          the model changes. Offline the card says nothing live. */}
      {blockedImages > 0 && connected ? (
        <div role="group" aria-label="Images this model cannot take" className="flex items-start gap-2.5 rounded-[calc(var(--radius)-2px)] border border-danger-border bg-danger-background px-[11px] py-[9px]">
          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" />
          <span className="min-w-0 flex-1 text-[12px] leading-[1.5] text-danger-foreground">
            {lockedImagesWords(blockedImages).lead}
            <span className="font-machine text-[11px]">{modelId}</span>
            {lockedImagesWords(blockedImages).tail}
          </span>
          <span className="flex flex-none items-center gap-1.5">
            <button type="button" disabled={readOnly} className={lockedNoticeAction} onClick={() => onAttachmentsChange((current) => current.filter((attachment) => !isImageAttachment(attachment)))}>
              {blockedImages === 1 ? "Remove image" : `Remove ${blockedImages} images`}
            </button>
            <button type="button" disabled={readOnly || runtimePending} className={lockedNoticeAction} onClick={() => setModelMenuRequest((count) => count + 1)}>Change model</button>
          </span>
        </div>
      ) : null}
      {/* Not knowing is not no: the send goes, and the line says what
          happens if the model turns out to take none. The phone's words. */}
      {imageInput === undefined && imageCount > 0 && connected ? (
        <p className="m-0 text-[11px] text-muted-foreground">{`Domovoi does not know whether ${modelId} takes image input. If it does not, the machine refuses the send and nothing is sent.`}</p>
      ) : null}
      {attachments.some((attachment) => !pastedText(attachment) && Boolean(inlineTextPreview(attachment))) ? (
        <p className="m-0 text-[10.5px] leading-[1.45] text-warning">Too long to send inline. The prompt carries the first 40 lines, the agent reads the rest on request.</p>
      ) : null}
      {attachments.map((attachment, index) => {
        const pasted = pastedText(attachment)
        return pasted ? (
          <PastedTextCard
            key={`${pasted.name}-${index}`}
            attachment={pasted}
            onRemove={() => onAttachmentsChange((current) => current.filter((_, candidate) => candidate !== index))}
          />
        ) : null
      })}
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
      {/* The daemon refuses a message with no words, so a file alone leaves
          Send off. Say what is missing rather than leave it unexplained. */}
      {attachments.length > 0 && !prompt.trim() && !readOnly ? (
        <p className="m-0 text-[11px] text-muted-foreground">
          {attachments.length === 1 ? "Add a message to send the file" : "Add a message to send the files"}
        </p>
      ) : null}
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
        disabled={readOnly || !connected}
        // v2 draws the field with no box of its own: it sits straight on
        // the card. The dark variant on the shared Textarea has to be
        // turned off by name, or it paints a panel the design never draws.
        // Its md:text-sm is overridden the same way, at the same breakpoint,
        // or the field renders at 14px on every desktop width. Offline the
        // card carries the .5, so the field draws neither the shared
        // disabled panel nor a second dimming.
        className={slashOpen
          ? "sr-only"
          : cn(
            "max-h-[172px] min-h-[22px] resize-none overflow-y-auto border-0 bg-transparent p-0 text-[13.5px] leading-[1.6] shadow-none [field-sizing:content] placeholder:text-faint focus-visible:ring-0 md:text-[13.5px] dark:bg-transparent",
            !connected && "disabled:bg-transparent disabled:opacity-100 dark:disabled:bg-transparent",
          )}
        placeholder={connected && freshProject
          ? `Say what you want done in ${freshProject}`
          : surface === "web" && connected
            ? "Steer it, or queue the next message"
            : composerPlaceholder({ offline: !connected, working: turnRunning })}
        value={prompt}
        onPaste={pasteAsFile}
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
                    "w-[86px] flex-none font-machine text-[11.5px]",
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
              <Button variant="ghost" size="icon-sm" aria-label="Attach" className="size-7 rounded-full" disabled={readOnly || !connected || attachments.length >= desktopAttachmentLimit}>
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
              {/* Locked, as the design's default draws it, when the model's
                  harness reports no image input. The daemon would refuse an
                  image with this code. */}
              <DropdownMenuItem aria-label="Image or file from this device" disabled={imageInput === false} className="items-start gap-[11px] rounded-none border-t px-[13px] py-[11px] data-disabled:opacity-100" onSelect={() => attachmentInput.current?.click()}>
                <span className={cn("mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground", imageInput === false && "opacity-55")}>PNG</span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-[12.5px]", imageInput === false ? "text-muted-foreground" : "text-foreground")}>Image or file from this device</span>
                  {/* Only the desktop app's own daemon is on this computer;
                      a browser's loopback address may be an SSH forward. */}
                  <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">
                    {onThisComputer
                      ? `It is copied to ${machineName}. That is this computer, so nothing leaves it.`
                      : `The selected file is copied to ${machineName} with the next message.`}
                  </span>
                  {imageInput === false ? (
                    <span className="mt-[7px] flex items-start gap-[7px]">
                      <LockIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[11px] leading-[1.45] text-foreground">Locked for this model.</span>
                        <span className="font-machine text-[10.5px] text-faint">{`refused by ${machineName} · ${modelImageInputRefusalCode}`}</span>
                      </span>
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem aria-label="Paste terminal output" className="items-start gap-[11px] rounded-none border-t px-[13px] py-[11px]" onSelect={() => void attachClipboardOutput()}>
                <span className="mt-px rounded bg-muted px-[5px] py-[3px] font-machine text-[10.5px] tracking-[.04em] text-muted-foreground">LOG</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-foreground">Paste terminal output</span>
                  <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted-foreground">Pasted text, kept as a file in the session rather than inline in the message.</span>
                </span>
              </DropdownMenuItem>
              {/* The design's footer names the model the message goes to and
                  whether it takes images. Harness marks are not vendored
                  (Q388 A), so the id stands alone. */}
              <div role="group" aria-label="The model this message goes to" className="flex items-center gap-2 border-t bg-background px-[13px] py-[9px]">
                <span className="font-machine text-[10.5px] text-strong">{modelId}</span>
                <span className="text-[11px] text-muted-foreground">{imageInputLine(imageInput)}</span>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* v2's model chip follows the attachment control and opens the flat,
              searchable list of what every harness here reports. The chips
              are keyed on the connection: losing the daemon remounts them,
              which closes an open menu or confirmation instead of leaving a
              choice live the daemon cannot take, or a dialog whose buttons
              are all off. */}
          <ModelPopover
            key={connected ? "model-online" : "model-offline"}
            runtime={runtime}
            providers={providers}
            machineName={machineName}
            pending={runtimePending || readOnly || !connected}
            turnRunning={turnRunning}
            {...(forkCheckpointId ? { forkCheckpointId } : {})}
            {...(forkBlockedReason ? { forkBlockedReason } : {})}
            onListModels={onListModels}
            onDiscoverRuntime={onDiscoverRuntime}
            onChange={onRuntimeChange}
            onFork={onFork}
            openRequest={modelMenuRequest}
          />
          {/* v2's mode chip sits beside the model, and the effort chip
              after it. */}
          <ModeChip key={connected ? "mode-online" : "mode-offline"} runtime={runtime} pending={runtimePending || readOnly || !connected} onSetRuntime={onRuntimeChange} />
          <EffortChip
            key={connected ? "effort-online" : "effort-offline"}
            runtime={runtime}
            model={effortModel}
            dropped={effortDropped}
            pending={runtimePending || readOnly || !connected}
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
            disabled={readOnly || !connected}
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
          ) : null}<Button size="icon-sm" className="rounded-full" aria-label="Send message" disabled={readOnly || !prompt.trim() || pending || !connected || providerRestartRequired || emergencyStopPending || blockedImages > 0} onClick={onSubmit}><ArrowUpIcon /></Button></div>
      </div>
      {children}
    </div>
  )
}
