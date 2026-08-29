import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStopIcon,
  CodeXmlIcon,
  FileDiffIcon,
  FileTextIcon,
  FolderOpenIcon,
  HistoryIcon,
  LaptopIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  MinusIcon,
  PanelLeftCloseIcon,
  PanelRightCloseIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SquareIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react"

import type {
  ApprovalRequest,
  ApprovalDecision,
  Annotation,
  ArtifactAccess,
  ClientKind,
  PermissionMode,
  ProviderModel,
  ProviderRuntime,
  RpcParams,
  Runtime,
  SessionHistoryCategory,
  SessionHistoryPage,
  SessionSummary,
  SkillSummary,
  ThreadItem,
  WorkspaceSnapshot,
  PreviewBridgePickerMessage,
  PreviewBridgeSelectionMessage,
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
  AlertDialogTrigger,
} from "./components/ui/alert-dialog"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Input } from "./components/ui/input"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./components/ui/field"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable"
import { ScrollArea } from "./components/ui/scroll-area"
import { Separator } from "./components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { Switch } from "./components/ui/switch"
import { Textarea } from "./components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { cn } from "./lib/utils"
import { artifactUrlFor } from "./artifact-url"
import { useWorkspace } from "./use-workspace"
import { DomovoiMark } from "./domovoi-mark"
import { annotationsForActiveSession } from "./annotations"
import { createPreviewBridgeChannel, previewSelectionFor } from "./preview-bridge"
import { latestArtifactForActiveSession } from "./artifacts"
import { SkillBrowser } from "./skill-browser"
import {
  providerHandoffDescription,
  preferredSessionProvider,
  providerCanStartSession,
  providerDisplayName,
  providerStatusLabel,
  reasoningOptionsFor,
  requiresProviderHandoff,
  selectRuntimeModel,
} from "./runtime"
import type { TerminalControls } from "./terminal-pane"
import {
  mergeOlderHistory,
  sessionHistoryCategories,
  sessionHistoryEntryDetail,
  sessionHistoryEntryTitle,
} from "./session-history"

const TerminalPane = lazy(async () => {
  const module = await import("./terminal-pane")
  return { default: module.TerminalPane }
})

export type DesktopWindowBridge = {
  platform: "darwin" | "linux" | "win32"
  getRpcToken(): Promise<string>
  minimize(): void
  maximize(): void
  close(): void
}

export type WorkspaceShellProps = {
  clientKind?: ClientKind
  rpcUrl?: string
  rpcToken?: string
  windowBridge?: DesktopWindowBridge
  onChangeCredential?: () => void
}

const statusClass: Record<SessionSummary["state"], string> = {
  active: "bg-success motion-safe:animate-pulse",
  waiting: "bg-warning",
  idle: "bg-faint",
  done: "bg-faint",
  failed: "bg-destructive",
}

const defaultRuntime: Runtime = {
  provider: "codex",
  model: "default",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
}

function WindowControls({ bridge }: { bridge: DesktopWindowBridge }) {
  if (bridge.platform === "darwin") return <div className="w-[64px]" aria-hidden="true" />

  return (
    <div className="electron-no-drag flex h-full items-stretch">
      <Button variant="ghost" size="icon" aria-label="Minimize" onClick={bridge.minimize}>
        <MinusIcon />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Maximize" onClick={bridge.maximize}>
        <SquareIcon />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Close" onClick={bridge.close}>
        <XIcon />
      </Button>
    </div>
  )
}

export function AppBar({
  snapshot,
  connected,
  bridge,
  onOpenProject,
  onPauseAll,
}: {
  snapshot: WorkspaceSnapshot | null
  connected: boolean
  bridge?: DesktopWindowBridge | undefined
  onOpenProject: () => void
  onPauseAll: () => void
}) {
  const canPause = connected && Boolean(snapshot?.sessions.some((session) => session.activeTurnId))
  return (
    <header className="electron-drag flex h-11 shrink-0 items-center border-b bg-sidebar px-3">
      {bridge?.platform === "darwin" ? <div className="w-[64px]" aria-hidden="true" /> : null}
      <div className="electron-no-drag flex min-w-0 flex-1 items-center gap-2">
        <DomovoiMark reduced className="size-5 text-primary" />
        <span className="text-sm font-semibold tracking-[-0.025em]">Domovoi</span>
        <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
        <Button variant="ghost" size="sm" className="hidden sm:flex" disabled={!snapshot} onClick={onOpenProject}>
          {snapshot?.project?.name ?? "Open project"}
          {snapshot?.project ? (
            <span className="font-machine text-[10px] text-faint">{snapshot.project.branch}</span>
          ) : null}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
        <Badge variant="machine">
          <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-destructive")} />
          <span className="hidden sm:inline">{snapshot?.machine.name ?? "daemon"}</span>
        </Badge>
      </div>
      <div className="electron-no-drag flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Pause all"
          disabled={!canPause}
          onClick={onPauseAll}
        >
          <CircleStopIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Pause all</span>
        </Button>
        {snapshot?.approvals.length ? (
          <Badge variant="warning">{snapshot.approvals.length} approval</Badge>
        ) : null}
      </div>
      {bridge ? <WindowControls bridge={bridge} /> : null}
    </header>
  )
}

function SessionRow({
  session,
  active,
  onActivate,
}: {
  session: SessionSummary
  active: boolean
  onActivate: (sessionId: string) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onActivate(session.id)}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent",
        active && "bg-accent",
      )}
    >
      <span className="flex w-full items-start gap-2">
        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", statusClass[session.state])} />
        <span className="line-clamp-2 text-[12.5px] font-medium leading-[1.35]">{session.title}</span>
      </span>
      <span className="ml-3.5 flex flex-wrap items-center gap-1">
        <Badge variant="machine">{session.runtime.provider}/{session.runtime.model}</Badge>
        <Badge variant="outline" className="font-machine text-[9px] uppercase">
          {session.runtime.permissionMode}
        </Badge>
        {session.runtime.auto ? <Badge variant="warning">Auto</Badge> : null}
        {session.state === "waiting" ? (
          <span className="ml-auto text-[9px] uppercase tracking-wider text-warning">Approval</span>
        ) : null}
      </span>
    </button>
  )
}

