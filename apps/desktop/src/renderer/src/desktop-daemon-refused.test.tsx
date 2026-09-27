import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { DesktopDaemonRefused } from "./desktop-daemon-refused.js"

const incompatible = "The login service runs Domovoi 0.9.2, which this app cannot talk to. Update the service to match this app."

// Ruled 2026-09-24 (#577, C): this app cannot talk to the daemon that owns the
// profile, so it cannot check for running work and offers no update button.
// Under the ruled detail it shows the command that updates the service, as a
// line the person can copy, with no sentence around it.
describe("DesktopDaemonRefused", () => {
  it("shows the service install command under an incompatible owner's detail", () => {
    const markup = renderToStaticMarkup(<DesktopDaemonRefused reason="owner-incompatible" message={incompatible} retrying={false} onRetry={vi.fn()} />)
    expect(markup).toContain(incompatible)
    expect(markup).toMatch(/<code[^>]*>domovoid service install<\/code>/u)
    expect(markup).not.toContain("Update the service</button>")
  })

  it("shows no command for any other refusal", () => {
    const markup = renderToStaticMarkup(<DesktopDaemonRefused reason="owner-busy" message="The local daemon is changing owners." retrying={false} onRetry={vi.fn()} />)
    expect(markup).not.toContain("domovoid service install")
  })
})
