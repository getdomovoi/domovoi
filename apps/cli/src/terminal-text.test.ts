import { describe, expect, it } from "vitest"

import { errorText, terminalSafe } from "./terminal-text.js"

// Built from code points so the source shows which invisible character each is.
const rlo = String.fromCodePoint(0x202e)

describe("terminalSafe", () => {
  it("shows a newline, an escape sequence and a directional override escaped, on one line", () => {
    const shown = terminalSafe(`dana\nallowed\u001b[31m red${rlo}enohp`)
    expect(shown).toBe("dana\\nallowed\\e[31m red\\u{202e}enohp")
    for (const raw of ["\n", "\u001b", rlo]) expect(shown).not.toContain(raw)
  })

  it("uses the shell escape a reader knows where one exists, otherwise the code point", () => {
    expect(terminalSafe("a\tb\r\u0000\u007f\u0080\u009b")).toBe("a\\tb\\r\\u{00}\\u{7f}\\u{80}\\u{9b}")
  })

  it("shows every Bidi_Control code point and both line separators escaped", () => {
    const raw = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029]
    expect(terminalSafe(String.fromCodePoint(...raw)))
      .toBe("\\u{61c}\\u{200e}\\u{200f}\\u{202a}\\u{202b}\\u{202c}\\u{202d}\\u{202e}\\u{2066}\\u{2067}\\u{2068}\\u{2069}\\u{2028}\\u{2029}")
  })

  it("leaves letters in any script, emoji sequences, joiners and paths unchanged", () => {
    const zwj = String.fromCodePoint(0x200d)
    const zwnj = String.fromCodePoint(0x200c)
    const text = `${String.fromCodePoint(0x1f469)}${zwj}${String.fromCodePoint(0x1f4bb)} דנה دانة می${zwnj}خواهم café ☕ C:\\Users\\dana /home/dana/my skill`
    expect(terminalSafe(text)).toBe(text)
  })

  it("is unchanged by a second pass, so text escaped once is never escaped twice", () => {
    const once = terminalSafe(`a\nb\u001b${rlo}`)
    expect(terminalSafe(once)).toBe(once)
  })
})

describe("errorText", () => {
  it("shows the message of an error, or anything thrown, escaped", () => {
    expect(errorText(new Error(`Could not reach ws://x/\n\u001b[2J${rlo}`))).toBe("Could not reach ws://x/\\n\\e[2J\\u{202e}")
    expect(errorText(`thrown\ntext`)).toBe("thrown\\ntext")
    expect(errorText(new Error("The daemon at ws://127.0.0.1:47831/rpc did not answer café within 100 ms")))
      .toBe("The daemon at ws://127.0.0.1:47831/rpc did not answer café within 100 ms")
  })
})
