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
