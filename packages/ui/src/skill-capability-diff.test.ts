import type { SkillEnablementReview, SkillSummary } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { skillReReviewSummary } from "./skill-capability-diff"

const review = (
  capabilities: SkillSummary["manifest"]["capabilities"],
  contentDigest = `sha256:${"a".repeat(64)}`,
): SkillEnablementReview => ({
  projectId: "project-acme",
  skillId: "skill-one",
  enabled: true,
  contentDigest,
  manifest: { version: 1, capabilities },
  reviewedAt: "2026-09-01T10:00:00.000Z",
  reviewedBy: { client: "desktop" },
} as SkillEnablementReview)

const skill = (
  capabilities: SkillSummary["manifest"]["capabilities"],
  contentDigest = `sha256:${"a".repeat(64)}`,
): SkillSummary => ({
  id: "skill-one",
  name: "release-notes",
  description: "Writes release notes",
  path: "/home/one/.domovoi/skills/release-notes",
  scope: "user",
  source: "domovoi",
  manifest: { version: 1, capabilities },
  contentDigest,
  signature: { state: "unsigned" },
  trust: { state: "untrusted", reason: "unsigned" },
} as unknown as SkillSummary)

const changed = `sha256:${"b".repeat(64)}`

// A skill can rewrite its whole description harmlessly, or add one line to its
// capabilities and become dangerous. The gained set is the risk, so it leads and
// nothing else is allowed to bury it.
describe("skill re-review summary", () => {
  it("leads with a capability the skill did not have before", () => {
    const summary = skillReReviewSummary(
      review(["filesystem.read"]),
      skill(["filesystem.read", "network.connect"], changed),
    )

    expect(summary.risk).toBe("capabilities-gained")
    expect(summary.gained).toEqual(["network.connect"])
    expect(summary.lost).toEqual([])
    expect(summary.headline).toBe("Asks for network.connect, which it did not have before")
  })

  it("names every gained capability rather than counting them", () => {
    const summary = skillReReviewSummary(
      review([]),
      skill(["network.connect", "secrets.read"], changed),
    )

    expect(summary.risk).toBe("capabilities-gained")
    expect(summary.headline).toBe("Asks for secrets.read and network.connect, which it did not have before")
  })

  // Reported in the capability enum's own order, so the same pair of manifests
  // always reads the same way and the more dangerous name is not buried by the
  // order it happened to be written in.
  it("orders gained capabilities by risk, not by declaration", () => {
    const summary = skillReReviewSummary(
      review([]),
      skill(["preview.render", "process.execute", "filesystem.write"], changed),
    )

    expect(summary.gained).toEqual(["process.execute", "filesystem.write", "preview.render"])
  })

  it("says plainly when a skill only gave capabilities up", () => {
    const summary = skillReReviewSummary(
      review(["filesystem.read", "network.connect"]),
      skill(["filesystem.read"], changed),
    )

    expect(summary.risk).toBe("capabilities-narrowed")
    expect(summary.lost).toEqual(["network.connect"])
    expect(summary.headline).toBe("Gives up network.connect and asks for nothing new")
  })

  // The common case, and the one the screen has to make fast. Someone who can
  // re-approve this in a second is someone who still reads the other three.
  it("makes the safe case a sentence rather than a diff to skim", () => {
    const summary = skillReReviewSummary(
      review(["filesystem.read"]),
      skill(["filesystem.read"], changed),
    )

    expect(summary.risk).toBe("instructions-only")
    expect(summary.gained).toEqual([])
    expect(summary.lost).toEqual([])
    expect(summary.instructionsChanged).toBe(true)
    expect(summary.headline).toBe("No capability change, instructions only")
  })

  it("reports a skill that has not changed at all", () => {
    const summary = skillReReviewSummary(review(["filesystem.read"]), skill(["filesystem.read"]))

    expect(summary.risk).toBe("unchanged")
    expect(summary.instructionsChanged).toBe(false)
    expect(summary.headline).toBe("Nothing has changed since the review")
  })

  // Both at once is still a gain. A capability given up never offsets one taken,
  // so the headline cannot average them into something reassuring.
  it("does not let a capability given up soften one gained", () => {
    const summary = skillReReviewSummary(
      review(["network.connect"]),
      skill(["secrets.read"], changed),
    )

    expect(summary.risk).toBe("capabilities-gained")
    expect(summary.gained).toEqual(["secrets.read"])
    expect(summary.lost).toEqual(["network.connect"])
    expect(summary.headline).toBe("Asks for secrets.read, which it did not have before")
  })

  // An unknown baseline is not a clean one. When nothing was recorded to compare
  // against, "no capability change" and "capabilities changed" are both claims
  // the screen cannot support, so it makes neither and says what is actually
  // true: this is a first review. The fast path stays fast and stays honest.
  it("calls an unrecorded baseline a first review rather than no change", () => {
    const summary = skillReReviewSummary(undefined, skill(["network.connect", "secrets.read"]))

    expect(summary.risk).toBe("first-review")
    expect(summary.gained).toEqual([])
    expect(summary.lost).toEqual([])
    expect(summary.headline)
      .toBe("First review: no previous declaration was recorded, so approve it as new")
  })

  it("does not report a first review as unchanged when the digests happen to match", () => {
    const summary = skillReReviewSummary(undefined, skill(["filesystem.read"]))

    expect(summary.risk).not.toBe("unchanged")
    expect(summary.risk).not.toBe("instructions-only")
  })

  // What this cannot answer, stated by the type rather than left to a reader.
  // The manifest is a flat list of capability ids with no scope inside them, so
  // "network.connect narrowed to one host" is not expressible, and the review
  // stores a digest rather than the bytes it reviewed, so the instruction change
  // is a boolean and never a line count.
  it("reports the limits of what the stored review can answer", () => {
    const summary = skillReReviewSummary(
      review(["network.connect"]),
      skill(["network.connect"], changed),
    )

    expect(summary.unanswerable).toEqual(["capability-scope", "instruction-extent"])
  })
})

