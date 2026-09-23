import {
  ClockIcon,
  DiffIcon,
  HistoryIcon,
  ListIcon,
  MonitorIcon,
  ShieldIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react"

export type DockTabId =
  | "plan"
  | "preview"
  | "changes"
  | "terminal"
  | "history"
  | "checkpoints"
  | "rules"

export type DockTabDefinition = {
  id: DockTabId
  label: string
  note: string
  Icon: LucideIcon
}

// Label, note and icon are the design's own, from the sheet tab row of
// design/design_handoff_domovoi_v2/designs/Domovoi Desktop V2.dc.html. The row
// draws the icon alone and hides the label; both reappear in the hover tip.
export const dockTabDefinitions: readonly DockTabDefinition[] = [
  {
    id: "plan",
    label: "Plan preview",
    note: "The working plan rendered as a document, with the gate marked and the limits stated.",
    Icon: ListIcon,
  },
  {
    id: "preview",
    label: "Preview",
    note: "HTML a skill produced, at a chosen width. Written to .domovoi/previews, never to the repo.",
    Icon: MonitorIcon,
  },
  {
    id: "changes",
    label: "Changes",
    note: "Diffs from the worktree on the machine. Nothing is merged until you open a pull request.",
    Icon: DiffIcon,
  },
  {
    id: "terminal",
    label: "Terminal",
    note: "The raw stream from the machine, read-only. The agent owns this shell.",
    Icon: TerminalIcon,
  },
  {
    id: "history",
    label: "History",
    note: "Everything that happened in this session, by category, oldest at the bottom. Fork from any turn.",
    Icon: ClockIcon,
  },
  {
    id: "checkpoints",
    label: "Checkpoints",
    note: "Every approved write is revertible. Reverting rewinds the worktree and the thread together.",
    Icon: HistoryIcon,
  },
  {
    id: "rules",
    label: "Rules",
    note: "What you have already allowed, revocable, plus the things no rule can ever cover.",
    Icon: ShieldIcon,
  },
]
