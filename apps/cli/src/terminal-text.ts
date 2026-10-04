// Text this CLI did not write itself (a machine name, a device label, a
// refusal reason, a path, an error message from the daemon or the socket) may
// carry control and formatting characters: the wire trims and bounds most
// such fields but does not refuse them. Printed raw, a newline splits one line
// into two and an escape sequence restyles the terminal. An unmatched
// bidirectional override or isolate reorders how the fields after it read in a
// bidi-aware terminal or log viewer, and U+2028 and U+2029 break the line in
// some viewers. So C0 controls, DEL, C1 controls, every Unicode Bidi_Control
// code point (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) and
// the line and paragraph separators are escaped: the shell escapes a reader
// knows (\n, \r, \t, \e) where one exists, otherwise \u{XX}, the JavaScript
// code point form. Each stays visible on the same line and names the character
// it replaced. Ordinary letters in any script, emoji, and the joiners U+200C
// and U+200D that spell some words and emoji sequences pass unchanged.
//
// The output holds none of the characters it escapes, so a second pass changes
// nothing and text escaped where it was composed is safe to escape again where
// it is printed. The CLI's own fixed text and line breaks are not passed
// through here; only the values interpolated into them are.
const namedControls: Record<number, string> = { 0x09: "\\t", 0x0a: "\\n", 0x0d: "\\r", 0x1b: "\\e" }

function shownEscaped(code: number): boolean {
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  if (code === 0x061c || code === 0x200e || code === 0x200f) return true
  if (code >= 0x2028 && code <= 0x202e) return true
  return code >= 0x2066 && code <= 0x2069
}

export function terminalSafe(text: string): string {
  let safe = ""
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    safe += shownEscaped(code) ? namedControls[code] ?? `\\u{${code.toString(16).padStart(2, "0")}}` : character
  }
  return safe
}

// What a failure prints to stderr. An error's message can quote the daemon, a
// socket or a path, so it is escaped like any other value; a message that
// spanned lines prints on one.
export function errorText(error: unknown): string {
  return terminalSafe(error instanceof Error ? error.message : String(error))
}
