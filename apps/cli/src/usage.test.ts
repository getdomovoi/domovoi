import { describe, expect, it } from "vitest"

import { notPairedMessage, usage } from "./usage.js"

// `domovoid pair --client cli --label <label>` prints a one-time pairing
// code, not a credential, and `domovoi pair` refuses a code. The text says
// that, and where a client credential comes from today.
describe("pairing text", () => {
  it("does not send the person to a command that prints no credential", () => {
    expect(usage).not.toMatch(/It prints one\s+client credential/)
    expect(usage).toContain("'domovoid pair --client cli --label <device label>' prints a one-time\npairing code")
    expect(usage).toContain("'domovoi pair' refuses a code")
    expect(usage).toContain("a device.pair request made with the daemon's own credential")
  })

  it("says what pairing takes when a command finds no pairing", () => {
    const message = notPairedMessage("ws://127.0.0.1:47831/rpc", "/tmp/creds.json")
    expect(message).not.toContain("Run 'domovoid pair --client cli'")
    expect(message).toBe("Not paired with ws://127.0.0.1:47831/rpc. 'domovoi pair --daemon ws://127.0.0.1:47831/rpc --credential-file /tmp/creds.json' reads a client credential from stdin; 'domovoi --help' says where one comes from.\n")
    expect(notPairedMessage("ws://127.0.0.1:47831/rpc", undefined)).toContain("'domovoi pair --daemon ws://127.0.0.1:47831/rpc' reads")
  })
})
