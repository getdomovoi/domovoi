// Kilo's embedded server answers /permission/allow-everything. With the server
// password, which same-user processes can read from the Kilo process
// environment, a request writes an allow-every-tool rule to the global Kilo
// config. Kilo emits no permission event for it, the rule survives a server
// restart, and Kilo's built-in subagents then run commands and edits with no
// approval card. Domovoi cannot see that happen, so the daemon does not run
// Kilo for any reason: provider discovery reports it unable to start, no
// adapter is registered, and a stored session is refused. Owner ruling Q261 A,
// 2026-10-01. Set this to false to turn Kilo back on; the adapter in kilo.ts is
// kept for that. It is separate from acpProvidersTurnedOff, so turning either
// back on leaves the other off.
export const kiloTurnedOff = true

const allowEverything = "Kilo's server can switch on a rule that allows every tool, and it sends Domovoi no event "
  + "when that happens, so Domovoi cannot show an approval card before a tool runs."

export const kiloTurnedOffReason = `Kilo is turned off in Domovoi for now. ${allowEverything}`

export const kiloTurnedOffResumeRefusal = `This session uses Kilo, which is turned off in Domovoi for now. ${allowEverything} `
  + "The worktree and conversation are kept. Switch this session to another provider to continue."
