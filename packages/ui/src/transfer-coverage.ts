import type { SessionTransferCoverage } from "@getdomovoi/protocol"

type Included = SessionTransferCoverage["included"][number]["kind"]
type Excluded = SessionTransferCoverage["excluded"][number]["kind"]
type Warning = SessionTransferCoverage["warnings"][number]["kind"]

// The daemon decides what a move carries, so the dialog names what it reports
// rather than a list written alongside it. A new coverage kind fails to compile
// here, which is the point: prose that drifts from the contract is how the
// dialog came to promise that secrets stayed behind.
const includedLabel: Record<Included, string> = {
  repository: "Repository, at the checkpoint commit",
  thread: "Thread, including tool and test history",
  checkpoints: "Checkpoints",
  artifacts: "Artifacts",
  "artifact-sources": "Artifact sources",
  annotations: "Annotations",
  "annotation-crops": "Annotation crops",
  "working-plan": "Working plan",
  usage: "Usage totals",
  "runtime-settings": "Runtime settings, including permission mode",
}

const excludedLabel: Record<Excluded, string> = {
  "provider-credentials": "Provider credentials",
  "provider-state": "Provider session state, which starts fresh there",
  terminals: "Running dev servers and terminals, which restart there",
  "approval-rules": "Standing approval rules, which are approved again there",
  "skill-authority": "Skills enabled for this project, which are reviewed again there",
  "audit-log": "Audit log, which stays on this machine",
  "ignored-files": "Ignored files, including ignored build output",
  "external-databases": "External databases",
  auto: "Automations",
}

const warningLabel: Record<Warning, string> = {
  "tracked-sensitive-files-may-travel":
    "A tracked or non-ignored file travels regardless of its name, including a committed .env or database file.",
  "promoted-ignored-artifacts":
    "Artifacts that were ignored here are promoted into the move, so they land on the target.",
  "provider-restart-required": "The provider has to be started again on the target.",
  "target-reapproval-required": "Approvals are granted again on the target before work resumes.",
}

function entryText(label: string, count: number | undefined): string {
  return count === undefined ? label : `${label} (${count})`
}

export function transferCoverageLists(coverage: SessionTransferCoverage): {
  included: string[]
  excluded: string[]
  warnings: string[]
} {
  return {
    included: coverage.included.map((entry) => entryText(includedLabel[entry.kind], entry.count)),
    excluded: coverage.excluded.map((entry) => entryText(excludedLabel[entry.kind], entry.count)),
    warnings: coverage.warnings.map((entry) => warningLabel[entry.kind]),
  }
}
