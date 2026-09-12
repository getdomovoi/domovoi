import { skillInstallPreviewSchema, skillSummarySchema } from "@getdomovoi/protocol"

import type { RpcCall } from "./pair.js"

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SkillInstallError"
  }
}

// Preview first, always. The daemon reads the files, computes the digests and
// says what it would refuse; the install then names the exact sourceDigest it
// previewed, so a file that changed between the two is refused by the daemon
// rather than installed unseen.
export async function previewSkill(input: { call: RpcCall; path: string }) {
  return skillInstallPreviewSchema.parse(await input.call("skill.installPreview", { source: { kind: "path", path: input.path } }))
}

export function renderPreview(preview: ReturnType<typeof skillInstallPreviewSchema.parse>, scope: "project" | "user"): string {
  const lines = [
    `skill      ${preview.name}: ${preview.description}`,
    `files      ${preview.files.length} (${preview.files.reduce((total, file) => total + file.bytes, 0)} bytes)`,
    // Two digests, two meanings: content is what the skill's files hash to,
    // source is what the daemon pins on install so a changed directory is
    // refused. Both are shown because both are decisions.
    `content    ${preview.contentDigest}`,
    `source     ${preview.sourceDigest}`,
    `signature  ${preview.signature.state}`,
    `trust      ${preview.trust.state}`,
  ]
  const target = preview.targets.find((entry) => entry.scope === scope)
  lines.push(target ? `target     ${scope}: ${target.path} (${target.state})` : `target     ${scope}: not offered by the daemon`)
  for (const refusal of preview.refusals) lines.push(`refused    ${refusal.reason}${"path" in refusal && refusal.path ? ` ${String(refusal.path)}` : ""}`)
  return `${lines.join("\n")}\n`
}

export async function installSkill(input: { call: RpcCall; path: string; scope: "project" | "user"; preview: ReturnType<typeof skillInstallPreviewSchema.parse> }) {
  if (input.preview.refusals.length > 0) throw new SkillInstallError(`The daemon refuses this skill: ${input.preview.refusals.map((refusal) => refusal.reason).join(", ")}`)
  const target = input.preview.targets.find((entry) => entry.scope === input.scope)
  if (!target) throw new SkillInstallError(`The daemon offers no ${input.scope} target for this skill`)
  if (target.state === "conflict") throw new SkillInstallError(`A different skill already occupies ${target.path}`)
  return skillSummarySchema.parse(await input.call("skill.install", {
    source: { kind: "path", path: input.path }, scope: input.scope, sourceDigest: input.preview.sourceDigest,
  }))
}
