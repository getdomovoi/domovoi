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

  // Q336 A: the command runs as printed, so where no link exists it names the
  // launcher inside the app.
  it("names the shipped launcher by its full path where no link exists", () => {
    const launcher = "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/bin/domovoid"
    const links = { available: true as const, directory: "~/.local/bin" as const, onPath: false, commands: [{ name: "domovoid" as const, launcher, state: "absent" as const }] }
    const markup = renderToStaticMarkup(<DesktopDaemonRefused reason="owner-incompatible" message={incompatible} retrying={false} onRetry={vi.fn()} links={links} />)
    expect(markup).toMatch(new RegExp(`<code[^>]*>${launcher.replaceAll(".", "\\.")} service install</code>`, "u"))
  })

  it("shows no command for any other refusal", () => {
    const markup = renderToStaticMarkup(<DesktopDaemonRefused reason="owner-busy" message="The local daemon is changing owners." retrying={false} onRetry={vi.fn()} />)
    expect(markup).not.toContain("domovoid service install")
  })
})
