export type TerminalQuickKey = {
  label: string
  ariaLabel: string
  data: string | { normal: string; application: string }
}

export const terminalQuickKeys: readonly TerminalQuickKey[] = [
  { label: "esc", ariaLabel: "Escape", data: "\u001b" },
  { label: "tab", ariaLabel: "Tab", data: "\t" },
  { label: "⌃C", ariaLabel: "Control C", data: "\u0003" },
  { label: "⌃D", ariaLabel: "Control D", data: "\u0004" },
  { label: "↑", ariaLabel: "Up arrow", data: { normal: "\u001b[A", application: "\u001bOA" } },
  { label: "↓", ariaLabel: "Down arrow", data: { normal: "\u001b[B", application: "\u001bOB" } },
  { label: "|", ariaLabel: "Pipe", data: "|" },
  { label: "~", ariaLabel: "Tilde", data: "~" },
  { label: "/", ariaLabel: "Slash", data: "/" },
]

export function terminalQuickKeyData(
  key: TerminalQuickKey,
  applicationCursorKeysMode: boolean,
): string {
  if (typeof key.data === "string") return key.data
  return applicationCursorKeysMode ? key.data.application : key.data.normal
}
