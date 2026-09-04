import type { TurnSkillSelectionRefusal, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type SkillContextSnapshot = Pick<WorkspaceSnapshot, "project" | "skillEnablements">

const refusalCopy: Record<TurnSkillSelectionRefusal["reason"], string> = {
  "not-enabled": "is no longer enabled for this project",
  unavailable: "could not be read",
  "review-changed": "changed since you reviewed it",
  policy: "is excluded by this session's permission mode",
}

export function enabledSkillIds(snapshot: SkillContextSnapshot): string[] {
  const projectId = snapshot.project?.id
  if (!projectId) return []
  return snapshot.skillEnablements
    .filter((review) => review.projectId === projectId && review.enabled)
    .map((review) => review.skillId)
    .sort((left, right) => left.localeCompare(right))
}

export function ComposerSkillChip({
  snapshot,
  skillNames,
  onOpenSkills,
  selection,
  onSelectionChange,
  refusal,
}: {
  snapshot: SkillContextSnapshot
  skillNames: Record<string, string>
  onOpenSkills: () => void
  selection?: ReadonlySet<string> | undefined
  onSelectionChange?: ((selection: ReadonlySet<string>) => void) | undefined
  refusal?: TurnSkillSelectionRefusal | undefined
}) {
  if (!snapshot.project) return null
  const enabled = enabledSkillIds(snapshot)
  const label = enabled.length === 1
    ? skillNames[enabled[0]!] ?? enabled[0]!
    : `${enabled.length} skills`

  return (
    <span className="flex items-center gap-1">
      {enabled.length > 0 && onSelectionChange ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" className="rounded-full">{label}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[240px]">
            <DropdownMenuLabel>Skills this turn carries</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {enabled.map((skillId) => (
              <DropdownMenuCheckboxItem
                key={skillId}
                checked={selection ? selection.has(skillId) : true}
                onCheckedChange={(checked) => {
                  const next = new Set(selection ?? enabled)
                  if (checked) next.add(skillId)
                  else next.delete(skillId)
                  onSelectionChange(next)
                }}
              >
                {skillNames[skillId] ?? skillId}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : enabled.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className="rounded-full"
              onClick={onOpenSkills}
            >
              {label}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {enabled.length === 1
              ? "This project's reviewed skill travels with every turn."
              : "These reviewed skills travel with every turn."}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {refusal ? (
        <span
          role="status"
          aria-label="Skill selection refused"
          className="text-[10px] text-destructive"
        >
          {skillNames[refusal.skillId] ?? refusal.skillId} {refusalCopy[refusal.reason]}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="xs"
        className="rounded-full text-muted-foreground"
        aria-label="Add a skill to this turn"
        onClick={onOpenSkills}
      >
        + skill
      </Button>
    </span>
  )
}
