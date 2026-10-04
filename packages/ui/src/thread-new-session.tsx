import type { Runtime } from "@getdomovoi/protocol"

import { cn } from "./lib/utils"
import { askRaisesGates, readOnlyEnforcement } from "./permission-mode"

type Row = { text: string, tone: "success" | "info" }

// Ruled Q368 A: the rows come only from what the session's mode and the
// daemon's checkpoint policy decide. The design's three rows describe Ask in
// every mode. J34: a person's allow takes a checkpoint first; a command that
// Auto or a standing rule allows takes none. Plan and Ask are held to reading
// as the daemon configures each provider (readOnlyEnforcement). Plan raises
// no gate, and Ask raises one only where the provider asks rather than
// refuses (askRaisesGates), so only there does Ask get a checkpoint row. The
// design's starters wait on a suggestion source.
export function whatItWillDoFirst(runtime: Pick<Runtime, "provider" | "permissionMode" | "auto">): Row[] {
  if (runtime.permissionMode === "plan") {
    return [{ text: `Read the repository and propose a plan. ${readOnlyEnforcement("plan", runtime.provider)}`, tone: "success" }]
  }
  if (runtime.permissionMode === "ask") {
    const reads: Row = { text: `Read the repository. ${readOnlyEnforcement("ask", runtime.provider)}`, tone: "success" }
    return askRaisesGates(runtime.provider)
      ? [reads, { text: "Take a checkpoint before any command you allow at a gate, so the worktree can go back to it.", tone: "info" }]
      : [reads]
  }
  // Auto allows only a command its safe patterns clear or whose resolution is
  // bounded (permission-policy.ts), and a standing rule answers a normal gate
  // whose digest it matches. Any other command raises a normal gate and the
  // turn waits on it, so Auto does not run without stopping.
  if (runtime.auto) {
    return [
      { text: "Write and run inside the worktree, step after step. Commands Auto or a rule allows run without stopping. Any other command still stops it at a gate, as do hard gates and policy refusals.", tone: "success" },
      { text: "Take a checkpoint before any command you allow at a gate. Commands that Auto or a rule allows run without one.", tone: "info" },
    ]
  }
  return [
    { text: "Write and run inside the worktree. Gates still stop it for your decision.", tone: "success" },
    { text: "Take a checkpoint before any command you allow at a gate. A command a rule allows runs without one.", tone: "info" },
  ]
}

// Only a full commit SHA is shortened; anything else is shown whole.
function shortCommit(commit: string): string {
  return /^[0-9a-f]{40}$/u.test(commit) ? commit.slice(0, 7) : commit
}

// The design's strip above a fresh thread. The session does not carry the
// branch its worktree was cut from, so the meta names the worktree and the
// base commit and leaves the design's "off main" out.
export function WorktreeReadyHeader({ workspacePath, baseCommit }: { workspacePath: string, baseCommit?: string | undefined }) {
  const worktree = workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath
  return (
    <div
      role="status"
      aria-label="Worktree ready"
      className="flex flex-none flex-wrap items-center gap-[11px] border-b px-5 py-[13px]"
    >
      <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-success" />
      <span className="text-[13px] text-strong">Worktree ready</span>
      <span className="font-machine text-[10.5px] text-faint">
        {baseCommit ? `${worktree} at ${shortCommit(baseCommit)}` : worktree}
      </span>
    </div>
  )
}

export function NothingHasRunYet({ runtime }: { runtime: Pick<Runtime, "provider" | "permissionMode" | "auto"> }) {
  const rows = whatItWillDoFirst(runtime)
  return (
    <section className="mx-auto flex w-full max-w-[620px] flex-col gap-[15px] py-6">
      <div className="flex flex-col gap-2">
        <h2 className="m-0 text-[19px] font-semibold tracking-[-.015em]">Nothing has run yet</h2>
        <p className="m-0 text-[13.5px] leading-[1.65] text-pretty text-muted-foreground">
          The session exists, the worktree is cut, and the agent has not been given a turn. Your first message is what starts it.
        </p>
      </div>
      <div className="overflow-hidden rounded-[var(--radius)] border bg-card">
        <h3 id="what-it-will-do-first" className="m-0 border-b px-3.5 py-[11px] text-[13px] font-semibold">What it will do first</h3>
        <ul aria-labelledby="what-it-will-do-first" className="m-0 list-none p-0">
          {rows.map((row, index) => (
            <li key={row.text} className={cn("flex items-start gap-2.5 px-3.5 py-2.5 text-[12.5px] leading-[1.55] text-strong", index > 0 && "border-t")}>
              <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", row.tone === "success" ? "bg-success" : "bg-info")} />
              {row.text}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
