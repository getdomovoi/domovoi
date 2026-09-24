import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

import { sessionDraftStore } from "./session-draft"

// Vitest runs without globals, so testing-library does not unmount between
// tests by itself. Without this, a suite that queries the whole document
// asserts against whatever an earlier test left mounted.
// The composer draft store deliberately outlives a render, so a session switch
// and a switch back returns what the person typed. That makes it shared state
// between tests, so every test starts from no draft.
afterEach(() => {
  cleanup()
  sessionDraftStore.clearAll()
})
