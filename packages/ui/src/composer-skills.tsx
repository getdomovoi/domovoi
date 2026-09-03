import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type SkillContextSnapshot = Pick<WorkspaceSnapshot, "project" | "skillEnablements">

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
}: {
  snapshot: SkillContextSnapshot
  skillNames: Record<string, string>
  onOpenSkills: () => void
}) {
  if (!snapshot.project) return null
  const enabled = enabledSkillIds(snapshot)
  const label = enabled.length === 1
    ? skillNames[enabled[0]!] ?? enabled[0]!
    : `${enabled.length} skills`

  return (
    <span className="flex items-center gap-1">
      {enabled.length > 0 ? (
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
