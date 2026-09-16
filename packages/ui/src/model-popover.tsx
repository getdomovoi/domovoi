import type { ProviderModel, ProviderRuntime, Runtime, RuntimeDiscoverResult } from "@getdomovoi/protocol"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { FloatingSurface } from "./floating-surface"
import { ProviderChoiceDialog } from "./provider-choice-dialog.js"
import { providerCanStartSession, providerDisplayName, selectRuntimeModel } from "./runtime.js"
import { StatusDot } from "./status-dot"
import { cn } from "./lib/utils"

// The v2 composer's model chip opens one flat list of every model every
// harness on this machine reports, searchable and narrowed by harness, with
// the harness that cannot run here still listed and dimmed with the reason.
// "Ask the agents again" runs discovery, which is the daemon asking each
// harness for its models afresh rather than reading what it reported before.
//
// The design's footer promises a change that lands at the next safe turn
// boundary. The daemon does less: a same-harness model change takes effect
// from the next turn, and a harness change replaces the provider thread and
// is refused while a turn runs ("Stop the active turn before changing
// providers"). The footer states that, and Switch here is held shut for the
// case the daemon would refuse. The deferred harness change is a recorded
// handoff gap, not something this chip pretends to do.

type Catalog =
  | { status: "loading" }
  | { status: "ready", models: ProviderModel[] }
  | { status: "unavailable", note: string }

export function modelCountText(matches: number, total: number, harnesses: number): string {
  return `${matches} of ${total} · ${harnesses} ${harnesses === 1 ? "harness" : "harnesses"}`
}

function unavailableNote(provider: ProviderRuntime, machineName: string): string {
  if (provider.status === "missing") return `${provider.id} is not installed on ${machineName}, so this cannot run here.`
  if (provider.status === "auth-required") return `${provider.id} needs a sign-in on ${machineName} before it can run.`
  return `${provider.id} is not ready to start a session on ${machineName}.`
}

