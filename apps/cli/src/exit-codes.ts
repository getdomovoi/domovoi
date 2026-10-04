// The exit code table from the signed CLI transcripts design (J44), adopted
// whole before 1.0 under ruling Q391 A rather than only for the session
// commands. Stable across releases, so scripts can branch on them.
// Unconfirmed and failed never share a code. Nothing below 10 is about the
// session; 10 and up are what happened to it.
//
// not-paired is the one row the design does not draw: it folded an unpaired
// client into usage (2), and the ruling asks for a named code. It sits with
// the other "nothing was sent" codes.
//
// Codes 4 and 10 to 130 belong to session commands this binary does not have
// yet; they are reserved here so the numbers are fixed before those land.
//
// The design's row for 1 says a log path is printed. This CLI keeps no log,
// so that clause is left out rather than printed as a promise.
export const exitCodes = [
  { code: 0, name: "ok", when: "The command did what it said: session created, message sent, decision recorded, or the watched turn ended done.", by: "all" },
  { code: 1, name: "internal", when: "An unexpected error in the CLI. The message is printed.", by: "all" },
  { code: 2, name: "usage", when: "A bad flag, argument or quoting. Nothing was sent.", by: "all" },
  { code: 3, name: "daemon-unreachable", when: "Could not reach the daemon before doing anything. Nothing was sent.", by: "all" },
  { code: 4, name: "not-found", when: "No session or approval with that id on any reachable machine.", by: "send · watch · approve · deny" },
  { code: 5, name: "not-paired", when: "No credential is stored for that daemon. Nothing was sent.", by: "all but pair" },
  { code: 10, name: "gate-waiting", when: "watch --no-prompt reached a gate. The facts and approval id are printed.", by: "watch --no-prompt" },
  { code: 11, name: "turn-failed", when: "The agent ended the turn on a failure it reported.", by: "watch" },
  { code: 12, name: "refused-by-policy", when: "The turn stopped at a policy refusal.", by: "watch" },
  { code: 21, name: "connection-lost", when: "watch lost the daemon mid-turn and gave up reconnecting. Calls in flight are unconfirmed, not failed.", by: "watch" },
  { code: 22, name: "stopped-unconfirmed", when: "The turn stopped because a tool call has no recorded result.", by: "watch" },
  { code: 31, name: "already-decided", when: "Someone already answered this gate. The existing receipt is printed and nothing changes.", by: "approve · deny" },
  { code: 32, name: "not-permitted", when: "This device's credential can watch but not decide.", by: "approve · deny · watch" },
  { code: 33, name: "needs-a-person", when: "approve on a hard gate with no terminal attached. Nothing was approved.", by: "approve" },
  { code: 130, name: "detached", when: "Ctrl-C in watch. The session keeps running on its machine.", by: "watch" },
] as const

export type ExitCodeName = (typeof exitCodes)[number]["name"]

export function exitCode(name: ExitCodeName): number {
  return exitCodes.find((row) => row.name === name)!.code
}

// One line per code for --help: the number, the name, then when it is
// returned. The command column stays in the README, where it has room.
export function renderExitCodes(): string {
  const width = Math.max(...exitCodes.map((row) => row.name.length))
  return exitCodes.map((row) => `${String(row.code).padStart(3)}  ${row.name.padEnd(width)}  ${row.when}`).join("\n") + "\n"
}
