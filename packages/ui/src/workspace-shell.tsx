import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStopIcon,
  CodeXmlIcon,
  FileDiffIcon,
  FileTextIcon,
  FolderOpenIcon,
  LaptopIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  MinusIcon,
  PanelLeftCloseIcon,
  PanelRightCloseIcon,
  SearchIcon,
  SendIcon,
  SquareIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react"

import type {
  ApprovalRequest,
  ApprovalDecision,
  Annotation,
  ClientKind,
  PermissionMode,
  Runtime,
  SessionSummary,
  WorkspaceSnapshot,
  PreviewBridgePickerMessage,
  PreviewBridgeSelectionMessage,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
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
import { previewSelectionFor } from "./preview-bridge"
import { commandsForActiveSession, type CommandTranscript } from "./commands"

export type DesktopWindowBridge = {
  platform: "darwin" | "linux" | "win32"
  minimize(): void
  maximize(): void
  close(): void
}

export type WorkspaceShellProps = {
  clientKind?: ClientKind
  rpcUrl?: string
  windowBridge?: DesktopWindowBridge
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
  model: "gpt-5.6-sol",
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

function AppBar({
  snapshot,
  connected,
  bridge,
  onOpenProject,
}: {
  snapshot: WorkspaceSnapshot
  connected: boolean
  bridge?: DesktopWindowBridge | undefined
  onOpenProject: () => void
}) {
  return (
    <header className="electron-drag flex h-11 shrink-0 items-center border-b bg-sidebar px-3">
      {bridge?.platform === "darwin" ? <div className="w-[64px]" aria-hidden="true" /> : null}
      <div className="electron-no-drag flex min-w-0 flex-1 items-center gap-2">
        <DomovoiMark reduced className="size-5 text-primary" />
        <span className="text-sm font-semibold tracking-[-0.025em]">Domovoi</span>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Button variant="ghost" size="sm" onClick={onOpenProject}>
          {snapshot.project?.name ?? "Open project"}
          {snapshot.project ? (
            <span className="font-machine text-[10px] text-faint">{snapshot.project.branch}</span>
          ) : null}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
        <Badge variant="machine">
          <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-destructive")} />
          {snapshot.machine.name}
        </Badge>
      </div>
      <div className="electron-no-drag flex items-center gap-2">
        <Button variant="ghost" size="sm">
          <CircleStopIcon data-icon="inline-start" />
          Pause all
        </Button>
        {snapshot.approvals.length ? (
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
}: {
  snapshot: WorkspaceSnapshot
  onCollapse: () => void
  onActivate: (sessionId: string) => void
  onNewSession: () => void
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

function LauncherDialog({
  mode,
  onOpenChange,
  onOpenProject,
  onCreateSession,
}: {
  mode: LauncherMode
  onOpenChange: (open: boolean) => void
  onOpenProject: (path: string) => Promise<void>
  onCreateSession: (title: string, runtime: Runtime) => Promise<void>
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (mode) {
      setValue("")
      setError("")
    }
  }, [mode])

  const isProject = mode === "project"
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    if (!input || !mode || pending) return
    setPending(true)
    setError("")
    try {
      if (isProject) await onOpenProject(input)
      else await onCreateSession(input, defaultRuntime)
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
      <DialogContent>
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
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!value.trim() || pending}>
              {isProject ? <FolderOpenIcon data-icon="inline-start" /> : <BotIcon data-icon="inline-start" />}
              {pending ? "Working" : isProject ? "Open project" : "Create session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Thread({
  snapshot,
  onResolve,
  onSetRuntime,
  onNewSession,
  onSend,
  onCheckpoint,
}: {
  snapshot: WorkspaceSnapshot
  onResolve: (
    approvalId: string,
    decision: ApprovalDecision,
    explanation?: string,
  ) => Promise<void>
  onSetRuntime: (runtime: Runtime) => Promise<void>
  onNewSession: () => void
  onSend: (sessionId: string, prompt: string) => Promise<void>
  onCheckpoint: (sessionId: string) => Promise<void>
}) {
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)
  const approval = active
    ? snapshot.approvals.find((candidate) => candidate.sessionId === active.id)
    : undefined
  const [prompt, setPrompt] = useState("")
  const [pending, setPending] = useState(false)
  const [sendError, setSendError] = useState("")

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
    if (pending) return
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

  const updateRuntime = (runtime: Runtime) => {
    setSendError("")
    void onSetRuntime(runtime).catch((cause: unknown) => {
      setSendError(cause instanceof Error ? cause.message : "The runtime could not be updated")
    })
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
        <RuntimeControls runtime={active.runtime} onChange={updateRuntime} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[668px] flex-col gap-5 px-6 py-6">
          {snapshot.thread.filter((item) => item.sessionId === active.id).map((item) => {
            if (item.kind === "checkpoint") {
              return <div key={item.id} className="self-center rounded-full border bg-card px-3 py-1 font-machine text-[9px] text-faint">Checkpoint · {item.label}</div>
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
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => void createCheckpoint()}>Checkpoint</Button>
            </div>
            <div className="flex items-center gap-2"><span className="font-machine text-[9px] text-faint">⌘ ↵ send</span><Button size="icon-sm" aria-label="Send message" disabled={!prompt.trim() || pending} onClick={() => void submitPrompt()}><SendIcon /></Button></div>
          </div>
        </div>
      </div>
    </main>
  )
}

function RuntimeControls({ runtime, onChange }: { runtime: Runtime; onChange: (runtime: Runtime) => void }) {
  const setMode = (permissionMode: string) => {
    if (permissionMode) onChange({ ...runtime, permissionMode: permissionMode as PermissionMode })
  }
  return (
    <div className="flex max-w-[52%] flex-wrap items-center justify-end gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm"><BotIcon data-icon="inline-start" />{runtime.provider} / {runtime.model}<ChevronDownIcon data-icon="inline-end" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Provider and model</DropdownMenuLabel>
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => onChange({ ...runtime, provider: "codex", model: "gpt-5.6-sol" })}><CheckIcon />Codex CLI · gpt-5.6-sol</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" size="sm">Think: {runtime.reasoning}<ChevronDownIcon data-icon="inline-end" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>{(["low", "medium", "high"] as const).map((reasoning) => <DropdownMenuItem key={reasoning} onSelect={() => onChange({ ...runtime, reasoning })}>{reasoning === runtime.reasoning ? <CheckIcon /> : null}{reasoning}</DropdownMenuItem>)}</DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToggleGroup type="single" value={runtime.permissionMode} onValueChange={setMode} variant="outline" size="sm" spacing={0} aria-label="Permission mode">
        <ToggleGroupItem value="ask">Ask</ToggleGroupItem><ToggleGroupItem value="plan">Plan</ToggleGroupItem><ToggleGroupItem value="build">Build</ToggleGroupItem>
      </ToggleGroup>
      <label className="flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] text-muted-foreground"><Switch size="sm" checked={runtime.auto} onCheckedChange={(auto) => onChange({ ...runtime, auto })} />Auto</label>
    </div>
  )
}

function ArtifactDock({
  snapshot,
  onCollapse,
  defaultTab,
  rpcUrl,
  onReplyToAnnotation,
  onSetAnnotationStatus,
  onCreateAnnotation,
}: {
  snapshot: WorkspaceSnapshot
  onCollapse: () => void
  defaultTab: "changes" | "preview"
  rpcUrl: string
  onReplyToAnnotation: (annotationId: string, body: string) => Promise<void>
  onSetAnnotationStatus: (annotationId: string, status: Annotation["status"]) => Promise<void>
  onCreateAnnotation: (input: {
    sessionId: string
    artifactId: string
    anchor: Annotation["anchor"]
    body: string
  }) => Promise<void>
}) {
  const sessionArtifacts = snapshot.artifacts.filter(
    (artifact) => artifact.sessionId === snapshot.activeSessionId,
  )
  const preview = sessionArtifacts.findLast(
    (artifact) => artifact.type === "preview" && artifact.path && artifact.mimeType === "text/html",
  )
  const diff = sessionArtifacts.findLast((artifact) => artifact.type === "diff")
  const annotations = annotationsForActiveSession(snapshot)
  const commands = commandsForActiveSession(snapshot)
  const openAnnotations = annotations.filter((annotation) => annotation.status === "open")
  const previewFrameRef = useRef<HTMLIFrameElement>(null)
  const bridgeChannel = useMemo(
    () => `preview_${crypto.randomUUID().replaceAll("-", "")}`,
    [preview?.id],
  )
  const [pickerActive, setPickerActive] = useState(false)
  const [selection, setSelection] = useState<PreviewBridgeSelectionMessage | null>(null)
  const [comment, setComment] = useState("")
  const [annotationPending, setAnnotationPending] = useState(false)
  const [annotationError, setAnnotationError] = useState("")

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
      if (!pickerActive || !preview || event.source !== previewFrameRef.current?.contentWindow) return
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
      <Tabs defaultValue={defaultTab} className="h-full gap-0">
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
              <iframe
                ref={previewFrameRef}
                className="min-h-0 flex-1 border-0 bg-background"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts"
                src={artifactUrlFor(rpcUrl, preview.id, bridgeChannel)}
                title={preview.title}
                onLoad={() => postPickerState(pickerActive)}
              />
            </div>
          ) : (
            <Empty className="min-h-full border">
              <EmptyHeader><EmptyMedia variant="icon"><CodeXmlIcon /></EmptyMedia><EmptyTitle>No preview yet</EmptyTitle><EmptyDescription>HTML artifacts created by the agent appear here.</EmptyDescription></EmptyHeader>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="plan" className="p-4 text-muted-foreground">Four steps · one migration · one hard gate.</TabsContent>
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
          <TerminalTranscript commands={commands} />
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

function TerminalTranscript({ commands }: { commands: CommandTranscript[] }) {
  if (!commands.length) {
    return (
      <Empty className="min-h-full border-0 text-muted-foreground">
        <EmptyHeader>
          <EmptyMedia variant="icon"><TerminalSquareIcon /></EmptyMedia>
          <EmptyTitle>No commands yet</EmptyTitle>
          <EmptyDescription>Agent command output appears here as it runs.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="font-machine text-[11px] text-muted-foreground">
        {commands.map((command) => (
          <section key={command.id} className="border-b border-border/70 px-4 py-3 last:border-b-0">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <p className="m-0 min-w-0 break-words text-foreground">
                <span className="mr-2 text-primary">$</span>{command.title}
              </p>
              <Badge
                variant={command.status === "completed"
                  ? "success"
                  : command.status === "failed" || command.status === "declined"
                    ? "destructive"
                    : "warning"}
              >
                {command.status}
              </Badge>
            </div>
            {command.output ? (
              <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed">
                {command.output}
              </pre>
            ) : (
              <p className="mt-2 text-[10px] text-faint">
                {command.status === "running" ? "Waiting for output…" : "No output recorded."}
              </p>
            )}
          </section>
        ))}
      </div>
    </ScrollArea>
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
}: {
  snapshot: WorkspaceSnapshot
  onActivate: (sessionId: string) => void
  onExpand: () => void
}) {
  return (
    <aside className="flex w-[46px] shrink-0 flex-col items-center gap-2 border-r bg-sidebar py-2">
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Expand sessions" onClick={onExpand}><PanelLeftCloseIcon className="rotate-180" /></Button></TooltipTrigger><TooltipContent side="right">Expand sessions</TooltipContent></Tooltip>
      <Separator />
      {snapshot.sessions.map((session) => <Tooltip key={session.id}><TooltipTrigger asChild><button type="button" aria-label={session.title} aria-pressed={session.id === snapshot.activeSessionId} onClick={() => onActivate(session.id)} className={cn("flex size-7 items-center justify-center rounded-md hover:bg-accent", session.id === snapshot.activeSessionId && "bg-accent")}><span className={cn("size-2 rounded-full", statusClass[session.state])} /></button></TooltipTrigger><TooltipContent side="right">{session.title}</TooltipContent></Tooltip>)}
    </aside>
  )
}

function DockRail({ onExpand }: { onExpand: () => void }) {
  const items = [FileDiffIcon, CodeXmlIcon, MessageSquareTextIcon, TerminalSquareIcon]
  return (
    <aside className="flex w-[46px] shrink-0 flex-col items-center gap-2 border-l bg-sidebar py-2">
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Expand artifact dock" onClick={onExpand}><PanelRightCloseIcon className="rotate-180" /></Button></TooltipTrigger><TooltipContent side="left">Expand artifact dock</TooltipContent></Tooltip>
      <Separator />
      {items.map((Icon, index) => <Button key={index} variant="ghost" size="icon-sm" aria-label="Artifact dock item" onClick={onExpand}><Icon /></Button>)}
    </aside>
  )
}

export function WorkspaceShell({ clientKind = "web", rpcUrl = "ws://127.0.0.1:47831/rpc", windowBridge }: WorkspaceShellProps) {
  const {
    activateSession,
    connected,
    createCheckpoint,
    createAnnotation,
    createSession,
    openProject,
    resolveApproval,
    replyToAnnotation,
    sendMessage,
    setRuntime,
    setAnnotationStatus,
    snapshot,
  } = useWorkspace(rpcUrl, clientKind)
  const shellRef = useRef<HTMLDivElement>(null)
  const [launcherMode, setLauncherMode] = useState<LauncherMode>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("domovoi.sidebar-collapsed") === "true")
  const [dockCollapsed, setDockCollapsed] = useState(() => localStorage.getItem("domovoi.dock-collapsed") === "true")
  const [workspaceError, setWorkspaceError] = useState("")
  const activateVisibleSession = (sessionId: string) => {
    setWorkspaceError("")
    void activateSession(sessionId).catch((cause: unknown) => {
      setWorkspaceError(cause instanceof Error ? cause.message : "The session could not be opened")
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
        <AppBar snapshot={snapshot} connected={connected} bridge={windowBridge} onOpenProject={() => setLauncherMode("project")} />
        <div className="flex min-h-0 flex-1">
          {sidebarCollapsed ? <SidebarRail snapshot={snapshot} onActivate={activateVisibleSession} onExpand={() => setSidebarCollapsed(false)} /> : null}
          <ResizablePanelGroup
            key={layoutKey}
            orientation="horizontal"
            className="min-h-0 min-w-0 flex-1"
            {...(defaultLayout ? { defaultLayout } : {})}
            onLayoutChanged={(layout, meta) => {
              if (meta.isUserInteraction) localStorage.setItem(layoutKey, JSON.stringify(layout))
            }}
          >
            {!sidebarCollapsed ? <><ResizablePanel id="sessions" defaultSize="20" minSize="14" maxSize="28"><SessionsSidebar snapshot={snapshot} onCollapse={() => setSidebarCollapsed(true)} onActivate={activateVisibleSession} onNewSession={() => setLauncherMode(snapshot.project ? "session" : "project")} /></ResizablePanel><ResizableHandle /></> : null}
            <ResizablePanel id="thread" defaultSize={sidebarCollapsed && dockCollapsed ? "100" : "48"} minSize="34"><Thread snapshot={snapshot} onResolve={resolveApproval} onSetRuntime={(runtime) => snapshot.activeSessionId ? setRuntime(snapshot.activeSessionId, runtime) : Promise.reject(new Error("No session is active"))} onNewSession={() => setLauncherMode(snapshot.project ? "session" : "project")} onSend={sendMessage} onCheckpoint={createCheckpoint} /></ResizablePanel>
            {!dockCollapsed ? <><ResizableHandle /><ResizablePanel id="dock" defaultSize="32" minSize="24" maxSize="46"><ArtifactDock snapshot={snapshot} onCollapse={() => setDockCollapsed(true)} defaultTab={clientKind === "desktop" ? "changes" : "preview"} rpcUrl={rpcUrl} onCreateAnnotation={createAnnotation} onReplyToAnnotation={replyToAnnotation} onSetAnnotationStatus={setAnnotationStatus} /></ResizablePanel></> : null}
          </ResizablePanelGroup>
          {dockCollapsed ? <DockRail onExpand={() => setDockCollapsed(false)} /> : null}
        </div>
        {!connected ? <div className="absolute bottom-3 left-3 rounded-md border border-destructive bg-popover px-3 py-1.5 font-machine text-[10px] text-destructive shadow-[var(--shadow-md)]">Daemon offline · retrying</div> : null}
        {workspaceError ? (
          <Alert
            variant="destructive"
            className={cn("absolute left-3 z-50 w-auto max-w-sm shadow-[var(--shadow-md)]", connected ? "bottom-3" : "bottom-12")}
          >
            <CircleStopIcon />
            <AlertTitle>Session switch failed</AlertTitle>
            <AlertDescription>{workspaceError}</AlertDescription>
          </Alert>
        ) : null}
        <LauncherDialog
          mode={launcherMode}
          onOpenChange={(open) => { if (!open) setLauncherMode(null) }}
          onOpenProject={openProject}
          onCreateSession={createSession}
        />
      </div>
    </TooltipProvider>
  )
}
