// Q336 A (2026-10-02): every command the app prints runs as printed. The
// desktop reports its ~/.local/bin links (apps/desktop/src/main/command-links.ts);
// this is the renderer's copy of that report's shape.
export type CommandName = "domovoid" | "domovoi"

export type CommandLinkView =
  | { available: false; reason: string; launchers?: { name: CommandName; launcher: string }[] }
  | {
      available: true
      directory: "~/.local/bin"
      onPath: boolean
      commands: { name: CommandName; launcher: string; state: "linked" | "absent" | "stale" | "other" }[]
    }

export type CommandLinkResult = { report: CommandLinkView; refused?: string }

const maximumText = 4_096
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= maximumText
const absolute = (value: unknown): value is string => text(value) && value.startsWith("/") && !/[\0\r\n]/u.test(value)
const commandName = (value: unknown): value is CommandName => value === "domovoid" || value === "domovoi"
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function invalid(): never {
  throw new Error("Desktop returned an invalid command link answer")
}

// The preload passes the desktop's answer through unchecked (its budget has
// no room for the check), so the renderer reads only the shape it knows.
export function parseCommandLinkResult(value: unknown): CommandLinkResult {
  if (!record(value) || !record(value.report)) return invalid()
  if (value.refused !== undefined && !text(value.refused)) return invalid()
  const refused = value.refused === undefined ? {} : { refused: value.refused }
  const report = value.report
  if (report.available === false) {
    if (!text(report.reason)) return invalid()
    if (report.launchers === undefined) return { report: { available: false, reason: report.reason }, ...refused }
    if (!Array.isArray(report.launchers)) return invalid()
    const launchers = report.launchers.map((entry: unknown) => {
      if (!record(entry) || !commandName(entry.name) || !absolute(entry.launcher)) return invalid()
      return { name: entry.name, launcher: entry.launcher }
    })
    return { report: { available: false, reason: report.reason, launchers }, ...refused }
  }
  if (report.available !== true || report.directory !== "~/.local/bin" || typeof report.onPath !== "boolean" || !Array.isArray(report.commands)) return invalid()
  const states = new Set(["linked", "absent", "stale", "other"])
  const commands = report.commands.map((entry: unknown) => {
    if (!record(entry) || !commandName(entry.name) || !absolute(entry.launcher) || typeof entry.state !== "string" || !states.has(entry.state)) return invalid()
    return { name: entry.name, launcher: entry.launcher, state: entry.state as "linked" | "absent" | "stale" | "other" }
  })
  return { report: { available: true, directory: "~/.local/bin", onPath: report.onPath, commands }, ...refused }
}

// A word a POSIX shell passes through unchanged; anything else is single
// quoted.
function shellWord(word: string): string {
  return /^[A-Za-z0-9_/.:@%+=,-]+$/u.test(word) ? word : `'${word.replace(/'/gu, "'\\''")}'`
}

// The command as the person should type it. Linked: the short name where
// ~/.local/bin is on the app's PATH, else the link by its path. Not linked:
// the launcher the app ships, by its full path. With no report (the web, a
// desktop that ships no launcher), the command as written.
export function printedCommand(command: string, view?: CommandLinkView): string {
  const [program, ...rest] = command.split(" ")
  if (program !== "domovoid" && program !== "domovoi") return command
  const tail = rest.length > 0 ? ` ${rest.join(" ")}` : ""
  if (!view) return command
  if (view.available) {
    const entry = view.commands.find((candidate) => candidate.name === program)
    if (!entry) return command
    if (entry.state === "linked") return view.onPath ? command : `~/.local/bin/${program}${tail}`
    return `${shellWord(entry.launcher)}${tail}`
  }
  const launcher = view.launchers?.find((candidate) => candidate.name === program)?.launcher
  return launcher ? `${shellWord(launcher)}${tail}` : command
}
