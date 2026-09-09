import type { PermissionMode, Runtime } from "@getdomovoi/protocol"
import { useId, useState, type KeyboardEvent } from "react"

import { Chip } from "./chip"
import { FloatingSurface } from "./floating-surface"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { autoIsOffered, permissionModeLabel, permissionModes, withAuto, withPermissionMode } from "./permission-mode"
import { submitFromComposer } from "./turn-queue"

export type SlashCommand = { name: string; argument?: string; describe: string }

// The v2 composer carries the controls the pre-v2 toolbar spread across the
// window: permission mode, model, and what this turn will do. Slash commands
// act on this turn; the palette is what navigates.
export function SessionComposer({
  runtime,
  turnRunning,
  modelLabel,
  slashCommands,
  onSend,
  onQueue,
  onRemoveQueued,
  onSetRuntime,
  onOpenModelPicker,
}: {
  runtime: Runtime
  turnRunning: boolean
  modelLabel: string
  slashCommands: readonly SlashCommand[]
  onSend: (text: string) => void
  onQueue: (text: string) => void
  onRemoveQueued?: (() => void) | undefined
  onSetRuntime: (runtime: Runtime) => void
  onOpenModelPicker: () => void
}) {
  const [text, setText] = useState("")
  const [queued, setQueued] = useState<string>()
  const [modeOpen, setModeOpen] = useState(false)
  // Dismissed survives until the next keystroke, so Escape and a taken command
  // both close a list the text still qualifies for.
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()

  const matches = text.startsWith("/") && !dismissed
    ? slashCommands.filter((command) => command.name.startsWith(text.split(" ")[0]!))
    : []
  const slashOpen = matches.length > 0
  const optionId = (index: number) => `${listId}-${index}`

  const take = (command: SlashCommand) => {
    setText(`${command.name} `)
    setDismissed(true)
    setActive(-1)
  }

  const onListKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!slashOpen) return false
    if (event.key === "Escape") {
      setDismissed(true)
      setActive(-1)
      return true
    }
    if (event.key === "ArrowDown") {
      setActive((current) => (current + 1) % matches.length)
      return true
    }
    if (event.key === "ArrowUp") {
      setActive((current) => (current <= 0 ? matches.length : current) - 1)
      return true
    }
    if (event.key === "Enter" && !event.shiftKey && active >= 0) {
      take(matches[active]!)
      return true
    }
    return false
  }

  const submit = () => {
    const outcome = submitFromComposer({ text, turnRunning, queued })
    if (outcome.action === "ignore") return
    if (outcome.action === "send") onSend(outcome.text)
    else {
      setQueued(outcome.text)
      onQueue(outcome.text)
    }
    setText("")
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      {queued ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
          <StatusDot meaning="idle" label={queued} size="inline" />
          <span className="ml-auto font-mono text-[10.5px] text-faint">sends at the next turn boundary</span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground"
            // Clearing the banner is not removing the turn. Whoever was told
            // to queue it has to be told it is gone.
            onClick={() => { onRemoveQueued?.(); setQueued(undefined) }}
          >
            Remove
          </button>
        </div>
      ) : null}

      {slashOpen ? (
        <div id={listId} aria-label="Commands for this turn" role="listbox" className="rounded-lg border border-border bg-popover p-1">
          <p className="px-2 py-1 text-[10.5px] tracking-[0.13em] text-faint">THIS TURN</p>
          {matches.map((command, index) => (
            <button
              type="button"
              role="option"
              id={optionId(index)}
              aria-selected={index === active}
              key={command.name}
              onClick={() => take(command)}
              className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
            >
              <span className="font-mono text-[11.5px] text-foreground">{command.name}</span>
              {command.argument ? <span className="font-mono text-[10.5px] text-faint">{command.argument}</span> : null}
              <span className="ml-auto text-[11px] text-muted-foreground">{command.describe}</span>
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        value={text}
        aria-label="Message"
        rows={2}
        role="combobox"
        aria-expanded={slashOpen}
        aria-controls={listId}
        {...(slashOpen && active >= 0 ? { "aria-activedescendant": optionId(active) } : {})}
        onChange={(event) => {
          setText(event.target.value)
          setDismissed(false)
          setActive(-1)
        }}
        onKeyDown={(event) => {
          // The list answers first while it is open, so Enter takes the
          // highlighted command rather than sending the half-typed line.
          if (onListKey(event)) {
            event.preventDefault()
            return
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={turnRunning ? "Send to queue for the next turn" : "Say what you want done"}
        className="resize-none bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-faint"
      />

      <div className="flex items-center gap-2">
        <div className="relative flex">
          <Chip size="chip" onClick={() => setModeOpen(true)}>
            <StatusDot
              meaning={permissionModes.find((mode) => mode.id === runtime.permissionMode)!.meaning as StatusMeaning}
              label={permissionModeLabel(runtime.permissionMode, runtime.auto)}
              size="inline"
            />
          </Chip>
          <FloatingSurface open={modeOpen} onClose={() => setModeOpen(false)} label="Permission mode">
            {permissionModes.map((mode) => (
              <button
                type="button"
                key={mode.id}
                onClick={() => {
                  onSetRuntime(withPermissionMode(runtime, mode.id as PermissionMode))
                  setModeOpen(false)
                }}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <StatusDot meaning={mode.meaning as StatusMeaning} label={mode.label} size="inline" />
                <span className="text-[11px] text-muted-foreground">{mode.note}</span>
              </button>
            ))}
            {autoIsOffered(runtime.permissionMode) ? (
              <label className="mt-1 flex items-center gap-2 border-t border-border px-2 pt-2 text-[11.5px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={runtime.auto}
                  onChange={(event) => onSetRuntime(withAuto(runtime, event.target.checked))}
                />
                Auto, no gate between approved steps
              </label>
            ) : null}
          </FloatingSurface>
        </div>

        <Chip size="chip" mono onClick={onOpenModelPicker}>
          {modelLabel}
        </Chip>

        <span className="ml-auto" />
        <button
          type="button"
          onClick={submit}
          className="rounded-full bg-primary px-3 py-[6px] text-[12.5px] text-primary-foreground"
        >
          {turnRunning ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  )
}
