import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import type { DesktopWindowBridge } from "./desktop-platform.js"
import { parseCommandLinkResult, type CommandLinkResult, type CommandLinkView } from "./printed-command.js"

// Q336 A (2026-10-02): the desktop links Domovoi's own domovoid and domovoi
// into ~/.local/bin, and every command the app prints names what runs: the
// link, or the launcher inside the app by its full path. The desktop renderer
// provides this around the workspace; on the web there is none, and commands
// print as written.

type CommandLinksState = {
  result?: CommandLinkResult | undefined
  error?: string | undefined
  busy: boolean
  act: (action: "link" | "unlink") => void
}

const CommandLinksContext = createContext<CommandLinksState | undefined>(undefined)

export function CommandLinksProvider({ bridge, children }: { bridge: Pick<DesktopWindowBridge, "commandLinks">; children: ReactNode }) {
  const [result, setResult] = useState<CommandLinkResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const ask = useCallback(async (action: "status" | "link" | "unlink") => {
    if (!bridge.commandLinks) return
    setBusy(true)
    try {
      setResult(parseCommandLinkResult(await bridge.commandLinks(action)))
      setError(undefined)
    } catch (cause) {
      setResult(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [bridge])
  useEffect(() => { void ask("status") }, [ask])
  if (!bridge.commandLinks) return <>{children}</>
  return (
    <CommandLinksContext.Provider value={{ result, error, busy, act: (action) => { void ask(action) } }}>
      {children}
    </CommandLinksContext.Provider>
  )
}

// The links as last read, for printedCommand. Undefined where no desktop can
// link, so commands print as written.
export function useCommandLinkView(): CommandLinkView | undefined {
  return useContext(CommandLinksContext)?.result?.report
}

const line = "m-0 text-[11.5px] text-muted-foreground"

// Settings > Daemon on this machine: link the commands or remove the links,
// with the reason when linking is not offered or was refused.
export function CommandLinksRow() {
  const state = useContext(CommandLinksContext)
  if (!state) return null
  const { result, error, busy, act } = state
  const report = result?.report
  const commands = report?.available ? report.commands : []
  const nameList = (list: typeof commands) => list.map((command) => command.name).join(" and ")
  const names = nameList(commands)
  const linkedOnes = commands.filter((command) => command.state === "linked")
  const unlinked = commands.filter((command) => command.state !== "linked")
  const linked = linkedOnes.length > 0 && unlinked.length === 0
  // Review P3-A: Remove the links is offered whenever anything is linked, so
  // a command that is not Domovoi's never strands the link beside it. Link
  // the commands is offered while something can be linked, or nothing is.
  const canUnlink = linkedOnes.length > 0
  const canLink = commands.some((command) => command.state === "absent" || command.state === "stale") || !canUnlink
  const others = report?.available && !result?.refused ? report.commands.filter((command) => command.state === "other") : []
  return (
    <section aria-labelledby="settings-command-links" className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
      <span id="settings-command-links" className="text-[12.5px]">Terminal commands</span>
      {error ? <p role="alert" className="m-0 text-[11.5px] text-destructive">{`Could not read the command links: ${error}`}</p> : null}
      {report && !report.available ? <p className={line}>{report.reason}</p> : null}
      {report?.available && linked ? (
        <p className={line}>{`${names} ${report.commands.length === 1 ? "is" : "are"} linked in ~/.local/bin.${report.onPath ? "" : " That directory is not on this app's PATH, so commands here name the links by their path."}`}</p>
      ) : null}
      {report?.available && canUnlink && !linked ? (
        <p className={line}>{`${nameList(linkedOnes)} ${linkedOnes.length === 1 ? "is" : "are"} linked in ~/.local/bin. Commands here name ${unlinked.length === 1 ? "the copy" : "the copies"} of ${nameList(unlinked)} inside this app by ${unlinked.length === 1 ? "its" : "their"} full path.`}</p>
      ) : null}
      {report?.available && !canUnlink ? (
        <p className={line}>{`Commands here name the copies inside this app by their full path. Linking puts ${names} in ~/.local/bin, for your user only.`}</p>
      ) : null}
      {others.map((command) => (
        <p key={command.name} className={line}>{`~/.local/bin/${command.name} is not a link Domovoi made, so it was left as it is.`}</p>
      ))}
      {result?.refused ? <p role="status" className="m-0 text-[11.5px] text-warning">{result.refused}</p> : null}
      {report?.available ? (
        <div className="flex flex-wrap gap-2">
          {canLink ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act("link")}>Link the commands</Button> : null}
          {canUnlink ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act("unlink")}>Remove the links</Button> : null}
        </div>
      ) : null}
    </section>
  )
}
