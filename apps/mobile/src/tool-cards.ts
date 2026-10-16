import type { ThreadEntry } from "./session-detail"

// Task 107: how a tool or command card opens in the phone thread. One
// command's text could fill several screens, so a card folds to one line and
// opens on a tap. The default is a device setting; a card toggled by hand
// keeps that choice while the thread is open.
export type ToolCardDefault = "collapsed" | "expanded"

export const toolCardDefaultKey = "domovoi.tool-cards"

// Q116 (standing ruling 2026-10-06): a fresh install starts collapsed, so a
// long card does not bury the rest of the thread.
export const freshToolCardDefault: ToolCardDefault = "collapsed"

export function parseToolCardDefault(stored: string | null | undefined): ToolCardDefault {
  return stored === "expanded" || stored === "collapsed" ? stored : freshToolCardDefault
}

// A folded card shows one line, so a many-line command is joined onto one,
// and bounded: the line ellipsizes anyway, and laying out a whole heredoc to
// show its first words is wasted work.
const summaryLimit = 240

export function toolSummary(title: string): string {
  const line = title.replace(/\s+/g, " ").trim()
  return line.length > summaryLimit ? `${line.slice(0, summaryLimit)}…` : line
}

export function toolCardOpen(chosen: boolean | undefined, fallback: ToolCardDefault): boolean {
  return chosen ?? fallback === "expanded"
}

// Approval facts never fold away (AGENTS.md: clients collapse information for
// smaller screens, they do not omit approval facts). Only a tool call folds,
// and not one that may be the command a waiting approval holds. The approval
// names the provider's item, not the thread row, so the phone cannot tell
// which running call that is; while an approval waits, every running call
// stays open. That can show more than needed, never less.
export function foldsAway(entry: ThreadEntry, approvalWaiting: boolean): boolean {
  if (entry.kind !== "note" || !entry.tool) return false
  return !(approvalWaiting && entry.tool.status === "running")
}
