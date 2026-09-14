import { compareSkillDeclaredScopes, type SkillCapability, type SkillDeclaredScopeChange, type SkillEnablementReview, type SkillSummary } from "@getdomovoi/protocol"

// A skill can rewrite its whole description without becoming more dangerous, and
// add one capability and become dangerous without changing a paragraph. So a
// re-review leads with what changed about what the skill can *do*, and the prose
// diff is the last thing on the screen rather than the first.
export type SkillReReviewRisk =
  | "first-review"
  | "capabilities-gained"
  | "scope-unknown"
  | "capabilities-narrowed"
  | "instructions-only"
  | "unchanged"

// Two questions this may not be able to answer from what the daemon stores.
// Named here so a screen can say so rather than implying the answer is "no
// change".
//
// `capability-scope`: a version 2 manifest declares a scope per capability and
// `compareSkillDeclaredScopes` tells widened from narrowed. A version 1
// manifest on either side carries no scope, so `network.connect` from one host
// to any host is the same id before and after and the question has no answer.
//
// `instruction-extent`: this summary reads the review's content digest, not the
// bytes it covered, so the instruction change is a boolean here. The daemon
// retains the reviewed revision; this screen does not load it yet.
export type SkillReReviewUnanswerable = "capability-scope" | "instruction-extent"

export type SkillReReviewSummary = {
  risk: SkillReReviewRisk
  gained: readonly SkillCapability[]
  lost: readonly SkillCapability[]
  scopes: readonly SkillDeclaredScopeChange[]
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
      scopes: [],
      instructionsChanged: false,
      headline: "First review: no previous declaration was recorded, so approve it as new",
      // The headline already says there is nothing to compare against; naming
      // a scope limit here would claim a legacy declaration that may not exist.
      unanswerable: [],
    }
  }
  const gained = missingFrom(skill.manifest.capabilities, review.manifest.capabilities)
  const lost = missingFrom(review.manifest.capabilities, skill.manifest.capabilities)
  const comparison = compareSkillDeclaredScopes(review.manifest, skill.manifest)
  const scopes = comparison.state === "known" ? comparison.changes : []
  // A disjoint replacement gains and loses at once. It is a gain for the risk,
  // and the wording says the scope changed rather than claiming it only grew.
  const widened = scopes.filter((change) => change.change === "widened").map((change) => change.capability).sort(byRisk)
  const replaced = scopes.filter((change) => change.change === "changed").map((change) => change.capability).sort(byRisk)
  const narrowed = scopes.filter((change) => !change.gained).map((change) => change.capability).sort(byRisk)
  const instructionsChanged = review.contentDigest !== skill.contentDigest
  const unanswerable: SkillReReviewUnanswerable[] = []
  if (comparison.state === "unknown") unanswerable.push("capability-scope")
  if (instructionsChanged) unanswerable.push("instruction-extent")

  // A capability given up never offsets one taken, and a scope that widened is
  // a capability taken whatever its id says. Both at once is a gain, and the
  // headline says the gain, because averaging them reads as reassurance.
  if (gained.length > 0 || widened.length > 0 || replaced.length > 0) {
    const parts = []
    if (gained.length > 0) parts.push(`Asks for ${named(gained)}, which it did not have before`)
    if (widened.length > 0) parts.push(`${parts.length > 0 ? "widens" : "Widens"} ${named(widened)}`)
    if (replaced.length > 0) parts.push(`${parts.length > 0 ? "changes" : "Changes"} the scope of ${named(replaced)}`)
    return {
      risk: "capabilities-gained",
      gained,
      lost,
      scopes,
      instructionsChanged,
      headline: parts.join(", and "),
      unanswerable,
    }
  }
  // No id was gained, and whether a scope was is a question with no answer
  // because exactly one side declares scopes. That is not a clean result, so it
  // is not allowed to read like one. Two legacy declarations have no scopes to
  // compare on either side; the limit is stated and the ids decide.
  const legacyMixed = (review.manifest.version === 1) !== (skill.manifest.version === 1)
  if (legacyMixed) {
    return {
      risk: "scope-unknown",
      gained,
      lost,
      scopes,
      instructionsChanged,
      headline: "Capability scopes cannot be compared: one side is a legacy declaration, so review its scopes as new",
      unanswerable,
    }
  }
  if (lost.length > 0 || narrowed.length > 0) {
    const parts = []
    if (lost.length > 0) parts.push(`Gives up ${named(lost)}`)
    if (narrowed.length > 0) parts.push(`${lost.length > 0 ? "narrows" : "Narrows"} ${named(narrowed)}`)
    return {
      risk: "capabilities-narrowed",
      gained,
      lost,
      scopes,
      instructionsChanged,
      headline: `${parts.join(", and ")} and asks for nothing new`,
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
      scopes,
      instructionsChanged,
      headline: "No capability change, instructions only",
      unanswerable,
    }
  }
  return {
    risk: "unchanged",
    gained,
    lost,
    scopes,
    instructionsChanged,
    headline: "Nothing has changed since the review",
    unanswerable,
  }
}
