import { useEffect, useRef, useState, type FormEvent } from "react"
import { BotIcon, CheckIcon, ChevronDownIcon, FolderOpenIcon } from "lucide-react"
import type {
  PermissionMode,
  ProviderModel,
  ProviderRuntime,
  ProjectSwitchConfirmation,
  Runtime,
} from "@getdomovoi/protocol"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog"
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
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Input } from "./components/ui/input"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./components/ui/field"
import { ScrollArea } from "./components/ui/scroll-area"
import { cn } from "./lib/utils"
import {
  preferredSessionProvider,
  providerCanStartSession,
  providerDisplayName,
  providerStatusLabel,
  selectRuntimeModel,
} from "./runtime"

export function ProjectSwitchConfirmationDialog({
  confirmation,
  pending = false,
  error = "",
  onCancel,
  onConfirm,
}: {
  confirmation: ProjectSwitchConfirmation
  pending?: boolean
  error?: string
  onCancel: () => void
  onConfirm: (path: string) => void
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop running work and switch projects?</AlertDialogTitle>
          <AlertDialogDescription>
            Domovoi keeps {confirmation.sessionCount} sessions and their saved history, including {confirmation.worktreeCount} isolated {confirmation.worktreeCount === 1 ? "worktree" : "worktrees"}, and restores them when you reopen this project. Switching now stops any turn, provider thread, and terminal that is still running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ScrollArea className="max-h-44 rounded-md border">
          <ul className="divide-y">
            {confirmation.sessions.map((session) => (
              <li key={session.id} className="px-3 py-2 text-sm">
                <span className="block font-medium text-foreground">{session.title}</span>
                <span className="font-machine text-[10px] text-muted-foreground">{session.workspacePath ?? "No isolated worktree"}</span>
              </li>
            ))}
          </ul>
        </ScrollArea>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep current project</AlertDialogCancel>
          <Button
            disabled={pending}
            onClick={() => onConfirm(confirmation.requestedPath)}
          >
            {pending ? "Switching…" : "Stop work and switch"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
const defaultRuntime: Runtime = {
  provider: "codex",
  model: "default",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
}
export type LauncherMode = "project" | "session" | null

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
  defaultProviderId,
  defaultPermissionMode,
  onOpenChange,
  onOpenProject,
  onCreateSession,
  onListModels,
}: {
  mode: LauncherMode
  projectNote?: string
  providers: readonly ProviderRuntime[]
  defaultProviderId?: string
  defaultPermissionMode: PermissionMode
  onOpenChange: (open: boolean) => void
  onOpenProject: (path: string) => Promise<void>
  onCreateSession: (title: string, runtime: Runtime) => Promise<void>
  onListModels: (provider: string) => Promise<ProviderModel[]>
}) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [runtime, setRuntime] = useState(() => ({
    ...defaultRuntime,
    ...(defaultProviderId ? { provider: defaultProviderId } : {}),
    permissionMode: defaultPermissionMode,
  }))
  const [models, setModels] = useState<ProviderModel[]>([])
  const [modelsPending, setModelsPending] = useState(false)
  const [modelsError, setModelsError] = useState("")
  const modelRequest = useRef(0)
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
      setModelsError("No provider on this machine can start a session")
      return
    }

    const request = ++modelRequest.current
    setRuntime({
      ...defaultRuntime,
      provider: provider.id,
      permissionMode: defaultPermissionMode,
    })
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
    // Keyed on what the providers say, not on the array a new snapshot happens
    // to allocate: an equal list must not reset the model already chosen.
  }, [defaultPermissionMode, defaultProviderId, mode, onListModels, providerReadinessKey])

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
  const projectDescription = projectNote
    ? `Choose a local Git repository. Code stays on this machine. ${projectNote}`
    : "Choose a local Git repository. Code stays on this machine."
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
                ? projectDescription
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
                        {/* A harness that is not installed is absent, not a
                            greyed item that can never be chosen. The readiness
                            list beside still states the fact. */}
                        {providers.filter((provider) => provider.status !== "missing").map((provider) => (
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
