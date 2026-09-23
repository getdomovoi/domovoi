import { afterEach } from "vitest"

import { sessionDraftStore } from "./session-draft"

// The composer draft store deliberately outlives a render, so a session switch
// and a switch back returns what the person typed. That makes it shared state
// between tests, so every test starts from no draft.
afterEach(() => { sessionDraftStore.clearAll() })