export function ModelPopover({
  runtime,
  providers,
  machineName,
  pending,
  turnRunning = false,
  forkCheckpointId,
  forkBlockedReason,
  onListModels,
  onDiscoverRuntime,
  onChange,
  onFork,
}: {
  runtime: Runtime
  providers: readonly ProviderRuntime[]
  machineName: string
  pending: boolean
  turnRunning?: boolean | undefined
  forkCheckpointId?: string | undefined
  forkBlockedReason?: string | undefined
  onListModels: (provider: string) => Promise<ProviderModel[]>
  onDiscoverRuntime?: ((provider: string) => Promise<RuntimeDiscoverResult>) | undefined
  onChange: (runtime: Runtime) => void
  onFork: (runtime: Runtime, checkpointId: string, requestId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [harness, setHarness] = useState<string>()
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({})
  const [asking, setAsking] = useState(false)
  const [choice, setChoice] = useState<ProviderModel>()
  const trigger = useRef<HTMLButtonElement>(null)
  const generation = useRef(0)
  // The snapshot hands a new providers array on every change. The loader
  // reads the latest through a ref so an open surface does not re-read the
  // catalogs each time something unrelated in the workspace moves.
  const providersRef = useRef(providers)
  providersRef.current = providers

  const listed = providers.filter((provider) => provider.sessionCapable)

  // Each open reads the catalogs afresh; a reply from an earlier open or an
  // earlier "ask again" is dropped rather than overwriting a newer one. A
  // plain open reads only the harnesses the snapshot says can start; asking
  // again probes every harness, because the one that needed a sign-in or an
  // install is the one whose answer may have changed.
  const load = (read: (provider: string) => Promise<Catalog>, every = false) => {
    const current = ++generation.current
    const targets = providersRef.current.filter((provider) => provider.sessionCapable && (every || providerCanStartSession(provider)))
    setCatalogs(Object.fromEntries(targets.map((provider) => [provider.id, { status: "loading" }])))
    return Promise.all(targets.map((provider) => read(provider.id).then(
      (catalog) => { if (generation.current === current) setCatalogs((previous) => ({ ...previous, [provider.id]: catalog })) },
      (cause: unknown) => {
        if (generation.current !== current) return
        const note = cause instanceof Error ? cause.message : "Models could not be loaded"
        setCatalogs((previous) => ({ ...previous, [provider.id]: { status: "unavailable", note } }))
      },
    )))
  }

  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!open) return
    void loadRef.current(async (provider) => ({ status: "ready", models: await onListModels(provider) }))
  }, [open, onListModels])

  const askAgain = () => {
    if (!onDiscoverRuntime || asking) return
    setAsking(true)
    void load(async (provider) => {
      const result = await onDiscoverRuntime(provider)
      return result.status === "ready" ? { status: "ready", models: result.models } : { status: "unavailable", note: result.message }
    }, true).finally(() => setAsking(false))
  }

  type Row =
    | { kind: "model", model: ProviderModel, current: boolean }
    | { kind: "harness", provider: string, note: string }
  // A fresh answer from the harness outranks the snapshot's status: a harness
  // signed in since the snapshot shows its models until the snapshot catches up.
  const rows: Row[] = listed.flatMap((provider): Row[] => {
    const catalog = catalogs[provider.id]
    if (!catalog) {
      return providerCanStartSession(provider) ? [] : [{ kind: "harness", provider: provider.id, note: unavailableNote(provider, machineName) }]
    }
    if (catalog.status === "loading") return []
    if (catalog.status === "unavailable") return [{ kind: "harness", provider: provider.id, note: catalog.note }]
    return catalog.models.map((model) => ({
      kind: "model", model, current: model.provider === runtime.provider && model.id === runtime.model,
    }))
  })
  const total = rows.filter((row) => row.kind === "model").length
  const needle = query.trim().toLowerCase()
  const shown = rows.filter((row) => {
    const provider = row.kind === "model" ? row.model.provider : row.provider
    if (harness && provider !== harness) return false
    if (!needle) return true
    const text = row.kind === "model" ? `${row.model.id} ${row.model.displayName} ${provider}` : provider
    return text.toLowerCase().includes(needle)
  })
  const matches = shown.filter((row) => row.kind === "model").length
  const loading = listed.some((provider) => catalogs[provider.id]?.status === "loading")

  const pick = (model: ProviderModel) => {
    if (model.provider === runtime.provider && model.id === runtime.model) { setOpen(false); return }
    setChoice(model)
  }

  return (
    <div className="relative flex">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-2.5 py-[5px] font-machine text-mono-xs text-strong",
          open ? "border-border bg-accent" : "border-transparent",
        )}
      >
        {runtime.model}
        <ChevronDownIcon className={cn("size-3 text-faint transition-transform", open && "rotate-180")} />
      </button>
      <FloatingSurface
        open={open}
        onClose={() => setOpen(false)}
        label="Models on this machine"
        trigger={trigger}
        className="bottom-[calc(100%+8px)] top-auto w-[330px] p-0"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-faint" />
          <input
            type="search"
            aria-label="Search models on this machine"
            placeholder="Search models on this machine"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent font-machine text-[12px] text-foreground outline-none placeholder:text-faint"
          />
          {query ? <button type="button" className="text-[10.5px] text-muted-foreground" onClick={() => setQuery("")}>clear</button> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
          {listed.map((provider) => (
            <button
              key={provider.id}
              type="button"
              aria-pressed={harness === provider.id}
              onClick={() => setHarness((current) => current === provider.id ? undefined : provider.id)}
              className={cn(
                "rounded-full border px-2 py-0.5 font-machine text-mono-xs",
                harness === provider.id ? "border-primary text-primary" : "border-border text-muted-foreground",
              )}
            >
              {provider.id}
            </button>
          ))}
        </div>
        {!loading && shown.length === 0 ? (
          <p className="m-0 px-3 py-4 text-[12px] leading-relaxed text-muted-foreground">
            Nothing on this machine matches. Models come from what each harness reports, so a name you expect may live under another harness or need a sign-in first.
          </p>
        ) : null}
        <div role="listbox" aria-label="Models" className="max-h-[268px] overflow-y-auto">
          {loading ? <p role="status" className="m-0 px-3 py-2 font-machine text-mono-xs text-faint">Reading what each harness reports</p> : null}
          {shown.map((row) => row.kind === "model" ? (
            <div
              key={`${row.model.provider}:${row.model.id}`}
              role="option"
              aria-label={`${row.model.id}, ${row.model.provider}`}
              aria-selected={row.current}
              tabIndex={0}
              onClick={() => pick(row.model)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(row.model) } }}
              className={cn("flex cursor-pointer items-start gap-2.5 border-t px-3 py-2.5", row.current && "bg-accent")}
            >
              <StatusDot meaning="online" label={`${providerDisplayName(row.model.provider)} reports this model`} size="inline" labelHidden className="mt-1" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-machine text-[12px] text-foreground">{row.model.id}</span>
                  <span className="font-machine text-mono-xs text-faint">{row.model.provider}</span>
                </div>
                {row.model.description ? <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted-foreground">{row.model.description}</p> : null}
              </div>
              <CheckIcon className={cn("size-3.5 self-center", row.current ? "text-primary" : "text-transparent")} />
            </div>
          ) : (
            <div
              key={`harness:${row.provider}`}
              role="option"
              aria-label={row.provider}
              aria-selected={false}
              aria-disabled="true"
              className="flex items-start gap-2.5 border-t px-3 py-2.5 opacity-50"
            >
              <StatusDot meaning="offline" label={`${row.provider} cannot run here`} size="inline" labelHidden className="mt-1" />
              <div className="min-w-0 flex-1">
                <span className="font-machine text-[12px] text-foreground">{row.provider}</span>
                <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted-foreground">{row.note}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="m-0 border-t px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          A model change on the same harness applies from the next turn. A different harness starts a fresh provider thread from the thread, the plan and the worktree, and needs the running turn stopped first.
        </p>
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <span className="font-machine text-mono-xs text-faint">{modelCountText(matches, total, listed.length)}</span>
          <span className="flex-1" />
          {onDiscoverRuntime ? (
            <button type="button" className="text-[11px] text-primary disabled:opacity-50" disabled={asking} onClick={askAgain}>
              {asking ? "Asking" : "Ask the agents again"}
            </button>
          ) : null}
        </div>
      </FloatingSurface>
      <ProviderChoiceDialog
        runtime={runtime}
        model={choice}
        pending={pending}
        {...(turnRunning && choice && choice.provider !== runtime.provider ? { switchBlockedReason: "Stop the active turn before changing harness." } : {})}
        forkCheckpointId={forkCheckpointId}
        forkBlockedReason={forkBlockedReason}
        onClose={() => setChoice(undefined)}
        onSwitch={(model) => { onChange(selectRuntimeModel(runtime, model)); setChoice(undefined); setOpen(false) }}
        onFork={onFork}
      />
    </div>
  )
}
