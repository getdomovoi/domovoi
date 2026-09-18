import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { startLikeRequest } from "./start-like"

function session(): WorkspaceSnapshot["sessions"][number] {
  const found = structuredClone(demoWorkspace).sessions[0]
  if (!found) throw new Error("fixture needs a session")
  return found
}

describe("startLikeRequest", () => {
  it("copies the machine's provider and model, and starts in Plan unless told otherwise", () => {
    const like = session()
    like.runtime = { ...like.runtime, permissionMode: "build", auto: true }

    const request = startLikeRequest(like, "Rotate the Stripe webhook secret across environments", "plan")

    expect(request.runtime).toEqual({ ...like.runtime, permissionMode: "plan", auto: false })
    expect(request.title).toBe("Rotate the Stripe webhook secret across environments")
    expect(request.prompt).toBe("Rotate the Stripe webhook secret across environments")
  })

  it("keeps the chosen mode and never carries auto into an unattended start", () => {
    expect(startLikeRequest(session(), "x", "build").runtime).toMatchObject({ permissionMode: "build", auto: false })
    expect(startLikeRequest(session(), "x", "ask").runtime).toMatchObject({ permissionMode: "ask", auto: false })
  })

  it("titles the session from the first line and bounds it", () => {
    const request = startLikeRequest(session(), "  First line here\nSecond line with detail  ", "plan")
    expect(request.title).toBe("First line here")
    expect(request.prompt).toBe("First line here\nSecond line with detail")

    const long = startLikeRequest(session(), "a".repeat(600), "plan")
    expect(long.title).toHaveLength(512)
  })
})
