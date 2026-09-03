import { CodeXmlIcon, FileDiffIcon, MessageSquareTextIcon, SettingsIcon, TerminalSquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DomovoiMark } from "./domovoi-mark.js"
import type { WorkspaceSurface } from "./workspace-persistence.js"

const panes: readonly { tab: string; label: string; Icon: typeof FileDiffIcon }[] = [
  { tab: "changes", label: "Changes", Icon: FileDiffIcon },
  { tab: "terminal", label: "Terminal", Icon: TerminalSquareIcon },
  { tab: "preview", label: "Preview", Icon: CodeXmlIcon },
]

export function WorkspaceRail({
  surface,
  dockTab,
  machineName,
  onSelectSurface,
  onSelectDockTab,
}: {
  surface: WorkspaceSurface
  dockTab: string
  machineName: string
  onSelectSurface: (surface: WorkspaceSurface) => void
  onSelectDockTab: (tab: string) => void
}) {
  const onWorkspace = surface === "workspace"

  return (
    <nav
      aria-label="Sections"
      data-workspace-panel="rail"
      className="flex w-[var(--shell-rail)] shrink-0 flex-col items-center gap-1.5 border-r bg-sidebar py-3"
    >
      <DomovoiMark reduced className="mb-1.5 size-[26px] text-primary" />
      <RailButton
        label="Sessions"
        current={onWorkspace}
        onClick={() => onSelectSurface("workspace")}
      >
        <MessageSquareTextIcon />
      </RailButton>
      {panes.map(({ tab, label, Icon }) => (
        <RailButton
          key={tab}
          label={label}
          current={onWorkspace && dockTab === tab}
          onClick={() => {
            onSelectSurface("workspace")
            onSelectDockTab(tab)
          }}
        >
          <Icon />
        </RailButton>
      ))}
      <div className="flex-1" />
      <RailButton
        label="Settings"
        current={surface === "providers"}
        onClick={() => onSelectSurface("providers")}
      >
        <SettingsIcon />
      </RailButton>
      <span
        aria-label={`Signed in on ${machineName}`}
        className="flex size-[26px] items-center justify-center rounded-full bg-muted font-machine text-[10px] font-semibold text-muted-foreground"
      >
        {machineName.slice(0, 2).toUpperCase()}
      </span>
    </nav>
  )
}

function RailButton({
  label,
  current,
  onClick,
  children,
}: {
  label: string
  current: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={current ? "secondary" : "ghost"}
          size="icon"
          className="size-10 rounded-[var(--radius-md)]"
          aria-label={label}
          aria-current={current ? "page" : undefined}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}
