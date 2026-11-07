import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { BotIcon, CheckIcon, ChevronDownIcon, FolderIcon, FolderOpenIcon } from "lucide-react"
import type {
  PermissionMode,
  ProviderModel,
  ProviderRuntime,
  Runtime,
  WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
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
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Input } from "./components/ui/input"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./components/ui/field"
import { launcherContentClassName, launcherTitle, type LauncherMode, type LauncherStartOutcome } from "./launcher-frame"
import type { LauncherProject } from "./project-entries"
import { permissionModeLabel } from "./permission-mode"
import { startOpenerRef } from "./start-handoff"
import {
  modelReadFailure,
  preferredSessionProvider,
  providerCanStartSession,
  providerDisplayName,
  providerStatusLabel,
  selectRuntimeModel,
} from "./runtime"

const defaultRuntime: Runtime = {
  provider: "codex",
  model: "default",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
}
export type { LauncherMode, LauncherStartOutcome }

function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path
}

function projectStatus(project: LauncherProject): string {
  if (project.folder === "missing") return "folder not found"
  if (project.folder === "unreadable") return "folder could not be read"
  return project.open ? "open" : "not active"
}

// When every harness is missing the list is an empty state, and the useful
// part of an empty state is what was looked for and where. A miss on one PATH
// is not proof of absence: an app launched from the Dock searches a PATH the
// person's shell never sees. So this is a search report, not a picker and not
// a status list, and it names what would change the answer.
export function ProviderSearchReport({
  providers,
  toolPath,
}: {
  providers: readonly ProviderRuntime[]
  toolPath?: string | undefined
}) {
  const commands = providers.map((provider) => provider.command)
  const named = commands.length === 1
    ? commands[0]!
    : `${commands.slice(0, -1).join(", ")} and ${commands.at(-1)}`
  const outcome = commands.length === 2 ? "found neither" : "found nothing"
  const searched = toolPath
    ? `Searched ${toolPath} for ${named} and ${outcome}.`
    : `Searched for ${named} and ${outcome}. This daemon did not report where it looked.`
  return (
    <section aria-label="Provider search" className="flex flex-col gap-1.5 rounded-lg border bg-background/40 px-3 py-2.5 text-[12px]">
      <p className="m-0 break-all font-machine text-mono-xs text-muted-foreground">{searched}</p>
      <p className="m-0 text-faint">
        Finding nothing here is not proof nothing is installed. A CLI that lives in a directory not on that path is invisible to this daemon; add the directory as the override in tools.json in the profile, or set DOMOVOI_TOOL_PATH, and restart the daemon.
      </p>
    </section>
  )
}

