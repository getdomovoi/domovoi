import { useEffect, useMemo, useRef, useState } from "react"
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStopIcon,
  CodeXmlIcon,
  FileDiffIcon,
  FileTextIcon,
  GitBranchIcon,
  LaptopIcon,
  MessageSquareTextIcon,
  MinusIcon,
  PanelLeftCloseIcon,
  PanelRightCloseIcon,
  PlayIcon,
  SearchIcon,
  SendIcon,
  SquareIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react"

import type {
  ApprovalRequest,
  ClientKind,
  PermissionMode,
  Runtime,
  SessionSummary,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Input } from "./components/ui/input"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable"
import { ScrollArea } from "./components/ui/scroll-area"
import { Separator } from "./components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { Switch } from "./components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { cn } from "./lib/utils"
import { useWorkspace } from "./use-workspace"
import { DomovoiMark } from "./domovoi-mark"

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
}: {
  snapshot: WorkspaceSnapshot
  connected: boolean
  bridge?: DesktopWindowBridge | undefined
}) {
  return (
    <header className="electron-drag flex h-11 shrink-0 items-center border-b bg-sidebar px-3">
      {bridge?.platform === "darwin" ? <div className="w-[64px]" aria-hidden="true" /> : null}
      <div className="electron-no-drag flex min-w-0 flex-1 items-center gap-2">
        <DomovoiMark reduced className="size-5 text-primary" />
        <span className="text-sm font-semibold tracking-[-0.025em]">Domovoi</span>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Button variant="ghost" size="sm">
          {snapshot.project.name}
          <span className="font-machine text-[10px] text-faint">{snapshot.project.branch}</span>
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

function SessionRow({ session, active }: { session: SessionSummary; active: boolean }) {
  return (
    <button
      type="button"
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

function SessionsSidebar({ snapshot, onCollapse }: { snapshot: WorkspaceSnapshot; onCollapse: () => void }) {
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
        <Button variant="outline" className="w-full justify-start">New session</Button>
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
    decision: "allow-once" | "always-project" | "deny" | "deny-explain",
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

function Thread({
  snapshot,
  onResolve,
  onSetRuntime,
}: {
  snapshot: WorkspaceSnapshot
  onResolve: (
    approvalId: string,
    decision: "allow-once" | "always-project" | "deny" | "deny-explain",
    explanation?: string,
  ) => void
  onSetRuntime: (runtime: Runtime) => void
}) {
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
  const approval = snapshot.approvals.find((candidate) => candidate.sessionId === active.id)

  return (
    <main className="flex h-full min-w-0 flex-col bg-background">
      <div className="flex min-h-[76px] items-center justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0">
          <h1 className="m-0 max-w-xl text-[17px] leading-[1.25] font-semibold tracking-[-0.01em]">
            {active.title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-machine text-[10px] text-faint">
            <span>wt-billing-idem</span><span>from main @ 8f5c1de</span><span>7 files</span>
            <span className="text-success">42 pass</span><span className="text-destructive">1 fail</span>
          </div>
        </div>
        <RuntimeControls runtime={active.runtime} onChange={onSetRuntime} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[668px] flex-col gap-5 px-6 py-6">
          {snapshot.thread.map((item) => {
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
            return <div key={item.id} className="flex max-w-2xl gap-3 text-[13px] leading-relaxed"><span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border bg-card text-primary"><DomovoiMark reduced className="size-4" /></span><p className="m-0">{item.body}</p></div>
          })}
          {approval ? <ApprovalCard approval={approval} onResolve={(decision, explanation) => onResolve(approval.id, decision, explanation)} /> : null}
        </div>
      </ScrollArea>
      <div className="px-5 py-3 [mask-image:linear-gradient(to_bottom,transparent_0,black_12px)]">
        <div className="mx-auto flex max-w-[620px] flex-col gap-2 rounded-xl border bg-card p-3">
          <textarea aria-label="Message" rows={2} className="min-h-12 resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" placeholder="Message the agent" />
          <div className="flex items-center justify-between gap-2">
            <Badge variant="machine">{snapshot.machine.name}</Badge>
            <div className="flex items-center gap-2"><span className="font-machine text-[9px] text-faint">⌘ ↵ send</span><Button size="icon-sm" aria-label="Send message"><SendIcon /></Button></div>
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
            <DropdownMenuItem onSelect={() => onChange({ ...runtime, provider: "claude-code", model: "sonnet-4.6" })}><CheckIcon />Claude Code · sonnet-4.6</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onChange({ ...runtime, provider: "codex", model: "gpt-5.3-codex" })}>Codex CLI · gpt-5.3-codex</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onChange({ ...runtime, provider: "opencode", model: "glm-4.7" })}>OpenCode · glm-4.7</DropdownMenuItem>
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

function ArtifactDock({ snapshot, onCollapse, defaultTab }: { snapshot: WorkspaceSnapshot; onCollapse: () => void; defaultTab: "changes" | "preview" }) {
  return (
    <aside className="flex h-full min-w-0 flex-col bg-sidebar">
      <Tabs defaultValue={defaultTab} className="h-full gap-0">
        <div className="flex h-11 items-center border-b px-2">
          <TabsList variant="line" className="min-w-0 flex-1 justify-start overflow-x-auto">
            <TabsTrigger value="plan"><FileTextIcon />Plan</TabsTrigger>
            <TabsTrigger value="changes"><FileDiffIcon />Changes</TabsTrigger>
            <TabsTrigger value="preview"><CodeXmlIcon />Preview</TabsTrigger>
            <TabsTrigger value="comments"><MessageSquareTextIcon />Comments</TabsTrigger>
            <TabsTrigger value="terminal"><TerminalSquareIcon />Terminal</TabsTrigger>
            <TabsTrigger value="session"><BotIcon />Session</TabsTrigger>
          </TabsList>
          <Button variant="ghost" size="icon-xs" aria-label="Collapse dock" onClick={onCollapse}><PanelRightCloseIcon /></Button>
        </div>
        <TabsContent value="preview" className="min-h-0 overflow-auto p-3">
          <div className="flex min-h-full flex-col overflow-hidden rounded-xl border bg-background shadow-[var(--shadow-md)]">
            <div className="flex h-10 items-center justify-between border-b px-3">
              <div><p className="m-0 text-[11px] font-medium">Replay operations preview</p><p className="m-0 font-machine text-[9px] text-faint">revision 2 · sandboxed</p></div>
              <Badge variant="success">Live</Badge>
            </div>
            <div className="flex flex-1 flex-col gap-5 p-5">
              <div><h2 className="m-0 text-xl font-semibold tracking-[-0.02em]">Idempotent webhook migration</h2><p className="mt-2 max-w-[58ch] text-[11px] text-muted-foreground">Replay-safe handling with an explicit production gate.</p></div>
              <div className="grid grid-cols-2 gap-2">
                {["Persist event key", "Claim before work", "Return cached result", "Audit replay"].map((step, index) => <div key={step} className="rounded-lg bg-accent p-3"><span className="font-machine text-[9px] text-primary">0{index + 1}</span><p className="mb-0 mt-2 text-[11px] font-medium">{step}</p></div>)}
              </div>
              <div className="rounded-lg bg-code p-3 font-machine text-[9px] leading-relaxed text-muted-foreground"><span className="text-success">POST</span> /webhooks/stripe<br />idempotency_key → replay_events<br /><span className="text-warning">migration waits for approval</span></div>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="plan" className="p-4 text-muted-foreground">Four steps · one migration · one hard gate.</TabsContent>
        <TabsContent value="changes" className="p-4 font-machine text-[11px] text-muted-foreground">7 changed files · +184 −36</TabsContent>
        <TabsContent value="comments" className="p-4 text-muted-foreground">2 open annotations</TabsContent>
        <TabsContent value="terminal" className="bg-code p-4 font-machine text-[11px] text-muted-foreground">$ pnpm test<br /><span className="text-success">42 passed</span> · <span className="text-destructive">1 failed</span></TabsContent>
        <TabsContent value="session" className="p-4 font-machine text-[11px] text-muted-foreground">{snapshot.machine.name}<br />{snapshot.project.path}</TabsContent>
      </Tabs>
    </aside>
  )
}

function SidebarRail({ snapshot, onExpand }: { snapshot: WorkspaceSnapshot; onExpand: () => void }) {
  return (
    <aside className="flex w-[46px] shrink-0 flex-col items-center gap-2 border-r bg-sidebar py-2">
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Expand sessions" onClick={onExpand}><PanelLeftCloseIcon className="rotate-180" /></Button></TooltipTrigger><TooltipContent side="right">Expand sessions</TooltipContent></Tooltip>
      <Separator />
      {snapshot.sessions.map((session) => <Tooltip key={session.id}><TooltipTrigger asChild><button type="button" aria-label={session.title} className="flex size-7 items-center justify-center rounded-md hover:bg-accent"><span className={cn("size-2 rounded-full", statusClass[session.state])} /></button></TooltipTrigger><TooltipContent side="right">{session.title}</TooltipContent></Tooltip>)}
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
  const { connected, resolveApproval, setRuntime, snapshot } = useWorkspace(rpcUrl, clientKind)
  const shellRef = useRef<HTMLDivElement>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("domovoi.sidebar-collapsed") === "true")
  const [dockCollapsed, setDockCollapsed] = useState(() => localStorage.getItem("domovoi.dock-collapsed") === "true")
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
        <AppBar snapshot={snapshot} connected={connected} bridge={windowBridge} />
        <div className="flex min-h-0 flex-1">
          {sidebarCollapsed ? <SidebarRail snapshot={snapshot} onExpand={() => setSidebarCollapsed(false)} /> : null}
          <ResizablePanelGroup
            key={layoutKey}
            orientation="horizontal"
            className="min-h-0 min-w-0 flex-1"
            {...(defaultLayout ? { defaultLayout } : {})}
            onLayoutChanged={(layout, meta) => {
              if (meta.isUserInteraction) localStorage.setItem(layoutKey, JSON.stringify(layout))
            }}
          >
            {!sidebarCollapsed ? <><ResizablePanel id="sessions" defaultSize="20" minSize="14" maxSize="28"><SessionsSidebar snapshot={snapshot} onCollapse={() => setSidebarCollapsed(true)} /></ResizablePanel><ResizableHandle /></> : null}
            <ResizablePanel id="thread" defaultSize={sidebarCollapsed && dockCollapsed ? "100" : "48"} minSize="34"><Thread snapshot={snapshot} onResolve={(approvalId, decision, explanation) => void resolveApproval(approvalId, decision, explanation)} onSetRuntime={(runtime) => void setRuntime(snapshot.activeSessionId, runtime)} /></ResizablePanel>
            {!dockCollapsed ? <><ResizableHandle /><ResizablePanel id="dock" defaultSize="32" minSize="24" maxSize="46"><ArtifactDock snapshot={snapshot} onCollapse={() => setDockCollapsed(true)} defaultTab={clientKind === "desktop" ? "changes" : "preview"} /></ResizablePanel></> : null}
          </ResizablePanelGroup>
          {dockCollapsed ? <DockRail onExpand={() => setDockCollapsed(false)} /> : null}
        </div>
        {!connected ? <div className="absolute bottom-3 left-3 rounded-md border border-destructive bg-popover px-3 py-1.5 font-machine text-[10px] text-destructive shadow-[var(--shadow-md)]">Daemon offline · showing local fixture</div> : null}
      </div>
    </TooltipProvider>
  )
}
