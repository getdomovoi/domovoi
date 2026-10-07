import type { ApprovalRequest } from "@getdomovoi/protocol"

type Origin = NonNullable<ApprovalRequest["origin"]>
type OutsideProject = NonNullable<ApprovalRequest["outsideProject"]>

const originKind: Record<Origin["client"], string> = {
  desktop: "a desktop",
  web: "a browser",
  tablet: "a tablet",
  phone: "a phone",
  cli: "the command line",
}

// Who started the turn that raised this gate, as the daemon recorded it. The
// daemon never labels a broadcast card as "from you": each viewer compares the
// origin with the connection it holds now. A connection id is new on every
// reconnect, so a different one does not prove another client, and a client
// that does not know its own id yet cannot tell. Both name only the kind,
// which is true either way. No origin means the daemon did not record one.
export function approvalOriginLine(
  origin: Origin | undefined,
  connectionId: string | null | undefined,
  surface: "desktop" | "web",
): string | undefined {
  if (origin === undefined) return undefined
  if (connectionId && origin.connectionId === connectionId) {
    return `You started this turn from this ${surface === "desktop" ? "desktop" : "browser"}.`
  }
  return `This turn started from ${originKind[origin.client]}.`
}

// Containment covers only the path the request names or the directory it runs
// in, never everything a shell command reaches, so a working directory inside
// the project says no more than that. Copy as settled for the phone (Q17).
export function outsideProjectText(fact: OutsideProject): string {
  if (fact.basis === "path") return fact.outside ? "yes, by the path it names" : "no, by the path it names"
  return fact.outside ? "yes, by where it runs" : "no, by where it runs, not by what it reaches"
}
