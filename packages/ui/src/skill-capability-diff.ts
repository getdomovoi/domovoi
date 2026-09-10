import type { SkillCapability, SkillEnablementReview, SkillSummary } from "@getdomovoi/protocol"

// A skill can rewrite its whole description without becoming more dangerous, and
// add one capability and become dangerous without changing a paragraph. So a
// re-review leads with what changed about what the skill can *do*, and the prose
// diff is the last thing on the screen rather than the first.
export type SkillReReviewRisk =
  | "first-review"
  | "capabilities-gained"
  | "capabilities-narrowed"
  | "instructions-only"
  | "unchanged"

// Two questions this cannot answer from what the daemon stores. Named here so a
// screen can say so rather than implying the answer is "no change".
//
// `capability-scope`: the manifest is a flat list of capability ids
// (`skillCapabilityManifestSchema`), so a capability has no scope inside it.
// `network.connect` narrowed from one host to any, or `process.execute` from one
// command to every command, is the same id before and after.
//
// `instruction-extent`: `skillEnablementReviewSchema` keeps a content digest and
// not the bytes it covered, so the instruction change is a boolean. Nobody can
// render the diff or count its lines without the reviewed revision.
export type SkillReReviewUnanswerable = "capability-scope" | "instruction-extent"

export type SkillReReviewSummary = {
  risk: SkillReReviewRisk
  gained: readonly SkillCapability[]
  lost: readonly SkillCapability[]
  instructionsChanged: boolean
  headline: string
  unanswerable: readonly SkillReReviewUnanswerable[]
}

// Reported worst-first rather than in the order a manifest happened to list
// them, so the same pair of manifests always reads the same way and the name
// that should stop someone is never third on the line.
const capabilityRisk: readonly SkillCapability[] = [
  "process.execute",
  "secrets.read",
  "filesystem.write",
  "network.connect",
  "filesystem.read",
  "preview.render",
]

function byRisk(left: SkillCapability, right: SkillCapability): number {
  return capabilityRisk.indexOf(left) - capabilityRisk.indexOf(right)
}

function missingFrom(
  candidates: readonly SkillCapability[],
  present: readonly SkillCapability[],
): SkillCapability[] {
  const held = new Set(present)
  return candidates.filter((capability) => !held.has(capability)).sort(byRisk)
}

function named(capabilities: readonly SkillCapability[]): string {
  if (capabilities.length <= 1) return capabilities[0] ?? ""
  return `${capabilities.slice(0, -1).join(", ")} and ${capabilities.at(-1)}`
}

// An unknown baseline is not a clean one. With nothing recorded to compare
// against, "no capability change" and "capabilities changed" are both claims
// this cannot support, so it makes neither: it says the previous declaration was
// never recorded and this is a first review, to be approved as new. The same
// branch is where an unknown legacy capability scope belongs once scopes exist,
// for the same reason — a missing baseline must never read as a clean one.
export function skillReReviewSummary(
  review: SkillEnablementReview | undefined,
  skill: SkillSummary,
): SkillReReviewSummary {
  if (!review) {
    return {
      risk: "first-review",
      gained: [],
      lost: [],
      instructionsChanged: false,
      headline: "First review: no previous declaration was recorded, so approve it as new",
      unanswerable: ["capability-scope"],
    }
  }
  const gained = missingFrom(skill.manifest.capabilities, review.manifest.capabilities)
  const lost = missingFrom(review.manifest.capabilities, skill.manifest.capabilities)
  const instructionsChanged = review.contentDigest !== skill.contentDigest
  const unanswerable: SkillReReviewUnanswerable[] = ["capability-scope"]
  if (instructionsChanged) unanswerable.push("instruction-extent")

  // A capability given up never offsets one taken. Both at once is a gain, and
  // the headline says the gain, because averaging them reads as reassurance.
  if (gained.length > 0) {
    return {
      risk: "capabilities-gained",
      gained,
      lost,
      instructionsChanged,
      headline: `Asks for ${named(gained)}, which it did not have before`,
      unanswerable,
    }
  }
  if (lost.length > 0) {
    return {
      risk: "capabilities-narrowed",
      gained,
      lost,
      instructionsChanged,
      headline: `Gives up ${named(lost)} and asks for nothing new`,
      unanswerable,
    }
  }
  // The common case, and the one worth making fast. Someone who can re-approve
  // this in a second is someone who still reads the other three, which is what
  // stops the dangerous case being waved through out of habit.
  if (instructionsChanged) {
    return {
      risk: "instructions-only",
      gained,
      lost,
      instructionsChanged,
      headline: "No capability change, instructions only",
      unanswerable,
    }
  }
  return {
    risk: "unchanged",
    gained,
    lost,
    instructionsChanged,
    headline: "Nothing has changed since the review",
    unanswerable,
  }
}
