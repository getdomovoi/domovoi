import { useEffect, useMemo, useState } from "react"
import { ArrowLeftIcon, FileTextIcon, SearchIcon } from "lucide-react"

import type { SkillDocument, SkillEnablementReview, SkillInventorySource, SkillSummary } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog"
import { Input } from "./components/ui/input"
import { ScrollArea } from "./components/ui/scroll-area"
import { Separator } from "./components/ui/separator"
import { cn } from "./lib/utils"
import { filterSkills, groupSkills, skillSourceLabel } from "./skill-browser-model"
import { compareSkillInventories, type SkillFleetCellState } from "./skill-fleet-comparison"

const comparisonLabel: Record<SkillFleetCellState, string> = {
  same: "Same",
  different: "Different",
  missing: "Missing",
  blocked: "Blocked",
  untrusted: "Untrusted",
  unknown: "Unknown",
  unreachable: "Unreachable",
}

function comparisonVariant(state: SkillFleetCellState): "success" | "warning" | "destructive" | "secondary" {
  if (state === "same") return "success"
  if (state === "blocked") return "destructive"
  if (state === "different" || state === "missing" || state === "untrusted") return "warning"
  return "secondary"
}

export function SkillSourceContent({
  skill,
  content,
  loading,
  error,
  onRetry,
}: {
  skill: SkillSummary
  content: string
  loading: boolean
  error: string
  onRetry: () => void
}) {
  if (loading) {
    return <div role="status" className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">Reading SKILL.md from the execution machine.</div>
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <FileTextIcon />
        <AlertTitle>SKILL.md could not be read</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <p className="m-0 font-machine text-[9.5px] text-faint">{skill.path} · execution machine</p>
      <pre className="max-h-[62vh] overflow-auto rounded-lg bg-code p-4 font-machine text-[10.5px] leading-relaxed whitespace-pre-wrap text-foreground">{content}</pre>
    </div>
  )
}

