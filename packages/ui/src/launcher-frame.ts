import { cn } from "./lib/utils"

export type LauncherMode = "project" | "session" | null

// What a start from the launcher resolves to. A start that needed a project
// switch the person did not confirm is cancelled, and the launcher stays open
// with what was typed so another project can be chosen (ruling Q158 A).
export type LauncherStartOutcome = "started" | "cancelled"

// The launcher's title and size for each mode. The launcher draws from these,
// and so does the dialog that stands in for it while its code loads, which
// loads with the shell (workspace-shell.tsx). Kept apart from the launcher so
// the shell can draw that dialog without loading the launcher's code.
export function launcherTitle(mode: LauncherMode): string {
  return mode === "project" ? "Open a project" : "Start a session"
}

export function launcherContentClassName(mode: LauncherMode): string {
  return cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", mode !== "project" && "sm:max-w-lg")
}