// Scopes exist now. A capability whose id is unchanged can still widen from one
// host to every host, and that is a gain; a legacy declaration on either side
// means the scope question has no answer, which is not the same as "no change".
const scoped = (
  scopes: Array<{ capability: SkillSummary["manifest"]["capabilities"][number]; scope: unknown }>,
  contentDigest = `sha256:${"a".repeat(64)}`,
) => ({ version: 2 as const, capabilities: scopes.map((entry) => entry.capability), scopes, contentDigest })

const withManifest = <T extends SkillEnablementReview | SkillSummary>(base: T, manifest: unknown, contentDigest: string): T =>
  ({ ...base, manifest, contentDigest } as T)

const oneHost = { capability: "network.connect" as const, scope: { kind: "hosts" as const, hosts: ["api.example.com"] } }
const anyHost = { capability: "network.connect" as const, scope: { kind: "all" as const } }
const preview = { capability: "preview.render" as const, scope: { kind: "all" as const } }

describe("skill re-review summary with scopes", () => {
  it("treats a widened scope as a gain even when the capability ids match", () => {
    const before = scoped([oneHost])
    const after = scoped([anyHost], changed)
    const summary = skillReReviewSummary(
      withManifest(review(["network.connect"]), { version: 2, capabilities: before.capabilities, scopes: before.scopes }, before.contentDigest),
      withManifest(skill(["network.connect"]), { version: 2, capabilities: after.capabilities, scopes: after.scopes }, after.contentDigest),
    )

    expect(summary.risk).toBe("capabilities-gained")
    expect(summary.scopes.map((change) => [change.capability, change.change])).toEqual([["network.connect", "widened"]])
    expect(summary.headline).toMatch(/Widens network\.connect/)
    expect(summary.unanswerable).not.toContain("capability-scope")
  })

  it("does not let a dropped capability hide a widened one", () => {
    const before = scoped([oneHost, preview])
    const after = scoped([anyHost], changed)
    const summary = skillReReviewSummary(
      withManifest(review(["network.connect", "preview.render"]), { version: 2, capabilities: before.capabilities, scopes: before.scopes }, before.contentDigest),
      withManifest(skill(["network.connect"]), { version: 2, capabilities: after.capabilities, scopes: after.scopes }, after.contentDigest),
    )

    expect(summary.risk).toBe("capabilities-gained")
    expect(summary.lost).toEqual(["preview.render"])
  })

  it("calls a legacy declaration on either side unanswerable rather than clean", () => {
    const after = scoped([anyHost])
    const legacyBefore = skillReReviewSummary(
      review(["network.connect"]),
      withManifest(skill(["network.connect"]), { version: 2, capabilities: after.capabilities, scopes: after.scopes }, after.contentDigest),
    )
    expect(legacyBefore.risk).toBe("scope-unknown")
    expect(legacyBefore.unanswerable).toContain("capability-scope")

    const before = scoped([oneHost])
    const legacyAfter = skillReReviewSummary(
      withManifest(review(["network.connect"]), { version: 2, capabilities: before.capabilities, scopes: before.scopes }, before.contentDigest),
      skill(["network.connect"]),
    )
    expect(legacyAfter.risk).toBe("scope-unknown")
    expect(legacyAfter.headline).toMatch(/cannot be compared/)
  })

  it("reads a narrowed scope as giving something up", () => {
    const before = scoped([anyHost])
    const after = scoped([oneHost])
    const summary = skillReReviewSummary(
      withManifest(review(["network.connect"]), { version: 2, capabilities: before.capabilities, scopes: before.scopes }, before.contentDigest),
      withManifest(skill(["network.connect"]), { version: 2, capabilities: after.capabilities, scopes: after.scopes }, after.contentDigest),
    )

    expect(summary.risk).toBe("capabilities-narrowed")
    expect(summary.scopes.map((change) => change.change)).toEqual(["narrowed"])
  })
})
