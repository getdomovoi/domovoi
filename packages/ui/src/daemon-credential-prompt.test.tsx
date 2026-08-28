import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { DaemonCredentialPrompt } from "./daemon-credential-prompt"

describe("DaemonCredentialPrompt", () => {
  it("asks for the private local daemon credential without persisting it", () => {
    const markup = renderToStaticMarkup(<DaemonCredentialPrompt onSubmit={vi.fn()} />)

    expect(markup).toContain("Connect to this daemon")
    expect(markup).toContain("~/.domovoi/daemon.token")
    expect(markup).toContain('type="password"')
    expect(markup).toContain("kept only for this browser session")
    expect(markup).toContain("Connect")
  })
})
