import { describe, expect, it } from "@jest/globals"
import { render, screen } from "@testing-library/react-native"

import { AgentMarkdown } from "./agent-markdown"

describe("an agent reply on a phone", () => {
  it("shows a command without its fence, and never shows the markers", async () => {
    await render(<AgentMarkdown body={"To do it yourself in zsh:\n\n```zsh\nprintf 'hello' > /tmp/x.txt\n```"} />)

    expect(screen.getByText("printf 'hello' > /tmp/x.txt")).toBeTruthy()
    expect(screen.queryByText(/```/)).toBeNull()
    expect(screen.getByText("To do it yourself in zsh:")).toBeTruthy()
  })

  it("shows inline code without its backticks", async () => {
    await render(<AgentMarkdown body="no `Write` tool available" />)

    expect(screen.getByText("Write")).toBeTruthy()
    expect(screen.queryByText(/`/)).toBeNull()
  })

  it("renders a bulleted report as bullets", async () => {
    await render(<AgentMarkdown body={"Passed.\n\n- 34 test files\n- 604 tests"} />)

    expect(screen.getByText("34 test files")).toBeTruthy()
    expect(screen.getByText("604 tests")).toBeTruthy()
  })
})