function SessionsSidebar({
  snapshot,
  onCollapse,
  onActivate,
  onNewSession,
  onOpenSkills,
}: {
  snapshot: WorkspaceSnapshot
  onCollapse: () => void
  onActivate: (sessionId: string) => void
  onNewSession: () => void
  onOpenSkills: () => void
}) {
  const groups = useMemo(
    () => [
      { label: "Active", states: ["active"] },
      { label: "Waiting", states: ["waiting"] },
      { label: "Idle", states: ["idle", "done", "failed"] },
    ],
    [],
  )

  return (
    <aside className="flex h-full min-w-0 flex-col bg-sidebar">
      <div className="flex h-11 items-center justify-between px-3">
        <span className="text-[9px] uppercase tracking-[0.15em] text-faint">Sessions</span>
        <Button variant="ghost" size="icon-xs" aria-label="Collapse sessions" onClick={onCollapse}>
          <PanelLeftCloseIcon />
        </Button>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <Button variant="outline" className="w-full justify-start" onClick={onNewSession}>
          {snapshot.project ? "New session" : "Open project"}
        </Button>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-faint" />
          <Input className="pl-8 font-machine text-[10px]" placeholder="Search sessions, files, skills" />
        </div>
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-2">
          {groups.map((group) => {
            const sessions = snapshot.sessions.filter((session) =>
              group.states.includes(session.state),
            )
            return (
              <section key={group.label} className="flex flex-col gap-1">
                <div className="flex h-7 items-center gap-2 px-2 text-[9px] uppercase tracking-[0.13em] text-faint">
                  <ChevronDownIcon className="size-3" />
                  {group.label}
                  <span className="font-machine">{sessions.length}</span>
                </div>
                {sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === snapshot.activeSessionId}
                    onActivate={onActivate}
                  />
                ))}
              </section>
            )
          })}
        </div>
      </ScrollArea>
      <Separator />
      <div className="flex h-12 items-center gap-2 px-3">
        <span className="flex size-6 items-center justify-center rounded-full bg-accent text-[10px] font-medium">DF</span>
        <span className="min-w-0 flex-1"><span className="block text-[11px] font-medium">phetzy</span><span className="block font-machine text-[9px] text-faint">1 machine · local</span></span>
        <LaptopIcon className="size-3.5 text-muted-foreground" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Open skills settings" onClick={onOpenSkills}>
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Skills</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  )
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest
  onResolve: (
    decision: ApprovalDecision,
    explanation?: string,
  ) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [explainOpen, setExplainOpen] = useState(false)
  const [explanation, setExplanation] = useState("")
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "end" })
  }, [approval.id])

  const facts = [
    ["Machine", approval.machine],
    ["Agent", approval.agent],
    ["Mode", approval.mode],
    ["Directory", approval.directory],
    ["Affects", approval.affects],
    ["Network", approval.network],
    ["Est. duration", approval.estimatedDuration],
  ]

  return (
    <Alert ref={cardRef} variant="warning" className="mx-auto max-w-3xl gap-3 p-4">
      <CircleStopIcon />
      <AlertTitle className="flex items-center gap-2 text-[12.5px]">
        Approval required
        {approval.risk === "hard-gate" ? <Badge variant="warning">Hard gate</Badge> : null}
      </AlertTitle>
      <AlertDescription className="col-span-full flex flex-col gap-3">
        <p className="text-[13px] font-medium text-warn-foreground">{approval.operation}</p>
        <code className="rounded-md bg-warn-deep px-3 py-2 font-machine text-[11px] text-warn-foreground">
          {approval.command}
        </code>
        <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          {facts.map(([label, value]) => (
            <div className="contents" key={label}>
              <dt className="text-warn-dim">{label}</dt>
              <dd className="m-0 min-w-0 break-words font-machine text-warn-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {explainOpen ? (
          <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-background/40 p-3">
            <label htmlFor={`denial-${approval.id}`} className="text-[11px] font-medium text-warn-foreground">
              Tell the agent why this command was denied
            </label>
            <Input
              id={`denial-${approval.id}`}
              autoFocus
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && explanation.trim()) {
                  onResolve("deny-explain", explanation.trim())
                }
              }}
              placeholder="Explain what should change before retrying"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setExplainOpen(false)}>Cancel</Button>
              <Button
                variant="warning"
                size="sm"
                disabled={!explanation.trim()}
                onClick={() => onResolve("deny-explain", explanation.trim())}
              >
                Deny with explanation
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setExplainOpen(true)}>Deny and explain</Button>
          <Button variant="ghost" size="sm" onClick={() => onResolve("deny")}>Deny</Button>
          <Button variant="outline" size="sm" onClick={() => onResolve("always-project")}>Always in this project</Button>
          <Button variant="warning" size="sm" onClick={() => onResolve("allow-once")}>Allow once</Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

type LauncherMode = "project" | "session" | null

export function ProviderReadinessList({
  providers,
}: {
  providers: readonly ProviderRuntime[]
}) {
  if (providers.length === 0) {
    return <FieldDescription>Provider readiness has not been reported by this machine yet.</FieldDescription>
  }

  return (
    <div role="list" aria-label="Provider readiness" className="divide-y rounded-lg border bg-background/40">
      {providers.map((provider) => {
        const status = providerStatusLabel(provider)
        const variant = provider.status === "ready"
          ? "success"
          : provider.status === "auth-required"
            ? "warning"
            : "outline"
        return (
          <div key={provider.id} role="listitem" className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-foreground">{providerDisplayName(provider.id)}</span>
              <span className="truncate font-machine text-[9px] text-faint">
                {provider.command}{provider.version ? ` · ${provider.version}` : ""}
                {!provider.sessionCapable && provider.status !== "missing" ? " · adapter unavailable" : ""}
              </span>
            </span>
            <Badge variant={variant}>{status}</Badge>
          </div>
        )
      })}
    </div>
  )
}