export function ProviderReadinessList({
  providers,
  toolPath,
}: {
  providers: readonly ProviderRuntime[]
  toolPath?: string | undefined
}) {
  if (providers.length === 0) {
    return <FieldDescription>Provider readiness has not been reported by this machine yet.</FieldDescription>
  }
  if (providers.every((provider) => provider.status === "missing")) {
    return <ProviderSearchReport providers={providers} toolPath={toolPath} />
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
              <span className="truncate font-machine text-mono-xs text-faint">
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

export function LauncherDialog({
  mode,
  projectNote,
  providers,
  toolPath,
  defaultProviderId,
  defaultPermissionMode,
  onOpenChange,
  onOpenProject,
  onCreateSession,
  onListModels,
  recentSessions = [],
  onResumeSession,
  projects = [],
  initialProjectPath,
  onChooseFolder,
}: {
  mode: LauncherMode
  projectNote?: string
  providers: readonly ProviderRuntime[]
  toolPath?: string | undefined
  defaultProviderId?: string
  defaultPermissionMode: PermissionMode
  onOpenChange: (open: boolean) => void
  onOpenProject: (path: string) => Promise<void>
  // projectPath is the project the session starts in, which may not be the
  // open one (ruling Q158 A).
  onCreateSession: (title: string, runtime: Runtime, projectPath: string) => Promise<LauncherStartOutcome | void>
  onListModels: (provider: string) => Promise<ProviderModel[]>
  recentSessions?: WorkspaceSnapshot["sessions"] | undefined
  onResumeSession?: ((sessionId: string) => void) | undefined
  // The projects this machine knows, open ones first.
  projects?: readonly LauncherProject[] | undefined
  // The project chosen when the launcher opens; the open project otherwise.
  initialProjectPath?: string | undefined
  // A native folder picker, where the host has one; it answers null when the
  // person cancels. Without one, Choose a folder takes a typed path.
  onChooseFolder?: (() => Promise<string | null>) | undefined
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [projectPath, setProjectPath] = useState("")
  // A folder chosen from the picker that is not among the known projects.
  const [pickedFolder, setPickedFolder] = useState<LauncherProject | null>(null)
  const [typingPath, setTypingPath] = useState(false)
  const [typedPath, setTypedPath] = useState("")
  const projectLabelId = useId()
  const projectValueId = useId()
  const openProjectPath = projects.find((project) => project.open)?.path ?? ""
  const defaultProjectPath = useRef("")
  defaultProjectPath.current = initialProjectPath ?? openProjectPath
  // The project resets each time the launcher opens, to the one it was opened
  // for or the open one; a project list that arrives later keeps the choice.
  useEffect(() => {
    if (mode !== "session") return
    setProjectPath(defaultProjectPath.current)
    setPickedFolder(null)
    setTypingPath(false)
    setTypedPath("")
  }, [mode, initialProjectPath])
  const [runtime, setRuntime] = useState(() => ({
    ...defaultRuntime,
    ...(defaultProviderId ? { provider: defaultProviderId } : {}),
    permissionMode: defaultPermissionMode,
  }))
  const [models, setModels] = useState<ProviderModel[]>([])
  const [modelsPending, setModelsPending] = useState(false)
  const [modelsError, setModelsError] = useState("")
  // The last model read failed, as opposed to answering with nothing, so it
  // can be asked for again.
  const [modelsReadFailed, setModelsReadFailed] = useState(false)
  const modelRequest = useRef(0)
  // The provider whose scale the runtime's reasoning id belongs to, set only
  // while a provider pick waits for its models.
  const reasoningProvider = useRef<string | undefined>(undefined)
  // The effect below reads the latest providers without depending on the
  // identity of the array they arrive in.
  const providersRef = useRef(providers)
  providersRef.current = providers
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

    const provider = providersRef.current.find((candidate) =>
      candidate.id === defaultProviderId && providerCanStartSession(candidate)
    ) ?? preferredSessionProvider(providersRef.current)
    if (!provider) {
      setModels([])
      setModelsReadFailed(false)
      setModelsError("Domovoi found no provider CLI on the path it searched")
      return
    }

    const request = ++modelRequest.current
    reasoningProvider.current = undefined
    setRuntime({
      ...defaultRuntime,
      provider: provider.id,
      permissionMode: defaultPermissionMode,
    })
    setModels([])
    setModelsPending(true)
    setModelsError("")
    setModelsReadFailed(false)
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
          setModelsError(modelReadFailure(provider.id, cause))
          setModelsReadFailed(true)
        }
      },
    ).finally(() => {
      if (request === modelRequest.current) setModelsPending(false)
    })
    // Keyed on what the providers say, not on the array a new snapshot happens
    // to allocate: an equal list must not reset the model already chosen.
  }, [defaultPermissionMode, defaultProviderId, mode, onListModels, providerReadinessKey])

  const selectProvider = (provider: ProviderRuntime) => {
    if (!providerCanStartSession(provider)) return
    const request = ++modelRequest.current
    // The runtime names the new provider at once, but its reasoning is still
    // an id on the scale it was chosen on. Keep that provider until a model
    // is picked, across picks that land before the models do.
    reasoningProvider.current ??= runtime.provider
    setRuntime((current) => ({ ...current, provider: provider.id, model: "default" }))
    setModels([])
    setModelsPending(true)
    setModelsError("")
    setModelsReadFailed(false)
    void onListModels(provider.id).then(
      (nextModels) => {
        if (request !== modelRequest.current) return
        setModels(nextModels)
        const selected = nextModels.find((model) => model.isDefault) ?? nextModels[0]
        if (selected) {
          const from = reasoningProvider.current
          reasoningProvider.current = undefined
          setRuntime((current) => selectRuntimeModel(current, selected, from ?? current.provider))
        } else setModelsError(`${providerDisplayName(provider.id)} did not report any models`)
      },
      (cause: unknown) => {
        if (request === modelRequest.current) {
          setModelsError(modelReadFailure(provider.id, cause))
          setModelsReadFailed(true)
        }
      },
    ).finally(() => {
      if (request === modelRequest.current) setModelsPending(false)
    })
  }

  const isProject = mode === "project"
  const projectDescription = projectNote
    ? `Choose a local Git repository. Code stays on this machine. ${projectNote}`
    : "Choose a local Git repository. Code stays on this machine."
  // A harness that is not installed is absent from the picker, so the trigger
  // cannot name it either: the runtime may still carry the default provider's
  // id when nothing on the machine can start, and the trigger and the picker
  // must agree.
  const pickableProviders = providers.filter((provider) => provider.status !== "missing")
  const selectedProvider = pickableProviders.find((provider) => provider.id === runtime.provider)
  const selectedModel = models.find((model) =>
    model.provider === runtime.provider && model.id === runtime.model,
  )
  const runtimeReady = Boolean(selectedProvider && providerCanStartSession(selectedProvider) && selectedModel)
  // The project the session starts in: a typed path while one is being typed,
  // otherwise the project chosen from the list or the picker.
  const chosenPath = typingPath ? typedPath.trim() : projectPath
  const chosenProject = projects.find((project) => project.path === chosenPath)
    ?? (pickedFolder?.path === chosenPath ? pickedFolder : undefined)
  const anyProjectOpen = projects.some((project) => project.open)
  const projectReady = chosenPath !== "" && chosenProject?.folder !== "missing"
  const chooseProject = (project: LauncherProject) => {
    setProjectPath(project.path)
    setTypingPath(false)
  }
  const chooseFolder = async () => {
    if (!onChooseFolder) {
      setTypingPath(true)
      return
    }
    try {
      const path = await onChooseFolder()
      if (!path) return
      const listed = projects.find((project) => project.path === path)
      setPickedFolder(listed ? null : { name: folderName(path), path, open: false, folder: "present" })
      setProjectPath(path)
      setTypingPath(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Domovoi could not open the folder picker")
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    if (!input || !mode || pending) return
    if (!isProject && !projectReady) return
    setPending(true)
    setError("")
    try {
      if (isProject) await onOpenProject(input)
      else if (await onCreateSession(input, runtime, chosenPath) === "cancelled") return
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
      <DialogContent className={launcherContentClassName(mode)}>
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{launcherTitle(mode)}</DialogTitle>
            <DialogDescription>
              {isProject
                ? projectDescription
                : "Domovoi creates an isolated worktree before the first agent turn."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {!isProject ? (
              <Field>
                {/* Ruling Q158 A: the session names its project here, so a new
                    project is a pick in this dialog rather than a step before
                    it. */}
                <FieldLabel id={projectLabelId}>Project</FieldLabel>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-9 justify-between py-1.5"
                      aria-labelledby={`${projectLabelId} ${projectValueId}`}
                      disabled={pending}
                    >
                      <span id={projectValueId} className="flex min-w-0 items-center gap-2">
                        <FolderIcon data-icon="inline-start" />
                        {chosenPath ? (
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate font-machine text-[12px] text-strong">{chosenProject?.name ?? folderName(chosenPath)}</span>
                            <span className="truncate font-machine text-mono-xs text-faint">{chosenPath}</span>
                          </span>
                        ) : (
                          <span className="truncate text-muted-foreground">Choose a project</span>
                        )}
                      </span>
                      <ChevronDownIcon data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[min(26rem,calc(100vw-2rem))]">
                    {projects.length > 0 ? (
                      <>
                        <DropdownMenuLabel>Projects</DropdownMenuLabel>
                        <DropdownMenuGroup>
                          {projects.map((project) => (
                            <DropdownMenuItem
                              key={project.path}
                              disabled={project.folder === "missing"}
                              onSelect={() => chooseProject(project)}
                            >
                              {project.path === chosenPath ? <CheckIcon /> : <span aria-hidden className="size-4" />}
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate font-machine text-[12px]">{project.name}</span>
                                <span className="truncate font-machine text-mono-xs text-faint">{project.path}</span>
                              </span>
                              <span className="shrink-0 text-[11px] text-muted-foreground">{projectStatus(project)}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    <DropdownMenuItem onSelect={() => { void chooseFolder() }}>
                      <FolderOpenIcon />
                      Choose a folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {chosenPath && !chosenProject?.open ? (
                  <FieldDescription>
                    {anyProjectOpen
                      ? "Domovoi opens this project first. If the open project has sessions, it asks before stopping their work."
                      : "Domovoi opens this project first."}
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}
            {!isProject && typingPath ? (
              <Field>
                <FieldLabel htmlFor="launcher-project-path">Repository path</FieldLabel>
                <Input
                  id="launcher-project-path"
                  autoFocus
                  autoComplete="off"
                  value={typedPath}
                  disabled={pending}
                  onChange={(event) => setTypedPath(event.target.value)}
                  placeholder="/home/you/projects/example"
                />
                <FieldDescription>The daemon validates the repository before opening it.</FieldDescription>
              </Field>
            ) : null}
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
                {/* Walk F14, ruling Q135: the goal is also the session's first
                    message, and the mode it runs in is not drawn anywhere else
                    here. */}
                {isProject
                  ? "The daemon validates the repository before opening it."
                  : `This is also the first message: the agent starts on it in ${permissionModeLabel(runtime.permissionMode, runtime.auto)} mode. Runtime and permission controls remain editable in the session.`}
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
                        {pickableProviders.map((provider) => (
                          <DropdownMenuItem
                            key={provider.id}
                            disabled={pending || !providerCanStartSession(provider)}
                            onSelect={() => selectProvider(provider)}
                          >
                            {provider.id === runtime.provider ? <CheckIcon /> : null}
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span>{providerDisplayName(provider.id)}</span>
                              <span className="truncate font-machine text-mono-xs text-faint">
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
                              <span className="truncate font-machine text-mono-xs text-faint">{model.id}</span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex items-start justify-between gap-2">
                  <FieldError id="launcher-model-error">{modelsError}</FieldError>
                  {modelsReadFailed && selectedProvider && !modelsPending ? (
                    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => selectProvider(selectedProvider)}>
                      Try again
                    </Button>
                  ) : null}
                </div>
                <ProviderReadinessList providers={providers} toolPath={toolPath} />
              </Field>
            ) : null}
          </FieldGroup>
          {!isProject && recentSessions.length > 0 && onResumeSession ? (
            <section aria-label="Pick up where you left off" className="border-t pt-4">
              <p className="m-0 text-[10.5px] tracking-[0.13em] text-faint">PICK UP WHERE YOU LEFT OFF</p>
              <div className="mt-2 grid gap-1.5">
                {recentSessions.filter((session) => session.state !== "archived").slice(0, 3).map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2 text-left hover:bg-accent"
                    onClick={() => {
                      onResumeSession(session.id)
                      onOpenChange(false)
                    }}
                  >
                    <span className="min-w-0 truncate text-[12px] font-medium">{session.title}</span>
                    <span className="shrink-0 font-machine text-[10px] text-faint">{session.state}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            {/* startOpenerRef registers a control that opens a session
                start (ruling Q410). */}
            <Button ref={startOpenerRef} type="submit" disabled={!value.trim() || pending || (!isProject && (!runtimeReady || !projectReady))}>
              {isProject ? <FolderOpenIcon data-icon="inline-start" /> : <BotIcon data-icon="inline-start" />}
              {pending ? "Working" : isProject ? "Open project" : "Create session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
