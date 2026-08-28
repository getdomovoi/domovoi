import { useEffect, useMemo, useState } from "react"
import { ArrowLeftIcon, FileTextIcon, SearchIcon } from "lucide-react"

import type { SkillDocument, SkillSummary } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
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
  loading,
  error,
  onBack,
  onReadSkill,
  onRetry,
}: {
  skills: readonly SkillSummary[]
  loading: boolean
  error: string
  onBack: () => void
  onReadSkill: (id: string) => Promise<SkillDocument>
  onRetry: () => void
}) {
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState(() => skills[0]?.id ?? "")
  const [sourceSkill, setSourceSkill] = useState<SkillSummary>()
  const [sourceContent, setSourceContent] = useState("")
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState("")
  const filtered = useMemo(() => filterSkills(skills, query), [query, skills])
  const groups = useMemo(() => groupSkills(filtered), [filtered])
  const selected = skills.find((skill) => skill.id === selectedId) ?? filtered[0] ?? skills[0]

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

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-[236px] shrink-0 flex-col border-r bg-sidebar p-2.5 sm:flex">
        <Button variant="ghost" className="mb-2 justify-start" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Workspace
        </Button>
        <div className="px-2 py-2 text-base font-semibold">Settings</div>
        <Button variant="secondary" className="justify-start">Skills</Button>
      </aside>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[740px] px-4 py-5 sm:px-8 sm:py-7">
          <Button variant="ghost" className="mb-3 -ml-2 sm:hidden" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            Workspace
          </Button>
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
              </div>
              <Alert className="mt-4">
                <FileTextIcon />
                <AlertTitle>Read-only discovery</AlertTitle>
                <AlertDescription>Domovoi reports where this skill was found. Installation, enablement, capability review, and fleet distribution are not changed here.</AlertDescription>
              </Alert>
              <Button variant="outline" className="mt-4" onClick={() => readSource(selected)}>
                <FileTextIcon data-icon="inline-start" />
                View SKILL.md
              </Button>
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
    </div>
  )
}
