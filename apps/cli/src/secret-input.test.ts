import { PassThrough } from "node:stream"

import { describe, expect, it } from "vitest"

import { readSecretLine } from "./secret-input.js"

const secret = "t".repeat(43)
const backspace = String.fromCharCode(127)

function tty() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void }
  input.isTTY = true
  input.setRawMode = () => {}
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number }
  output.isTTY = true
  output.columns = 80
  let written = ""
  output.on("data", (chunk: Buffer) => { written += chunk.toString() })
  return { input, output, written: () => written }
}

describe("readSecretLine", () => {
  it("never echoes the secret, including on a redraw after backspace", async () => {
    const { input, output, written } = tty()
    const pending = readSecretLine(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream)
    input.write(secret.slice(0, 20))
    input.write(backspace)
    input.write(secret.slice(19))
    input.write("\n")
    expect(await pending).toBe(secret)
    expect(written()).toBe("Paste the client credential: \n")
  })

  it("reads a pipe as is", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean }
    input.isTTY = false
    const output = new PassThrough()
    let written = ""
    output.on("data", (chunk: Buffer) => { written += chunk.toString() })
    const pending = readSecretLine(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream)
    input.end(`Client credential: ${secret}\n`)
    expect(await pending).toBe(`Client credential: ${secret}\n`)
    expect(written).toBe("")
  })
})
