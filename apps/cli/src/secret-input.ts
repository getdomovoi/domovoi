import { stdin } from "node:process"
import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"

// A terminal gets a prompt with echo off; a pipe is read as is. Either way
// one line, and nothing of it is written back. The prompt is written once,
// by hand, and readline's own output is discarded entirely: readline redraws
// the prompt together with the line on every edit, so any filter that lets
// the prompt through lets the secret through with it.
export async function readSecretLine(input: NodeJS.ReadStream = stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY) {
    let text = ""
    for await (const chunk of input) text += chunk.toString()
    return text
  }
  output.write("Paste the client credential: ")
  // readline gets a sink, not the terminal. Every redraw it would perform,
  // prompt and line together, goes nowhere; the terminal only ever sees the
  // prompt written above and the newline written below.
  const sink = new Writable({ write: (_chunk, _encoding, done) => done() })
  const reader = createInterface({ input, output: sink, terminal: true })
  try {
    return await reader.question("")
  } finally {
    output.write("\n")
    reader.close()
  }
}