function LauncherDialog({
  mode,
  providers,
  onOpenChange,
  onOpenProject,
  onCreateSession,
  onListModels,
}: {
  mode: LauncherMode
  providers: readonly ProviderRuntime[]
  onOpenChange: (open: boolean) => void
  onOpenProject: (path: string) => Promise<void>
  onCreateSession: (title: string, runtime: Runtime) => Promise<void>
  onListModels: (provider: string) => Promise<ProviderModel[]>
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [runtime, setRuntime] = useState(defaultRuntime)
  const [models, setModels] = useState<ProviderModel[]>([])
  const [modelsPending, setModelsPending] = useState(false)
  const [modelsError, setModelsError] = useState("")
  const modelRequest = useRef(0)
  const providerReadinessKey = providers
    .map((provider) => `${provider.id}:${provider.status}:${provider.version ?? ""}:${provider.sessionCapable}`)
    .join("|")

  useEffect(() => {
    if (mode) {
      setValue("")
      setError("")
    }
    if (mode !== "session") {
      modelRequest.current += 1
      return
    }

    const provider = preferredSessionProvider(providers)
    if (!provider) {
      setModels([])
      setModelsError("No provider on this machine can start a session")
      return
    }

    const request = ++modelRequest.current
    setRuntime({ ...defaultRuntime, provider: provider.id })
    setModels([])
    setModelsPending(true)
    setModelsError("")
    void onListModels(provider.id).then(
      (nextModels) => {
        if (request !== modelRequest.current) return
        setModels(nextModels)
        const selected = nextModels.find((model) => model.isDefault) ?? nextModels[0]
        if (selected) setRuntime((current) => selectRuntimeModel(current, selected))
        else setModelsError(`${providerDisplayName(provider.id)} did not report any models`)
      },
      (cause: unknown) => {
        if (request === modelRequest.current) {
          setModelsError(cause instanceof Error ? cause.message : "Models could not be loaded")
        }
      },
    ).finally(() => {
      if (request === modelRequest.current) setModelsPending(false)
    })
  }, [mode, onListModels, providerReadinessKey])

  const selectProvider = (provider: ProviderRuntime) => {
    if (!providerCanStartSession(provider)) return
    const request = ++modelRequest.current
    setRuntime((current) => ({ ...current, provider: provider.id, model: "default" }))
    setModels([])
    setModelsPending(true)
    setModelsError("")
    void onListModels(provider.id).then(
      (nextModels) => {
        if (request !== modelRequest.current) return
        setModels(nextModels)
        const selected = nextModels.find((model) => model.isDefault) ?? nextModels[0]
        if (selected) setRuntime((current) => selectRuntimeModel(current, selected))
        else setModelsError(`${providerDisplayName(provider.id)} did not report any models`)
      },
      (cause: unknown) => {
        if (request === modelRequest.current) {
          setModelsError(cause instanceof Error ? cause.message : "Models could not be loaded")
        }
      },
    ).finally(() => {
      if (request === modelRequest.current) setModelsPending(false)
    })
  }

  const isProject = mode === "project"
  const selectedProvider = providers.find((provider) => provider.id === runtime.provider)
  const selectedModel = models.find((model) =>
    model.provider === runtime.provider && model.id === runtime.model,
  )
  const runtimeReady = Boolean(selectedProvider && providerCanStartSession(selectedProvider) && selectedModel)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    if (!input || !mode || pending) return
    setPending(true)
    setError("")
    try {
      if (isProject) await onOpenProject(input)
      else await onCreateSession(input, runtime)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Domovoi could not complete the request")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open && pending) return
        onOpenChange(open)
      }}
    >
      <DialogContent className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", !isProject && "sm:max-w-lg")}>
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{isProject ? "Open a project" : "Start a session"}</DialogTitle>
            <DialogDescription>
              {isProject
                ? "Choose a local Git repository. Code stays on this machine."
                : "Domovoi creates an isolated worktree before the first agent turn."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="launcher-value">
                {isProject ? "Repository path" : "Session goal"}
              </FieldLabel>
              <Input
                id="launcher-value"
                autoFocus
                aria-invalid={Boolean(error)}
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={isProject ? "/home/you/projects/example" : "Describe what this session should accomplish"}
              />
              <FieldDescription>
                {isProject ? "The daemon validates the repository before opening it." : "Runtime and permission controls remain editable in the session."}
              </FieldDescription>
              <FieldError>{error}</FieldError>
            </Field>
            {!isProject ? (
              <Field>
                <FieldLabel>Provider and model</FieldLabel>
                <div className="grid gap-2 sm:grid-cols-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className="justify-between"
                        aria-label="Execution provider"
                        disabled={pending}
                      >
                        <span className="truncate">
                          {selectedProvider ? providerDisplayName(selectedProvider.id) : "No provider available"}
                        </span>
                        <ChevronDownIcon data-icon="inline-end" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-72">
                      <DropdownMenuLabel>Execution provider</DropdownMenuLabel>
                      <DropdownMenuGroup>
                        {providers.map((provider) => (
                          <DropdownMenuItem
                            key={provider.id}
                            disabled={pending || !providerCanStartSession(provider)}
                            onSelect={() => selectProvider(provider)}
                          >
                            {provider.id === runtime.provider ? <CheckIcon /> : null}
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span>{providerDisplayName(provider.id)}</span>
                              <span className="truncate font-machine text-[9px] text-faint">
                                {providerStatusLabel(provider)}{provider.version ? ` · ${provider.version}` : ""}
                                {!provider.sessionCapable && provider.status !== "missing" ? " · adapter unavailable" : ""}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className="justify-between"
                        aria-label="Model"
                        aria-describedby={modelsError ? "launcher-model-error" : undefined}
                        aria-invalid={Boolean(modelsError)}
                        disabled={pending || modelsPending || models.length === 0}
                      >
                        <span className="truncate">{modelsPending ? "Loading models" : selectedModel?.displayName ?? "Select model"}</span>
                        <ChevronDownIcon data-icon="inline-end" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-72">
                      <DropdownMenuLabel>{providerDisplayName(runtime.provider)} models</DropdownMenuLabel>
                      <DropdownMenuGroup>
                        {models.map((model) => (
                          <DropdownMenuItem key={model.id} onSelect={() => setRuntime((current) => selectRuntimeModel(current, model))}>
                            {model.id === runtime.model ? <CheckIcon /> : null}
                            <span className="flex min-w-0 flex-col">
                              <span>{model.displayName}</span>
                              <span className="truncate font-machine text-[9px] text-faint">{model.id}</span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <FieldError id="launcher-model-error">{modelsError}</FieldError>
                <ProviderReadinessList providers={providers} />
              </Field>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!value.trim() || pending || (!isProject && !runtimeReady)}>
              {isProject ? <FolderOpenIcon data-icon="inline-start" /> : <BotIcon data-icon="inline-start" />}
              {pending ? "Working" : isProject ? "Open project" : "Create session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CheckpointThreadItem({
  item,
  disabled,
  onRestore,
}: {
  item: Extract<ThreadItem, { kind: "checkpoint" }>
  disabled: boolean
  onRestore: (checkpointId: string) => void
}) {
  return (
    <div className="flex items-center gap-1 self-center rounded-full border bg-card py-1 pr-1 pl-3 font-machine text-[9px] text-faint">
      <span>Checkpoint · {item.label}</span>
      {item.commit ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={disabled} className="h-6 rounded-full px-2 text-[9px]">
              Restore worktree
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Restore this checkpoint?</AlertDialogTitle>
              <AlertDialogDescription>
                Domovoi checkpoints the current worktree first, then restores {item.label}. The
                current state remains available as a recovery checkpoint.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onRestore(item.id)}>Restore worktree</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}

export function checkpointBlockedReason(activeTurnId: string | undefined): string | undefined {
  return activeTurnId ? "Stop the active turn before creating a checkpoint" : undefined
}

export function Thread({
  snapshot,
  connected,
  onResolve,
  onSetRuntime,
  onListModels,
  onNewSession,
  onSend,
  onCheckpoint,
  onRestoreCheckpoint,
  onPauseSession,
}: {
  snapshot: WorkspaceSnapshot
  connected: boolean
  onResolve: (
    approvalId: string,
    decision: ApprovalDecision,
    explanation?: string,
  ) => Promise<void>
  onSetRuntime: (runtime: Runtime) => Promise<void>
  onListModels: (provider: string) => Promise<ProviderModel[]>
  onNewSession: () => void
  onSend: (sessionId: string, prompt: string) => Promise<void>
  onCheckpoint: (sessionId: string) => Promise<void>
  onRestoreCheckpoint: (sessionId: string, checkpointId: string) => Promise<void>
  onPauseSession: (sessionId: string) => Promise<void>
}) {
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)
  const approval = active
    ? snapshot.approvals.find((candidate) => candidate.sessionId === active.id)
    : undefined
  const [prompt, setPrompt] = useState("")
  const [pending, setPending] = useState(false)
  const [runtimePending, setRuntimePending] = useState(false)
  const [sendError, setSendError] = useState("")
  const [runtimeError, setRuntimeError] = useState("")

  if (!active) {
    const hasProject = snapshot.project !== null
    return (
      <main className="flex h-full min-w-0 bg-background">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">{hasProject ? <BotIcon /> : <FolderOpenIcon />}</EmptyMedia>
            <EmptyTitle>{hasProject ? "No session is open" : "No project is open"}</EmptyTitle>
            <EmptyDescription>
              {hasProject
                ? "Start a session to create an isolated worktree and talk to an agent."
                : "Open a local Git repository before starting an agent session."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onNewSession}>
              {hasProject ? <BotIcon data-icon="inline-start" /> : <FolderOpenIcon data-icon="inline-start" />}
              {hasProject ? "New session" : "Open project"}
            </Button>
          </EmptyContent>
        </Empty>
      </main>
    )
  }

  const checkpointReason = checkpointBlockedReason(active.activeTurnId)

  const submitPrompt = async () => {
    const nextPrompt = prompt.trim()
    if (!nextPrompt || pending) return
    setPending(true)
    setSendError("")
    try {
      await onSend(active.id, nextPrompt)
      setPrompt("")
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The message could not be sent")
    } finally {
      setPending(false)
    }
  }

  const createCheckpoint = async () => {
    if (pending || checkpointReason) return
    setPending(true)
    setSendError("")
    try {
      await onCheckpoint(active.id)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The checkpoint could not be created")
    } finally {
      setPending(false)
    }
  }

  const restoreCheckpoint = async (checkpointId: string) => {
    if (pending) return
    setPending(true)
    setSendError("")
    try {
      await onRestoreCheckpoint(active.id, checkpointId)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The checkpoint could not be restored")
    } finally {
      setPending(false)
    }
  }

  const pauseSession = async () => {
    if (pending || !active.activeTurnId) return
    setPending(true)
    setSendError("")
    try {
      await onPauseSession(active.id)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The session could not be paused")
    } finally {
      setPending(false)
    }
  }

  const updateRuntime = async (runtime: Runtime) => {
    if (runtimePending) return
    setRuntimePending(true)
    setRuntimeError("")
    try {
      await onSetRuntime(runtime)
    } catch (cause) {
      setRuntimeError(cause instanceof Error ? cause.message : "The runtime could not be updated")
    } finally {
      setRuntimePending(false)
    }
  }

  const resolveCurrentApproval = (
    approvalId: string,
    decision: ApprovalDecision,
    explanation?: string,
  ) => {
    setSendError("")
    void onResolve(approvalId, decision, explanation).catch((cause: unknown) => {
      setSendError(cause instanceof Error ? cause.message : "The approval could not be resolved")
    })
  }

  return (
    <main className="flex h-full min-w-0 flex-col bg-background">
      <div className="flex min-h-[76px] items-center justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0">
          <h1 className="m-0 max-w-xl text-[17px] leading-[1.25] font-semibold tracking-[-0.01em]">
            {active.title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-machine text-[10px] text-faint">
            {active.workspacePath ? <span>{active.workspacePath}</span> : null}
            {active.baseCommit && snapshot.project ? <span>from {snapshot.project.branch} @ {active.baseCommit.slice(0, 8)}</span> : null}
            <span>{active.changedFiles} files</span>
            <span className="text-success">{active.testsPassed} pass</span>
            {active.testsFailed ? <span className="text-destructive">{active.testsFailed} fail</span> : null}
          </div>
        </div>
        <RuntimeControls
          runtime={active.runtime}
          providers={snapshot.machine.providers}
          pending={runtimePending}
          onChange={(runtime) => void updateRuntime(runtime)}
          onListModels={onListModels}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[668px] flex-col gap-5 px-6 py-6">
          {snapshot.thread.filter((item) => item.sessionId === active.id).map((item) => {
            if (item.kind === "checkpoint") {
              return <CheckpointThreadItem key={item.id} item={item} disabled={pending || Boolean(active.activeTurnId)} onRestore={(checkpointId) => void restoreCheckpoint(checkpointId)} />
            }
            if (item.kind === "user") {
              return <div key={item.id} className="max-w-[82%] self-end rounded-xl border bg-card px-4 py-3 text-[13px] leading-relaxed">{item.body}</div>
            }
            if (item.kind === "system") {
              return <Alert key={item.id} className="border-[color-mix(in_oklab,var(--info)_30%,transparent)] bg-[color-mix(in_oklab,var(--info)_9%,transparent)] text-info"><BotIcon /><AlertTitle>{item.body}</AlertTitle><AlertDescription>{item.detail}</AlertDescription></Alert>
            }
            if (item.kind === "receipt") {
              return <Alert key={item.id} className="border-[color-mix(in_oklab,var(--info)_30%,transparent)] bg-[color-mix(in_oklab,var(--info)_9%,transparent)] text-info"><CheckIcon /><AlertTitle>{item.operation}: {item.decision}</AlertTitle><AlertDescription>Checkpoint {item.checkpoint} · decided from {item.client}{item.explanation ? ` · ${item.explanation}` : ""}</AlertDescription></Alert>
            }
            if (item.kind === "tool") {
              return <Alert key={item.id}><TerminalSquareIcon /><AlertTitle>{item.title}</AlertTitle><AlertDescription><Badge variant="outline">{item.status}</Badge>{item.output ? <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-machine text-[10px]">{item.output}</pre> : null}</AlertDescription></Alert>
            }
            return <div key={item.id} className="flex max-w-2xl gap-3 text-[13px] leading-relaxed"><span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border bg-card text-primary"><DomovoiMark reduced className="size-4" /></span><p className="m-0">{item.body}</p></div>
          })}
          {approval ? <ApprovalCard approval={approval} onResolve={(decision, explanation) => resolveCurrentApproval(approval.id, decision, explanation)} /> : null}
        </div>
      </ScrollArea>
      <div className="px-5 py-3 [mask-image:linear-gradient(to_bottom,transparent_0,black_12px)]">
        {runtimeError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[620px]"><CircleStopIcon /><AlertTitle>Runtime update failed</AlertTitle><AlertDescription>{runtimeError}</AlertDescription></Alert> : null}
        {sendError ? <Alert variant="destructive" className="mx-auto mb-2 max-w-[620px]"><CircleStopIcon /><AlertTitle>Agent request failed</AlertTitle><AlertDescription>{sendError}</AlertDescription></Alert> : null}
        <div className="mx-auto flex max-w-[620px] flex-col gap-2 rounded-xl border bg-card p-3">
          <Textarea
            aria-label="Message"
            rows={2}
            className="min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            placeholder="Message the agent"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void submitPrompt()
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="machine">{snapshot.machine.name}</Badge>
              <Button variant="ghost" size="sm" disabled={pending || Boolean(checkpointReason)} title={checkpointReason} onClick={() => void createCheckpoint()}>Checkpoint</Button>
              {checkpointReason ? <span role="status" className="font-machine text-[9px] text-faint">{checkpointReason}</span> : null}
              {active.activeTurnId ? <Button variant="ghost" size="sm" disabled={pending || !connected} onClick={() => void pauseSession()}><CircleStopIcon data-icon="inline-start" />Stop</Button> : null}
            </div>
            <div className="flex items-center gap-2"><span className="font-machine text-[9px] text-faint">⌘ ↵ send</span><Button size="icon-sm" aria-label="Send message" disabled={!prompt.trim() || pending} onClick={() => void submitPrompt()}><SendIcon /></Button></div>
          </div>
        </div>
      </div>
    </main>
  )
}

export function activeThreadKey(snapshot: WorkspaceSnapshot): string {
  return snapshot.activeSessionId ?? "no-active-session"
}

export function RuntimeControls({
  runtime,
  providers,
  pending,
  onChange,
  onListModels,
}: {
  runtime: Runtime
  providers: readonly ProviderRuntime[]
  pending: boolean
  onChange: (runtime: Runtime) => void
  onListModels: (provider: string) => Promise<ProviderModel[]>
}) {
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ProviderModel[]>>({})
  const [modelsPending, setModelsPending] = useState<Record<string, boolean>>({})
  const [modelsError, setModelsError] = useState<Record<string, string>>({})
  const [handoffModel, setHandoffModel] = useState<ProviderModel>()
  const models = modelCatalogs[runtime.provider] ?? []
  const selectedModel = models.find(
    (model) => model.provider === runtime.provider && model.id === runtime.model,
  )
  const reasoningOptions = reasoningOptionsFor(selectedModel)
  const reasoningUnavailable = selectedModel === undefined || reasoningOptions.length === 0
  const availableProviders = providers.filter(providerCanStartSession)

  const loadModels = (provider: string) => {
    if (modelCatalogs[provider] || modelsPending[provider]) return
    setModelsPending((current) => ({ ...current, [provider]: true }))
    setModelsError((current) => ({ ...current, [provider]: "" }))
    void onListModels(provider).then(
      (nextModels) => setModelCatalogs((current) => ({ ...current, [provider]: nextModels })),
      (cause: unknown) => {
        setModelsError((current) => ({
          ...current,
          [provider]: cause instanceof Error ? cause.message : "Models could not be loaded",
        }))
      },
    ).finally(() => setModelsPending((current) => ({ ...current, [provider]: false })))
  }

  useEffect(() => {
    let active = true
    setModelsPending((current) => ({ ...current, [runtime.provider]: true }))
    setModelsError((current) => ({ ...current, [runtime.provider]: "" }))
    void onListModels(runtime.provider).then(
      (nextModels) => {
        if (active) setModelCatalogs((current) => ({ ...current, [runtime.provider]: nextModels }))
      },
      (cause: unknown) => {
        if (active) {
          setModelsError((current) => ({
            ...current,
            [runtime.provider]: cause instanceof Error ? cause.message : "Models could not be loaded",
          }))
        }
      },
    ).finally(() => {
      if (active) setModelsPending((current) => ({ ...current, [runtime.provider]: false }))
    })
    return () => { active = false }
  }, [onListModels, runtime.provider])

  const chooseModel = (model: ProviderModel) => {
    if (requiresProviderHandoff(runtime, model)) {
      setHandoffModel(model)
      return
    }
    onChange(selectRuntimeModel(runtime, model))
  }

  const setMode = (permissionMode: string) => {
    if (permissionMode) onChange({ ...runtime, permissionMode: permissionMode as PermissionMode })
  }
  return (
    <div className="flex max-w-[52%] flex-wrap items-center justify-end gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}><BotIcon data-icon="inline-start" />{runtime.provider} / {runtime.model}<ChevronDownIcon data-icon="inline-end" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Provider and model</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {availableProviders.map((provider) => {
            const providerModels = modelCatalogs[provider.id] ?? []
            return (
              <DropdownMenuSub
                key={provider.id}
                onOpenChange={(open) => { if (open) loadModels(provider.id) }}
              >
                <DropdownMenuSubTrigger disabled={pending}>
                  {provider.id === runtime.provider ? <CheckIcon /> : <BotIcon />}
                  {providerDisplayName(provider.id)}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 w-80 overflow-y-auto">
                  <DropdownMenuLabel>{providerDisplayName(provider.id)} models</DropdownMenuLabel>
                  <DropdownMenuGroup>
                    {modelsPending[provider.id] ? <DropdownMenuItem disabled>Loading installed models</DropdownMenuItem> : null}
                    {modelsError[provider.id] ? <DropdownMenuItem disabled className="whitespace-normal text-destructive">{modelsError[provider.id]}</DropdownMenuItem> : null}
                    {!modelsPending[provider.id] && !modelsError[provider.id] && providerModels.length === 0
                      ? <DropdownMenuItem disabled>No models reported</DropdownMenuItem>
                      : null}
                    {providerModels.map((model) => (
                      <DropdownMenuItem
                        key={`${model.provider}:${model.id}`}
                        disabled={pending}
                        onSelect={() => chooseModel(model)}
                      >
                        {model.id === runtime.model && model.provider === runtime.provider ? <CheckIcon /> : null}
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{model.displayName}</span>
                          <span className="truncate font-machine text-[9px] text-faint">{model.id}</span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })}
          {availableProviders.length === 0 ? <DropdownMenuItem disabled>No session providers are ready</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={pending || reasoningUnavailable}>Think: {runtime.reasoning}<ChevronDownIcon data-icon="inline-end" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>{reasoningOptions.map((reasoning) => <DropdownMenuItem key={reasoning} disabled={pending} onSelect={() => onChange({ ...runtime, reasoning })}>{reasoning === runtime.reasoning ? <CheckIcon /> : null}{reasoning}</DropdownMenuItem>)}</DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToggleGroup type="single" value={runtime.permissionMode} disabled={pending} onValueChange={setMode} variant="outline" size="sm" spacing={0} aria-label="Permission mode">
        <ToggleGroupItem value="ask">Ask</ToggleGroupItem><ToggleGroupItem value="plan">Plan</ToggleGroupItem><ToggleGroupItem value="build">Build</ToggleGroupItem>
      </ToggleGroup>
      <label className="flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] text-muted-foreground"><Switch size="sm" checked={runtime.auto} disabled={pending} onCheckedChange={(auto) => onChange({ ...runtime, auto })} />Auto</label>
      <AlertDialog open={handoffModel !== undefined} onOpenChange={(open) => { if (!open) setHandoffModel(undefined) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch provider here?</AlertDialogTitle>
            <AlertDialogDescription>
              {handoffModel
                ? providerHandoffDescription(
                    providerDisplayName(handoffModel.provider),
                    handoffModel.displayName,
                  )
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                if (handoffModel) onChange(selectRuntimeModel(runtime, handoffModel))
              }}
            >
              Switch here
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function HistoryPanel({
  sessionId,
  connected,
  onLoad,
}: {
  sessionId: string | null
  connected: boolean
  onLoad: (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
  ) => Promise<SessionHistoryPage>
}) {
  const [categories, setCategories] = useState<SessionHistoryCategory[]>(() =>
    sessionHistoryCategories.map(({ value }) => value)
  )
  const [query, setQuery] = useState("")
  const [page, setPage] = useState<SessionHistoryPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const requestRef = useRef(0)
  const filterKey = `${categories.join(",")}:${query.trim()}`

  useEffect(() => {
    const request = ++requestRef.current
    setPage(undefined)
    setError("")
    if (!sessionId || !connected) {
      setLoading(false)
      return
    }
    setLoading(true)
    void onLoad(sessionId, {
      categories,
      ...(query.trim() ? { query: query.trim() } : {}),
      limit: 50,
    }).then(
      (next) => { if (request === requestRef.current) setPage(next) },
      (cause: unknown) => {
        if (request === requestRef.current) {
          setError(cause instanceof Error ? cause.message : "Session history could not be loaded")
        }
      },
    ).finally(() => {
      if (request === requestRef.current) setLoading(false)
    })
    return () => { requestRef.current += 1 }
  }, [connected, filterKey, onLoad, sessionId])

  const toggleCategory = (category: SessionHistoryCategory) => {
    if (categories.includes(category) && categories.length === 1) return
    setPage(undefined)
    setCategories((current) => current.includes(category)
      ? current.length === 1 ? current : current.filter((value) => value !== category)
      : sessionHistoryCategories.map(({ value }) => value).filter(
        (value) => value === category || current.includes(value),
      ))
  }

  const loadOlder = async () => {
    if (!sessionId || !page?.hasMore || !page.nextCursor || loading) return
    const request = ++requestRef.current
    setLoading(true)
    setError("")
    try {
      const older = await onLoad(sessionId, {
        categories,
        ...(query.trim() ? { query: query.trim() } : {}),
        before: page.nextCursor,
        limit: 50,
      })
      if (request === requestRef.current) setPage((current) =>
        current ? mergeOlderHistory(current, older) : older
      )
    } catch (cause) {
      if (request === requestRef.current) {
        setError(cause instanceof Error ? cause.message : "Older history could not be loaded")
      }
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-faint" />
          <Input
            aria-label="Search session history"
            className="pl-8 font-machine text-[10px]"
            placeholder="Search recorded history"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {sessionHistoryCategories.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={categories.includes(value) ? "secondary" : "ghost"}
              aria-pressed={categories.includes(value)}
              onClick={() => toggleCategory(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-3">
          {page?.items.map((entry) => {
            const detail = sessionHistoryEntryDetail(entry)
            return (
              <div key={entry.id} className="flex gap-3 border-b py-3 last:border-b-0">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 break-words text-[12px] font-medium">{sessionHistoryEntryTitle(entry)}</span>
                    <span className="font-machine text-[9px] text-faint">{entry.createdAt.slice(11, 16)}</span>
                  </div>
                  <Badge variant="outline" className="mt-1 font-machine text-[8px]">{entry.category}</Badge>
                  {detail ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-machine text-[10px] leading-relaxed text-muted-foreground">{detail}</pre> : null}
                </div>
              </div>
            )
          })}
          {!loading && !error && page?.items.length === 0 ? (
            <Empty className="min-h-48 border-0"><EmptyHeader><EmptyMedia variant="icon"><HistoryIcon /></EmptyMedia><EmptyTitle>No matching history</EmptyTitle><EmptyDescription>Change filters or search terms.</EmptyDescription></EmptyHeader></Empty>
          ) : null}
          {error ? <Alert variant="destructive" className="my-3"><CircleStopIcon /><AlertTitle>History unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
          {page?.hasMore ? <Button className="my-3 self-center" variant="outline" size="sm" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading" : "Load older"}</Button> : null}
          {loading && !page ? <p role="status" className="p-4 text-center font-machine text-[10px] text-faint">Loading history</p> : null}
        </div>
      </ScrollArea>
    </div>
  )
}

function ArtifactDock({
  snapshot,
  onCollapse,
  defaultTab,
  rpcUrl,
  authorizeArtifact,
  connected,
  terminalControls,
  onReplyToAnnotation,
  onSetAnnotationStatus,
  onCreateAnnotation,
  onLoadSessionHistory,
}: {
  snapshot: WorkspaceSnapshot
  onCollapse: () => void
  defaultTab: "changes" | "preview"
  rpcUrl: string
  authorizeArtifact: (artifactId: string, bridgeChannel?: string) => Promise<ArtifactAccess>
  connected: boolean
  terminalControls: TerminalControls
  onReplyToAnnotation: (annotationId: string, body: string) => Promise<void>
  onSetAnnotationStatus: (annotationId: string, status: Annotation["status"]) => Promise<void>
  onCreateAnnotation: (input: {
    sessionId: string
    artifactId: string
    anchor: Annotation["anchor"]
    body: string
  }) => Promise<void>
  onLoadSessionHistory: (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
  ) => Promise<SessionHistoryPage>
}) {
  const plan = latestArtifactForActiveSession(snapshot, "plan")
  const previewCandidate = latestArtifactForActiveSession(snapshot, "preview")
  const preview = previewCandidate?.path && previewCandidate.mimeType === "text/html"
    ? previewCandidate
    : undefined
  const diff = latestArtifactForActiveSession(snapshot, "diff")
  const annotations = annotationsForActiveSession(snapshot)
  const openAnnotations = annotations.filter((annotation) => annotation.status === "open")
  const previewFrameRef = useRef<HTMLIFrameElement>(null)
  const [bridgeState, setBridgeState] = useState(() => ({
    previewId: preview?.id,
    channel: createPreviewBridgeChannel(),
  }))
  let bridgeChannel = bridgeState.channel
  if (bridgeState.previewId !== preview?.id) {
    const nextBridgeState = { previewId: preview?.id, channel: createPreviewBridgeChannel() }
    bridgeChannel = nextBridgeState.channel
    setBridgeState(nextBridgeState)
  }
  const [pickerActive, setPickerActive] = useState(false)
  const [selection, setSelection] = useState<PreviewBridgeSelectionMessage | null>(null)
  const [comment, setComment] = useState("")
  const [annotationPending, setAnnotationPending] = useState(false)
  const [annotationError, setAnnotationError] = useState("")
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [previewError, setPreviewError] = useState("")
  const [activeTab, setActiveTab] = useState<string>(defaultTab)

  useEffect(() => {
    let active = true
    setPreviewUrl(undefined)
    setPreviewError("")
    if (!preview || !connected) return () => { active = false }
    void authorizeArtifact(preview.id, bridgeChannel).then(
      (access) => {
        if (active) setPreviewUrl(artifactUrlFor(rpcUrl, access, window.location.origin))
      },
      (cause: unknown) => {
        if (!active) return
        setPreviewUrl(undefined)
        setPreviewError(
          cause instanceof Error ? cause.message : "Preview access could not be authorized",
        )
      },
    )
    return () => { active = false }
  }, [authorizeArtifact, bridgeChannel, connected, preview?.id, preview?.revision, rpcUrl])

  const postPickerState = (active: boolean) => {
    const message: PreviewBridgePickerMessage = {
      type: "domovoi.preview.picker",
      channel: bridgeChannel,
      active,
    }
    previewFrameRef.current?.contentWindow?.postMessage(message, "*")
  }

  useEffect(() => {
    const receiveSelection = (event: MessageEvent<unknown>) => {
      if (
        !pickerActive
        || !preview
        || event.source !== previewFrameRef.current?.contentWindow
        || event.origin !== "null"
      ) return
      const nextSelection = previewSelectionFor(event.data, bridgeChannel, preview.id)
      if (!nextSelection) return
      postPickerState(false)
      setPickerActive(false)
      setSelection(nextSelection)
      setComment("")
      setAnnotationError("")
    }
    window.addEventListener("message", receiveSelection)
    return () => window.removeEventListener("message", receiveSelection)
  }, [bridgeChannel, pickerActive, preview?.id])

  useEffect(() => {
    setPickerActive(false)
    setSelection(null)
    setComment("")
    setAnnotationError("")
  }, [preview?.id])

  const togglePicker = () => {
    const active = !pickerActive
    setPickerActive(active)
    setAnnotationError("")
    postPickerState(active)
  }

  const saveAnnotation = async () => {
    const body = comment.trim()
    const sessionId = snapshot.activeSessionId
    if (!body || !selection || !sessionId || annotationPending) return
    setAnnotationPending(true)
    setAnnotationError("")
    try {
      await onCreateAnnotation({
        sessionId,
        artifactId: selection.artifactId,
        anchor: selection.anchor,
        body,
      })
      setSelection(null)
      setComment("")
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The annotation could not be saved")
    } finally {
      setAnnotationPending(false)
    }
  }

  return (
    <aside className="flex h-full min-w-0 flex-col bg-sidebar">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full gap-0">
        <div className="flex h-11 items-center border-b px-2">
          <TabsList variant="line" className="min-w-0 flex-1 justify-start overflow-x-auto">
            <TabsTrigger value="plan"><FileTextIcon />Plan</TabsTrigger>
            <TabsTrigger value="changes"><FileDiffIcon />Changes</TabsTrigger>
            <TabsTrigger value="preview"><CodeXmlIcon />Preview</TabsTrigger>
            <TabsTrigger value="comments">
              <MessageSquareTextIcon />Comments
              {openAnnotations.length ? <Badge variant="outline" className="h-4 px-1 text-[8px]">{openAnnotations.length}</Badge> : null}
            </TabsTrigger>
            <TabsTrigger value="terminal"><TerminalSquareIcon />Terminal</TabsTrigger>
            <TabsTrigger value="history"><HistoryIcon />History</TabsTrigger>
            <TabsTrigger value="session"><BotIcon />Session</TabsTrigger>
          </TabsList>
          <Button variant="ghost" size="icon-xs" aria-label="Collapse dock" onClick={onCollapse}><PanelRightCloseIcon /></Button>
        </div>
        <TabsContent value="preview" className="min-h-0 overflow-auto p-3">
          {preview ? (
            <div className="flex min-h-full flex-col overflow-hidden rounded-xl border bg-background shadow-[var(--shadow-md)]">
              <div className="flex h-10 items-center justify-between border-b px-3">
                <div><p className="m-0 text-[11px] font-medium">{preview.title}</p><p className="m-0 font-machine text-[9px] text-faint">revision {preview.revision} · sandboxed</p></div>
                <div className="flex items-center gap-2">
                  <Button
                    variant={pickerActive ? "secondary" : "outline"}
                    size="xs"
                    aria-pressed={pickerActive}
                    onClick={togglePicker}
                  >
                    <MessageSquarePlusIcon />
                    {pickerActive ? "Select element" : "Annotate"}
                  </Button>
                  <Badge variant="success">Live</Badge>
                </div>
              </div>
              {previewError ? (
                <Alert variant="destructive" className="m-3 w-auto" aria-live="polite">
                  <CircleStopIcon />
                  <AlertTitle>Preview unavailable</AlertTitle>
                  <AlertDescription>{previewError}</AlertDescription>
                </Alert>
              ) : (
                <iframe
                  ref={previewFrameRef}
                  className="min-h-0 flex-1 border-0 bg-background"
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts"
                  src={previewUrl ?? "about:blank"}
                  title={preview.title}
                  onLoad={() => postPickerState(pickerActive)}
                />
              )}
            </div>
          ) : (
            <Empty className="min-h-full border">
              <EmptyHeader><EmptyMedia variant="icon"><CodeXmlIcon /></EmptyMedia><EmptyTitle>No preview yet</EmptyTitle><EmptyDescription>HTML artifacts created by the agent appear here.</EmptyDescription></EmptyHeader>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="plan" className="min-h-0">
          {plan?.content ? (
            <ScrollArea className="h-full">
              <article className="p-4">
                <div className="mb-4 border-b pb-3">
                  <h2 className="m-0 text-[13px] font-semibold">{plan.title}</h2>
                  <p className="mt-1 font-machine text-[9px] text-faint">revision {plan.revision}</p>
                </div>
                <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-muted-foreground">
                  {plan.content}
                </pre>
              </article>
            </ScrollArea>
          ) : (
            <Empty className="min-h-full border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                <EmptyTitle>No plan content yet</EmptyTitle>
                <EmptyDescription>Plan updates from the active agent appear here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="changes" className="min-h-0 overflow-auto p-4 font-machine text-[11px] text-muted-foreground">
          {diff?.content ? <pre className="whitespace-pre-wrap">{diff.content}</pre> : "No working changes yet."}
        </TabsContent>
        <TabsContent value="comments" className="min-h-0">
          <AnnotationComments
            annotations={annotations}
            onReply={onReplyToAnnotation}
            onSetStatus={onSetAnnotationStatus}
          />
        </TabsContent>
        <TabsContent value="terminal" className="min-h-0 bg-code">
          <Suspense fallback={(
            <Empty className="min-h-full border-0 text-muted-foreground">
              <EmptyHeader>
                <EmptyMedia variant="icon"><TerminalSquareIcon /></EmptyMedia>
                <EmptyTitle>Loading terminal</EmptyTitle>
                <EmptyDescription>Preparing the interactive terminal renderer.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}>
            <TerminalPane
              connected={connected}
              controls={terminalControls}
              machineName={snapshot.machine.name}
              sessionId={snapshot.activeSessionId}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="history" className="min-h-0">
          <HistoryPanel
            sessionId={snapshot.activeSessionId}
            connected={connected}
            onLoad={onLoadSessionHistory}
          />
        </TabsContent>
        <TabsContent value="session" className="p-4 font-machine text-[11px] text-muted-foreground">{snapshot.machine.name}<br />{snapshot.project?.path ?? "No project open"}</TabsContent>
      </Tabs>
      <Dialog
        open={selection !== null}
        onOpenChange={(open) => {
          if (open || annotationPending) return
          setSelection(null)
          setComment("")
          setAnnotationError("")
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annotate preview</DialogTitle>
            <DialogDescription className="break-words">
              {selection?.label ?? "Selected preview element"}
            </DialogDescription>
          </DialogHeader>
          {annotationError ? (
            <Alert variant="destructive" aria-live="polite">
              <CircleStopIcon />
              <AlertTitle>Annotation failed</AlertTitle>
              <AlertDescription>{annotationError}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="preview-annotation">Comment</FieldLabel>
              <Textarea
                id="preview-annotation"
                value={comment}
                rows={4}
                autoFocus
                disabled={annotationPending}
                placeholder="Describe what should change or what needs review"
                onChange={(event) => setComment(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={annotationPending}
              onClick={() => setSelection(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!comment.trim() || annotationPending}
              onClick={() => void saveAnnotation()}
            >
              {annotationPending ? "Saving annotation" : "Save annotation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

function AnnotationComments({
  annotations,
  onReply,
  onSetStatus,
}: {
  annotations: Annotation[]
  onReply: (annotationId: string, body: string) => Promise<void>
  onSetStatus: (annotationId: string, status: Annotation["status"]) => Promise<void>
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState("")

  const submitReply = async (annotationId: string) => {
    const body = reply.trim()
    if (!body || pendingId) return
    setPendingId(annotationId)
    setError("")
    try {
      await onReply(annotationId, body)
      setReply("")
      setReplyingTo(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The annotation reply could not be saved")
    } finally {
      setPendingId(null)
    }
  }

  const setStatus = async (annotation: Annotation) => {
    if (pendingId) return
    setPendingId(annotation.id)
    setError("")
    try {
      await onSetStatus(annotation.id, annotation.status === "open" ? "resolved" : "open")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The annotation status could not be changed")
    } finally {
      setPendingId(null)
    }
  }

  return (
    <ScrollArea className="h-full">
      {annotations.length ? (
        <div className="flex flex-col gap-3 p-3">
          {error ? (
            <Alert variant="destructive" aria-live="polite">
              <CircleStopIcon />
              <AlertTitle>Annotation update failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {annotations.map((annotation) => {
            const pending = pendingId === annotation.id
            const isReplying = replyingTo === annotation.id
            return (
              <Card key={annotation.id} size="sm">
                <CardHeader>
                  <CardTitle className="min-w-0 break-words text-[12px] leading-relaxed">{annotation.body}</CardTitle>
                  <CardDescription className="font-machine text-[9px]">
                    {annotation.origin} · {annotation.variantId ?? annotation.artifactId}
                    {annotation.statusChangedBy ? ` · ${annotation.status} by ${annotation.statusChangedBy}` : ""}
                  </CardDescription>
                  <CardAction>
                    <Badge variant={annotation.status === "open" ? "warning" : "success"}>{annotation.status}</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <div className="break-words rounded-md border bg-code px-2.5 py-2 font-machine text-[9px] leading-relaxed text-muted-foreground">
                    {annotation.anchor.textQuote
                      ? `“${annotation.anchor.textQuote}”`
                      : annotation.anchor.cssSelector ?? "Visual selection"}
                  </div>
                  {annotation.thread.map((threadReply) => (
                    <div key={threadReply.id} className="break-words border-l border-border pl-2 text-[11px] leading-relaxed text-muted-foreground">
                      <span className="font-machine text-[9px] text-faint">{threadReply.origin}</span><br />
                      {threadReply.body}
                    </div>
                  ))}
                </CardContent>
                <CardFooter className="flex-col items-stretch gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={pendingId !== null || (replyingTo !== null && !isReplying)}
                      onClick={() => {
                        setError("")
                        setReply("")
                        setReplyingTo(isReplying ? null : annotation.id)
                      }}
                    >
                      {isReplying ? "Cancel reply" : "Reply"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pendingId !== null}
                      onClick={() => void setStatus(annotation)}
                    >
                      {pending ? "Saving" : annotation.status === "open" ? "Resolve" : "Reopen"}
                    </Button>
                  </div>
                  {isReplying ? (
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor={`annotation-reply-${annotation.id}`}>Reply</FieldLabel>
                        <Textarea
                          id={`annotation-reply-${annotation.id}`}
                          value={reply}
                          rows={3}
                          disabled={pending}
                          placeholder="Add context for the next agent round"
                          onChange={(event) => setReply(event.target.value)}
                        />
                      </Field>
                      <Button
                        size="sm"
                        disabled={!reply.trim() || pending}
                        onClick={() => void submitReply(annotation.id)}
                      >
                        {pending ? "Saving reply" : "Save reply"}
                      </Button>
                    </FieldGroup>
                  ) : null}
                </CardFooter>
              </Card>
            )
          })}
        </div>
      ) : (
        <Empty className="min-h-full border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><MessageSquareTextIcon /></EmptyMedia>
            <EmptyTitle>No annotations yet</EmptyTitle>
            <EmptyDescription>Comments anchored to plans and previews appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </ScrollArea>
  )
}

function SidebarRail({
  snapshot,
  onActivate,
  onExpand,
  onOpenSkills,
}: {
  snapshot: WorkspaceSnapshot
  onActivate: (sessionId: string) => void
  onExpand: () => void
  onOpenSkills: () => void
}) {
  return (
    <aside className="flex w-[46px] shrink-0 flex-col items-center gap-2 border-r bg-sidebar py-2">
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Expand sessions" onClick={onExpand}><PanelLeftCloseIcon className="rotate-180" /></Button></TooltipTrigger><TooltipContent side="right">Expand sessions</TooltipContent></Tooltip>
      <Separator />
      {snapshot.sessions.map((session) => <Tooltip key={session.id}><TooltipTrigger asChild><button type="button" aria-label={session.title} aria-pressed={session.id === snapshot.activeSessionId} onClick={() => onActivate(session.id)} className={cn("flex size-7 items-center justify-center rounded-md hover:bg-accent", session.id === snapshot.activeSessionId && "bg-accent")}><span className={cn("size-2 rounded-full", statusClass[session.state])} /></button></TooltipTrigger><TooltipContent side="right">{session.title}</TooltipContent></Tooltip>)}
      <span className="flex-1" />
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Open skills settings" onClick={onOpenSkills}><SettingsIcon /></Button></TooltipTrigger><TooltipContent side="right">Skills</TooltipContent></Tooltip>
    </aside>
  )
}

function DockRail({ onExpand }: { onExpand: () => void }) {
  const items = [FileDiffIcon, CodeXmlIcon, MessageSquareTextIcon, TerminalSquareIcon, HistoryIcon]
  return (
    <aside className="flex w-[46px] shrink-0 flex-col items-center gap-2 border-l bg-sidebar py-2">
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Expand artifact dock" onClick={onExpand}><PanelRightCloseIcon className="rotate-180" /></Button></TooltipTrigger><TooltipContent side="left">Expand artifact dock</TooltipContent></Tooltip>
      <Separator />
      {items.map((Icon, index) => <Button key={index} variant="ghost" size="icon-sm" aria-label="Artifact dock item" onClick={onExpand}><Icon /></Button>)}
    </aside>
  )
}

export function WorkspaceShell({ clientKind = "web", rpcUrl = "ws://127.0.0.1:47831/rpc", rpcToken, windowBridge, onChangeCredential }: WorkspaceShellProps) {
  const {
    activateSession,
    authorizeArtifact,
    claimTerminal,
    closeTerminal,
    connected,
    createCheckpoint,
    createAnnotation,
    createSession,
    createTerminal,
    listModels,
    listSkills,
    loadSessionHistory,
    openProject,
    pauseAll,
    pauseSession,
    readSkill,
    reconnect,
    restoreCheckpoint,
    resizeTerminal,
    resolveApproval,
    replyToAnnotation,
    sendMessage,
    setRuntime,
    setAnnotationStatus,
    snapshot,
    subscribeTerminal,
    terminalClientId,
    writeTerminal,
  } = useWorkspace(rpcUrl, clientKind, rpcToken)
  const terminalControls = useMemo<TerminalControls>(() => ({
    clientId: terminalClientId,
    create: createTerminal,
    claim: claimTerminal,
    write: writeTerminal,
    resize: resizeTerminal,
    close: closeTerminal,
    subscribe: subscribeTerminal,
  }), [claimTerminal, closeTerminal, createTerminal, resizeTerminal, subscribeTerminal, terminalClientId, writeTerminal])
  const shellRef = useRef<HTMLDivElement>(null)
  const [launcherMode, setLauncherMode] = useState<LauncherMode>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("domovoi.sidebar-collapsed") === "true")
  const [dockCollapsed, setDockCollapsed] = useState(() => localStorage.getItem("domovoi.dock-collapsed") === "true")
  const [workspaceError, setWorkspaceError] = useState("")
  const [connectionError, setConnectionError] = useState("")
  const [surface, setSurface] = useState<"workspace" | "skills">("workspace")
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState("")
  const [skillsRefresh, setSkillsRefresh] = useState(0)
  const activateVisibleSession = (sessionId: string) => {
    setWorkspaceError("")
    void activateSession(sessionId).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "The session could not be opened")
    })
  }
  const reconnectDaemon = () => {
    setConnectionError("")
    void reconnect().catch((cause: unknown) => {
      setConnectionError(cause instanceof Error ? cause.message : "The daemon could not be reached")
    })
  }
  const pauseActiveTurns = () => {
    setWorkspaceError("")
    void pauseAll().catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "Active agents could not be paused")
    })
  }
  const layoutKey = `domovoi.layout.${sidebarCollapsed ? "rail" : "sidebar"}.${dockCollapsed ? "rail" : "dock"}`
  const defaultLayout = useMemo(() => {
    const saved = localStorage.getItem(layoutKey)
    if (!saved) return undefined
    try {
      return JSON.parse(saved) as Record<string, number>
    } catch {
      return undefined
    }
  }, [layoutKey])

  useEffect(() => {
    localStorage.setItem("domovoi.sidebar-collapsed", String(sidebarCollapsed))
  }, [sidebarCollapsed])

  useEffect(() => {
    localStorage.setItem("domovoi.dock-collapsed", String(dockCollapsed))
  }, [dockCollapsed])

  useEffect(() => {
    if (connected) setConnectionError("")
  }, [connected])

  useEffect(() => {
    if (surface !== "skills") return
    if (!connected) {
      setSkillsLoading(false)
      setSkillsError("Reconnect to the execution machine to refresh its skill directories.")
      return
    }
    let active = true
    setSkillsLoading(true)
    setSkillsError("")
    void listSkills().then(
      (discovered) => {
        if (active) setSkills(discovered)
      },
      (cause: unknown) => {
        if (active) setSkillsError(cause instanceof Error ? cause.message : "Skill discovery failed")
      },
    ).finally(() => {
      if (active) setSkillsLoading(false)
    })
    return () => { active = false }
  }, [connected, listSkills, skillsRefresh, surface])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? shell.clientWidth
      if (width < 1080) setDockCollapsed(true)
      if (width < 850) setSidebarCollapsed(true)
    })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  return (
    <TooltipProvider>
      <div ref={shellRef} className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <AppBar snapshot={snapshot} connected={connected} bridge={windowBridge} onOpenProject={() => setLauncherMode("project")} onPauseAll={pauseActiveTurns} />
        {!connected ? (
          <div role="status" className="flex shrink-0 items-center gap-3 border-b border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-2.5 text-[12.5px] text-[var(--danger-fg)]">
            <span className="size-2 shrink-0 rounded-full bg-destructive" />
            <span>{connectionError ? `Reconnect failed: ${connectionError}` : snapshot ? `Lost the daemon on ${snapshot.machine.name}. Existing session state remains on that machine.` : "Cannot reach the daemon. Workspace state is waiting for a verified response."}</span>
            <span className="ml-auto font-machine text-[10px] text-[var(--danger-dim)]">retrying</span>
            {onChangeCredential ? <Button variant="outline" size="sm" onClick={onChangeCredential}>Change credential</Button> : null}
            <Button variant="destructive" size="sm" onClick={reconnectDaemon}>Reconnect now</Button>
          </div>
        ) : null}
        {snapshot && surface === "skills" ? (
          <SkillBrowser
            skills={skills}
            loading={skillsLoading}
            error={skillsError}
            onBack={() => setSurface("workspace")}
            onReadSkill={readSkill}
            onRetry={() => setSkillsRefresh((current) => current + 1)}
          />
        ) : snapshot ? (
          <div className="flex min-h-0 flex-1">
            {sidebarCollapsed ? <SidebarRail snapshot={snapshot} onActivate={activateVisibleSession} onExpand={() => setSidebarCollapsed(false)} onOpenSkills={() => setSurface("skills")} /> : null}
            <ResizablePanelGroup
              key={layoutKey}
              orientation="horizontal"
              className="min-h-0 min-w-0 flex-1"
              {...(defaultLayout ? { defaultLayout } : {})}
              onLayoutChanged={(layout, meta) => {
                if (meta.isUserInteraction) localStorage.setItem(layoutKey, JSON.stringify(layout))
              }}
            >
              {!sidebarCollapsed ? <><ResizablePanel id="sessions" defaultSize="20" minSize="14" maxSize="28"><SessionsSidebar snapshot={snapshot} onCollapse={() => setSidebarCollapsed(true)} onActivate={activateVisibleSession} onNewSession={() => setLauncherMode(snapshot.project ? "session" : "project")} onOpenSkills={() => setSurface("skills")} /></ResizablePanel><ResizableHandle /></> : null}
              <ResizablePanel id="thread" defaultSize={sidebarCollapsed && dockCollapsed ? "100" : "48"} minSize="34"><Thread key={activeThreadKey(snapshot)} snapshot={snapshot} connected={connected} onResolve={resolveApproval} onSetRuntime={(runtime) => snapshot.activeSessionId ? setRuntime(snapshot.activeSessionId, runtime) : Promise.reject(new Error("No session is active"))} onListModels={listModels} onNewSession={() => setLauncherMode(snapshot.project ? "session" : "project")} onSend={sendMessage} onCheckpoint={createCheckpoint} onRestoreCheckpoint={restoreCheckpoint} onPauseSession={pauseSession} /></ResizablePanel>
              {!dockCollapsed ? <><ResizableHandle /><ResizablePanel id="dock" defaultSize="32" minSize="24" maxSize="46"><ArtifactDock snapshot={snapshot} onCollapse={() => setDockCollapsed(true)} defaultTab={clientKind === "desktop" ? "changes" : "preview"} rpcUrl={rpcUrl} authorizeArtifact={authorizeArtifact} connected={connected} terminalControls={terminalControls} onCreateAnnotation={createAnnotation} onLoadSessionHistory={loadSessionHistory} onReplyToAnnotation={replyToAnnotation} onSetAnnotationStatus={setAnnotationStatus} /></ResizablePanel></> : null}
            </ResizablePanelGroup>
            {dockCollapsed ? <DockRail onExpand={() => setDockCollapsed(false)} /> : null}
          </div>
        ) : (
          <main className="flex min-h-0 flex-1 bg-background">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><DomovoiMark reduced className="size-5" /></EmptyMedia>
                <EmptyTitle>Connecting to the daemon</EmptyTitle>
                <EmptyDescription>Domovoi will show workspace state after the execution machine responds.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </main>
        )}
        {workspaceError ? (
          <Alert
            variant="destructive"
            className="absolute bottom-3 left-3 z-50 w-auto max-w-sm shadow-[var(--shadow-md)]"
          >
            <CircleStopIcon />
            <AlertTitle>Workspace action failed</AlertTitle>
            <AlertDescription>{workspaceError}</AlertDescription>
          </Alert>
        ) : null}
        {snapshot ? <LauncherDialog
          mode={launcherMode}
          providers={snapshot.machine.providers}
          onOpenChange={(open) => { if (!open) setLauncherMode(null) }}
          onOpenProject={openProject}
          onCreateSession={createSession}
          onListModels={listModels}
        /> : null}
      </div>
    </TooltipProvider>
  )
}
