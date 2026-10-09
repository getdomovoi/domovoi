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
    // Q340 A: the tab is an interactive PTY a person opens, not the agent's
    // read-only shell the design draws, so the tip does not say otherwise.
    note: "A shell on the machine, in the session's worktree. One device types at a time; the others can read.",
    Icon: TerminalIcon,
  },
  {
    id: "history",
    label: "History",
    // The design's tip forks from any turn with the oldest row at the bottom.
    // session.fork takes a checkpointId, so only checkpoint rows fork, and not
    // every one (Q42 A); the tab lists the daemon's page oldest first (Q40 A).
    note: "Everything that happened in this session, by category, oldest at the top. Fork from a checkpoint.",
    Icon: ClockIcon,
  },
  {
    id: "checkpoints",
    label: "Checkpoints",
    // Q341 A: revert is worktree-only, so the tip does not promise a rewound thread.
    note: "In a session with a worktree, every request you allow at a gate takes one first. Reverting resets the worktree; the thread keeps its turns.",
    Icon: HistoryIcon,
  },
  {
    id: "rules",
    label: "Rules",
    note: "What you have already allowed, revocable, plus the things no rule can ever cover.",
    Icon: ShieldIcon,
  },
]
