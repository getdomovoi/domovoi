import { describe, expect, it } from "vitest"

import { launchPhases } from "./launch-state"

describe("launchPhases", () => {
  it("names each phase while the keychain is being read", () => {
    expect(launchPhases({
      restoringCredential: true,
      hasCredential: false,
      hasSnapshot: false,
      status: "closed",
      fault: undefined,
      address: "",
    })).toEqual([
      { label: "Saved pairing", state: "checking keychain", tone: "active" },
      { label: "Configured route", state: "waiting for pairing", tone: "waiting" },
      { label: "Workspace", state: "waiting for route", tone: "waiting" },
    ])
  })

  it("names the configured route and its current attempt without an indeterminate state", () => {
    const phases = launchPhases({
      restoringCredential: false,
      hasCredential: true,
      hasSnapshot: false,
      status: "connecting",
      fault: undefined,
      address: "wss://mac-mini-m4.tailnet:47831/rpc",
    })
    expect(phases).toEqual([
      { label: "Saved pairing", state: "found", tone: "complete" },
      { label: "mac-mini-m4.tailnet", state: "trying tailnet route", tone: "active" },
      { label: "Workspace", state: "waiting for route", tone: "waiting" },
    ])
    expect(phases.map((phase) => phase.state).join(" ")).not.toMatch(/loading|spinner/i)
  })

  it("states a refusal on the route and never claims the workspace was read", () => {
    expect(launchPhases({
      restoringCredential: false,
      hasCredential: true,
      hasSnapshot: false,
      status: "closed",
      fault: { retriable: false, headline: "Credential refused", detail: "Pair again." },
      address: "ws://127.0.0.1:47831/rpc",
    })).toEqual([
      { label: "Saved pairing", state: "found", tone: "complete" },
      { label: "127.0.0.1", state: "refused", tone: "failed" },
      { label: "Workspace", state: "not read", tone: "waiting" },
    ])
  })
})
