import { approvalPlanStep, type ApprovalRequest, type ClientKind, type WorkingPlan } from "@getdomovoi/protocol"

// Who is reading the gate. The daemon attributes a turn to the client that
// started it and never marks a broadcast card "from you", so each viewer
// compares the attribution with itself.
export type ApprovalViewer = {
  client: ClientKind
  // The paired device id the daemon holds for this phone's credential, read
  // from device.current. Undefined until that answer arrives, and for a
  // credential that is not a paired device's, such as a bearer token typed
  // into Settings. Without it the phone cannot tell itself from another phone.
  deviceId?: string | undefined
}

const clientNames: Record<ClientKind, string> = {
  desktop: "a desktop",
  web: "a browser",
  tablet: "a tablet",
  phone: "a phone",
  cli: "the command line",
}

// Paired devices are attributed by their device id, the same one
// device.current reports, so a turn this phone started stays its own across a
// reconnect, which a connection id would not.
export function approvalOriginLine(
  origin: ApprovalRequest["origin"],
  viewer: ApprovalViewer | undefined,
): string | undefined {
  if (origin === undefined) return undefined
  const sameKind = viewer?.client === origin.client
  if (!sameKind || viewer?.deviceId === undefined) return clientNames[origin.client]
  if (origin.clientId === viewer.deviceId) return `you, on this ${origin.client}`
  // An attribution without a client id names no device, so only two known
  // ids that differ make it another one.
  return origin.clientId === undefined ? clientNames[origin.client] : `another ${origin.client}`
}

// Each value names the basis it was judged on. A working directory inside the
// project says where the command starts, not what it can reach, so that one
// says so rather than reading as a contained command.
export function approvalOutsideProjectLine(
  fact: ApprovalRequest["outsideProject"],
): { value: string, outside: boolean } | undefined {
  if (fact === undefined) return undefined
  if (fact.basis === "path") {
    return { value: `${fact.outside ? "yes" : "no"}, by the path it names`, outside: fact.outside }
  }
  return fact.outside
    ? { value: "yes, by where it runs", outside: true }
    : { value: "no, by where it runs, not by what it reaches", outside: false }
}

// Read from the current plan rather than stored on the card, so an edited plan
// or a removed blocker cannot leave a stale number on screen.
export function approvalStepLine(
  plans: readonly WorkingPlan[] | undefined,
  approval: Pick<ApprovalRequest, "id" | "sessionId">,
): string | undefined {
  const position = approvalPlanStep(plans ?? [], approval)
  return position === undefined ? undefined : `step ${position.step} of ${position.of}`
}

export type ApprovalContextFact = { key: string, value: string, tone?: string }

// The facts the wire carries beside the request's own. A missing one is a fact
// the daemon could not decide, so it is left out rather than guessed.
export function approvalContextFacts(
  approval: ApprovalRequest,
  context: { plans?: readonly WorkingPlan[] | undefined, viewer?: ApprovalViewer | undefined },
): { origin?: ApprovalContextFact, step?: ApprovalContextFact, outsideProject?: ApprovalContextFact } {
  const origin = approvalOriginLine(approval.origin, context.viewer)
  const step = approvalStepLine(context.plans, approval)
  const outside = approvalOutsideProjectLine(approval.outsideProject)
  return {
    ...(origin === undefined ? {} : { origin: { key: "Turn from", value: origin } }),
    ...(step === undefined ? {} : { step: { key: "Plan", value: step } }),
    ...(outside === undefined ? {} : {
      outsideProject: { key: "Outside project", value: outside.value, ...(outside.outside ? { tone: "text-warning" } : {}) },
    }),
  }
}