export function SkillBrowser({
  skills,
  inventorySources = [],
  loading,
  error,
  onBack,
  onOpenAudit,
  onReadSkill,
  projectId,
  enablements,
  onSetSkillEnabled,
  onRetry,
}: {
  skills: readonly SkillSummary[]
  inventorySources?: readonly SkillInventorySource[]
  loading: boolean
  error: string
  onBack: () => void
  onOpenAudit: () => void
  onReadSkill: (id: string) => Promise<SkillDocument>
  projectId: string | undefined
  enablements: readonly SkillEnablementReview[]
  onSetSkillEnabled: (input: {
    id: string
    enabled: boolean
    contentDigest: string
    manifest: SkillSummary["manifest"]
  }) => Promise<unknown>
  onRetry: () => void
}) {
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState(() => skills[0]?.id ?? "")
  const [sourceSkill, setSourceSkill] = useState<SkillSummary>()
  const [sourceContent, setSourceContent] = useState("")
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState("")
  const [reviewEnabled, setReviewEnabled] = useState<boolean>()
  const [reviewPending, setReviewPending] = useState(false)
  const [reviewError, setReviewError] = useState("")
  const filtered = useMemo(() => filterSkills(skills, query), [query, skills])
  const groups = useMemo(() => groupSkills(filtered), [filtered])
  const comparisons = useMemo(() => compareSkillInventories(inventorySources), [inventorySources])
  const selected = skills.find((skill) => skill.id === selectedId) ?? filtered[0] ?? skills[0]
  const selectedReview = selected && projectId
    ? enablements.find((review) => review.projectId === projectId && review.skillId === selected.id)
    : undefined
  const selectedReviewIsCurrent = Boolean(
    selectedReview
    && selected
    && selectedReview.contentDigest === selected.contentDigest
    && JSON.stringify(selectedReview.manifest) === JSON.stringify(selected.manifest),
  )
  const selectedEnabled = selectedReviewIsCurrent && selectedReview?.enabled === true
  const selectedComparison = selected
    ? comparisons.find((row) => (
        row.name === selected.name && row.scope === selected.scope && row.source === selected.source
      ))
    : undefined

  useEffect(() => {
    if (!selectedId && skills[0]) setSelectedId(skills[0].id)
  }, [selectedId, skills])

  const readSource = (skill: SkillSummary) => {
    setSourceSkill(skill)
    setSourceContent("")
    setSourceError("")
    setSourceLoading(true)
    void onReadSkill(skill.id).then(
      (document) => setSourceContent(document.content),
      (cause: unknown) => setSourceError(cause instanceof Error ? cause.message : "SKILL.md could not be read"),
    ).finally(() => setSourceLoading(false))
  }

  const submitReview = () => {
    if (!selected || reviewEnabled === undefined) return
    setReviewPending(true)
    setReviewError("")
    void onSetSkillEnabled({
      id: selected.id,
      enabled: reviewEnabled,
      contentDigest: selected.contentDigest,
      manifest: selected.manifest,
    }).then(
      () => setReviewEnabled(undefined),
      (cause: unknown) => setReviewError(cause instanceof Error ? cause.message : "Skill review failed"),
    ).finally(() => setReviewPending(false))
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Settings navigation" className="hidden w-[236px] shrink-0 flex-col border-r bg-sidebar p-2.5 sm:flex">
        <Button variant="ghost" className="mb-2 justify-start" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Workspace
        </Button>
        <div className="px-2 py-2 text-base font-semibold">Settings</div>
        <Button variant="secondary" className="justify-start">Skills</Button>
        <Button variant="ghost" className="justify-start" onClick={onOpenAudit}>Audit log</Button>
      </aside>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[740px] px-4 py-5 sm:px-8 sm:py-7">
          <nav aria-label="Settings" className="mb-3 -ml-2 flex flex-wrap items-center gap-1 sm:hidden">
            <Button variant="ghost" className="min-h-11" onClick={onBack}>
              <ArrowLeftIcon data-icon="inline-start" />
              Workspace
            </Button>
            <Button variant="ghost" className="min-h-11" onClick={onOpenAudit}>Audit log</Button>
          </nav>
          <div>
            <h1 className="m-0 text-[17px] font-semibold">Skills</h1>
            <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
              {loading ? "Discovering skills on this machine." : `${skills.length} discovered across Domovoi, user, provider, project, and system directories.`} Skills run on the machine that holds the files they need.
            </p>
          </div>

          <div className="relative mt-4">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              aria-label="Search skills"
              className="pl-9"
              placeholder="Search skills, descriptions, or source paths"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {error ? (
            <Alert variant="destructive" className="mt-4">
              <FileTextIcon />
              <AlertTitle>Skills could not be discovered</AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{error}</span>
                <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {!loading && !error && filtered.length === 0 ? (
            <Empty className="mt-6 min-h-52 border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><SearchIcon /></EmptyMedia>
                <EmptyTitle>{skills.length === 0 ? "No skills discovered" : "No matching skills"}</EmptyTitle>
                <EmptyDescription>{skills.length === 0 ? "Domovoi did not find a valid SKILL.md in any configured directory." : "Try a skill name, description, provider, scope, or source path."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {!error && filtered.length > 0 ? (
            <div className="mt-5 flex flex-col gap-5">
              {groups.map((group) => (
                <section key={group.key}>
                  <div className="flex items-center gap-2">
                    <h2 className="m-0 text-[9.5px] font-medium tracking-[0.12em] text-faint">{group.label}</h2>
                    <Separator className="flex-1" />
                    <span className="font-machine text-[9.5px] text-faint">{group.skills.length}</span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {group.skills.map((skill) => (
                      <Button
                        key={skill.id}
                        variant={skill.id === selected?.id ? "secondary" : "ghost"}
                        className="h-auto min-w-0 justify-start px-2.5 py-2 text-left"
                        aria-pressed={skill.id === selected?.id}
                        onClick={() => setSelectedId(skill.id)}
                      >
                        <span className="min-w-0">
                          <span className={cn("block truncate font-machine text-[11.5px]", skill.id === selected?.id && "text-primary")}>{skill.name}</span>
                          <span className="mt-0.5 block truncate text-[10.5px] font-normal text-muted-foreground">{skill.description}</span>
                        </span>
                      </Button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}

          {selected && filtered.some((skill) => skill.id === selected.id) ? (
            <section className="mt-7 border-t pt-6">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="m-0 font-machine text-lg font-medium">{selected.name}</h2>
                <Badge variant="outline">{selected.scope} · {skillSourceLabel(selected.source)}</Badge>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{selected.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant={selectedEnabled ? "default" : "secondary"}>
                  {selectedEnabled ? "Enabled for this project" : "Not enabled for this project"}
                </Badge>
                {selectedReview && !selectedReviewIsCurrent ? <Badge variant="outline">Review is stale</Badge> : null}
              </div>
              <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <Card>
                  <CardHeader><CardTitle>Source</CardTitle><CardDescription>Discovery provenance</CardDescription></CardHeader>
                  <CardContent className="font-machine text-[11px]">{skillSourceLabel(selected.source)}</CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Scope</CardTitle><CardDescription>Directory ownership</CardDescription></CardHeader>
                  <CardContent className="font-machine text-[11px]">{selected.scope}</CardContent>
                </Card>
                <Card className="sm:col-span-2">
                  <CardHeader><CardTitle>Location</CardTitle><CardDescription>SKILL.md on the execution machine</CardDescription></CardHeader>
                  <CardContent><code className="block break-all font-machine text-[10.5px]">{selected.path}</code></CardContent>
                </Card>
                <Card className="sm:col-span-2">
                  <CardHeader><CardTitle>Review evidence</CardTitle><CardDescription>Exact content and declared capabilities</CardDescription></CardHeader>
                  <CardContent className="flex flex-col gap-2 font-machine text-[10.5px]">
                    <code className="break-all">{selected.contentDigest}</code>
                    <div className="flex flex-wrap gap-1.5">
                      {selected.manifest.capabilities.length > 0
                        ? selected.manifest.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)
                        : <span className="text-muted-foreground">No declared capabilities</span>}
                    </div>
                  </CardContent>
                </Card>
              </div>
              <Card className="mt-4">
                <CardHeader>
                  <CardTitle>Machine comparison</CardTitle>
                  <CardDescription>Metadata only. Domovoi never copies, installs, or syncs skills between machines.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {selectedComparison ? selectedComparison.machines.map((machine) => (
                    <div key={machine.machineId} className="flex items-center justify-between gap-3">
                      <span className="truncate font-machine text-[10.5px]">{machine.machineName}</span>
                      <Badge variant={comparisonVariant(machine.state)}>{comparisonLabel[machine.state]}</Badge>
                    </div>
                  )) : (
                    <p className="m-0 text-[11px] text-muted-foreground">Unknown until this machine inventory is fetched.</p>
                  )}
                  {inventorySources.length === 1 ? (
                    <p className="m-0 text-[10.5px] text-muted-foreground">Other machines remain unknown until their daemon inventory is provided.</p>
                  ) : null}
                </CardContent>
              </Card>
              <Alert className="mt-4">
                <FileTextIcon />
                <AlertTitle>Project review</AlertTitle>
                <AlertDescription>Enablement does not change signature or trust state. Any content or capability change requires another review.</AlertDescription>
              </Alert>
              {reviewError ? <Alert variant="destructive" className="mt-4"><AlertTitle>Review failed</AlertTitle><AlertDescription>{reviewError}</AlertDescription></Alert> : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => readSource(selected)}>
                  <FileTextIcon data-icon="inline-start" />
                  View SKILL.md
                </Button>
                <Button
                  disabled={!projectId || (selected.trust.state === "blocked" && !selectedEnabled)}
                  onClick={() => setReviewEnabled(!selectedEnabled)}
                >
                  {selectedEnabled ? "Review & disable" : "Review & enable"}
                </Button>
              </div>
            </section>
          ) : null}
        </main>
      </ScrollArea>
      <Dialog open={sourceSkill !== undefined} onOpenChange={(open) => { if (!open) setSourceSkill(undefined) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{sourceSkill?.name ?? "Skill"} / SKILL.md</DialogTitle>
            <DialogDescription>Read-only source returned by the daemon that discovered this skill.</DialogDescription>
          </DialogHeader>
          {sourceSkill ? (
            <SkillSourceContent
              skill={sourceSkill}
              content={sourceContent}
              loading={sourceLoading}
              error={sourceError}
              onRetry={() => readSource(sourceSkill)}
            />
          ) : null}
          <DialogFooter><Button variant="outline" onClick={() => setSourceSkill(undefined)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={reviewEnabled !== undefined} onOpenChange={(open) => { if (!open && !reviewPending) setReviewEnabled(undefined) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review {selected?.name ?? "skill"}</AlertDialogTitle>
            <AlertDialogDescription>
              Confirm this exact content digest and capability manifest for {projectId ? "the open project" : "a project"}. This does not grant trust.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {selected ? <div className="flex flex-col gap-2 font-machine text-[10.5px]"><code className="break-all">{selected.contentDigest}</code><span>{selected.manifest.capabilities.join(", ") || "No declared capabilities"}</span></div> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reviewPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={reviewPending} onClick={submitReview}>
              {reviewEnabled ? "Enable for project" : "Disable for project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
