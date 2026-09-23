import { SearchIcon, SendIcon } from "lucide-react"

import { Button } from "./components/ui/button"

export function NoResultsState({
  query,
  answeredMachines,
  unreachableMachines,
  onSearchAnswered,
}: {
  query: string
  answeredMachines: readonly string[]
  unreachableMachines: readonly string[]
  onSearchAnswered: () => void
}) {
  const answered = answeredMachines.length === 2 ? "two machines" : `${answeredMachines.length} machines`
  return (
    <section aria-label="Nothing matched" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2.5 border-b px-5 py-[13px]">
        <SearchIcon className="size-4 text-faint" />
        <span className="font-machine text-[12.5px]">{query}</span>
        <span className="ml-auto font-machine text-[10.5px] text-faint">searched {answeredMachines.length + unreachableMachines.length} machines</span>
      </header>
      <div className="flex flex-1 items-center justify-center p-[30px]">
        <div className="flex w-full max-w-[520px] flex-col items-center gap-3.5 text-center">
          <span className="flex size-[58px] items-center justify-center rounded-full bg-accent text-muted-foreground"><SearchIcon className="size-6" /></span>
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">Nothing matched on the {answered} that answered</h2>
          <p className="m-0 text-[13px] leading-[1.6] text-muted-foreground">{unreachableMachines.length > 0 ? `${unreachableMachines.join(", ")} did not answer, so its sessions were not searched. This is not the same as having no results, and Domovoi will not round it down to one.` : "Every selected machine answered and no session matched this search."}</p>
          <div className="w-full overflow-hidden rounded-xl border bg-card text-left">
            {answeredMachines.map((machine) => <div key={machine} className="flex items-center gap-3 border-t px-3.5 py-2.5 first:border-t-0"><span className="size-1.5 rounded-full bg-success" /><span className="flex-1 font-machine text-[11.5px]">{machine}</span><span className="font-machine text-[10.5px] text-success">searched</span></div>)}
            {unreachableMachines.map((machine) => <div key={machine} className="flex items-center gap-3 border-t px-3.5 py-2.5 first:border-t-0"><span className="size-1.5 rounded-full bg-destructive" /><span className="flex-1 font-machine text-[11.5px]">{machine}</span><span className="font-machine text-[10.5px] text-destructive">unreachable</span></div>)}
          </div>
          {unreachableMachines.length > 0 ? <Button variant="outline" onClick={onSearchAnswered}>Search only what answered</Button> : null}
        </div>
      </div>
    </section>
  )
}

export function NothingHasRunState({
  worktree,
  base,
  projectName,
  starters,
}: {
  worktree: string
  base: string
  projectName: string
  starters: readonly { label: string; meta: string }[]
}) {
  return (
    <section aria-label="Nothing has run yet" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-5 py-[13px]"><span className="size-1.5 rounded-full bg-success" /><span className="text-[13px] text-strong">Worktree ready</span><span className="font-machine text-[10.5px] text-faint">{worktree} off {base}</span></header>
      <div className="flex flex-1 items-center justify-center p-[30px]">
        <div className="flex w-full max-w-[620px] flex-col gap-[15px]">
          <div className="flex flex-col gap-2"><h2 className="m-0 text-[19px] font-semibold tracking-[-0.015em]">Nothing has run yet</h2><p className="m-0 text-[13.5px] leading-[1.65] text-muted-foreground">The session exists, the worktree is cut, and the agent has not been given a turn. Your first message is what starts it.</p></div>
          <div className="overflow-hidden rounded-xl border bg-card"><h3 className="m-0 border-b px-3.5 py-[11px] text-[13px] font-semibold">What it will do first</h3>{["Read the project instructions and current state", "Plan against this worktree without touching your checkout", "Stop for any hard gate before consequential work"].map((item) => <div key={item} className="flex items-start gap-2.5 border-t px-3.5 py-2.5 first:border-t-0"><span className="mt-1.5 size-1.5 rounded-full bg-info" /><span className="text-[12.5px] leading-[1.55] text-strong">{item}</span></div>)}</div>
          {starters.length > 0 ? <div className="flex flex-col gap-2"><h3 className="m-0 text-[10.5px] font-medium tracking-[0.13em] text-faint">OR START FROM SOMETHING IT ALREADY KNOWS</h3>{starters.map((starter) => <div key={starter.label} className="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-2.5"><span className="flex-1 text-[12.5px] text-strong">{starter.label}</span><span className="font-machine text-[10.5px] text-faint">{starter.meta}</span></div>)}</div> : null}
        </div>
      </div>
      <div className="flex justify-center px-5 pb-[18px] pt-3.5"><div className="flex w-full max-w-[720px] items-center gap-3 rounded-xl border border-primary bg-card px-3.5 py-3"><span className="flex-1 text-[13.5px] text-faint">Say what you want done in {projectName}</span><SendIcon className="size-4 text-primary" /></div></div>
    </section>
  )
}
