import { join } from "node:path"

import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { approvalFacts } from "./approval-facts.js"
import { codexSecretLocations } from "./codex.js"
import { credentialStores } from "./credential-stores.js"
import { permissionDecisionFor } from "./permission-policy.js"

const workspace = join("/", "worktrees", "session-1")

describe("credentialStores", () => {
  it("is the list of locations the Codex sandbox refuses", () => {
    expect(codexSecretLocations).toEqual(credentialStores.map(({ location }) => location))
  })

  it.each(credentialStores.map((store) => [store.location, store] as const))(
    "hides and hard-gates %s on the approval card and on the command line",
    (_location, store) => {
      const path = `/home/u/${store.cardName ?? store.location.slice(2)}`
      expect(approvalFacts({ workspace, path, scope: undefined })).toMatchObject({
        affects: "The file [REDACTED], outside the session worktree.",
        sensitive: true,
      })
      expect(permissionDecisionFor({
        runtime: structuredClone(demoWorkspace.sessions[0]!.runtime),
        command: `cat ${path}`,
      })).toEqual({ action: "review", risk: "hard-gate" })
    },
  )
})
