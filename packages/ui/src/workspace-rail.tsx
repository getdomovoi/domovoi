import { HistoryIcon, LaptopIcon, MessageSquareTextIcon, SettingsIcon, SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DomovoiMark } from "./domovoi-mark.js"
import type { WorkspaceSurface } from "./workspace-persistence.js"

const sections: readonly {
  surface: WorkspaceSurface
  label: string
  Icon: typeof LaptopIcon
}[] = [
  { surface: "workspace", label: "Sessions", Icon: MessageSquareTextIcon },
  { surface: "fleet", label: "Fleet", Icon: LaptopIcon },
  { surface: "skills", label: "Skills", Icon: SparklesIcon },
  { surface: "audit", label: "Audit log", Icon: HistoryIcon },
  { surface: "providers", label: "Settings", Icon: SettingsIcon },
]

export function WorkspaceRail({
  surface,
  machineName,
  onSelectSurface,
}: {
  surface: WorkspaceSurface
  machineName: string
  onSelectSurface: (surface: WorkspaceSurface) => void
}) {
  return (
    <nav
      aria-label="Sections"
      data-workspace-panel="rail"
      className="flex w-[var(--shell-rail)] shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2"
    >
      <DomovoiMark reduced className="mb-1 size-6 text-primary" />
      {sections.map(({ surface: section, label, Icon }) => (
        <Tooltip key={section}>
          <TooltipTrigger asChild>
            <Button
              variant={surface === section ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={label}
              aria-current={surface === section ? "page" : undefined}
              onClick={() => onSelectSurface(section)}
            >
              <Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
      <div className="flex-1" />
      <span
        aria-label={`Signed in on ${machineName}`}
        className="flex size-7 items-center justify-center rounded-lg bg-muted font-machine text-[10px] text-muted-foreground"
      >
        {machineName.slice(0, 2).toUpperCase()}
      </span>
    </nav>
  )
}
