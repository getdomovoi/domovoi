import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CommandLinksProvider, CommandLinksRow, useCommandLinkView } from "./command-links"
import { printedCommand } from "./printed-command"

afterEach(cleanup)

const daemon = "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/bin/domovoid"
const cli = "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/bin/domovoi"
const report = (state: "linked" | "absent" | "other", onPath = false) => ({
  report: { available: true, directory: "~/.local/bin", onPath, commands: [{ name: "domovoid", launcher: daemon, state }, { name: "domovoi", launcher: cli, state }] },
})

function Printed() {
  return <span data-testid="printed">{printedCommand("domovoid service install", useCommandLinkView())}</span>
}

async function mount(answers: unknown[]) {
  const commandLinks = vi.fn(async () => {
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  })
  render(<CommandLinksProvider bridge={{ commandLinks }}><CommandLinksRow /><Printed /></CommandLinksProvider>)
  await act(async () => { await Promise.resolve() })
  return { commandLinks, user: userEvent.setup() }
}

// Q336 A: one reversible action links Domovoi's own commands, and every
// printed command runs as printed whether or not the link exists.
describe("terminal commands in Settings", () => {
  it("links both commands, then removes the links, and prints what runs", async () => {
    const { commandLinks, user } = await mount([report("absent"), report("linked"), report("absent")])
    expect(commandLinks).toHaveBeenCalledWith("status")
    expect(screen.getByText("Commands here name the copies inside this app by their full path. Linking puts domovoid and domovoi in ~/.local/bin, for your user only.")).toBeTruthy()
    expect(screen.getByTestId("printed").textContent).toBe(`${daemon} service install`)
    await user.click(screen.getByRole("button", { name: "Link the commands" }))
    expect(commandLinks).toHaveBeenLastCalledWith("link")
    expect(await screen.findByText("domovoid and domovoi are linked in ~/.local/bin. That directory is not on this app's PATH, so commands here name the links by their path.")).toBeTruthy()
    expect(screen.getByTestId("printed").textContent).toBe("~/.local/bin/domovoid service install")
    await user.click(screen.getByRole("button", { name: "Remove the links" }))
    expect(commandLinks).toHaveBeenLastCalledWith("unlink")
    expect(await screen.findByRole("button", { name: "Link the commands" })).toBeTruthy()
  })

  it("shows why linking is not offered, and still prints the shipped launcher", async () => {
    const reason = "~/.local/bin is a link to another directory, so Domovoi does not read or write there."
    await mount([{ report: { available: false, reason, launchers: [{ name: "domovoid", launcher: daemon }] } }])
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Link the commands" })).toBeNull()
    expect(screen.getByTestId("printed").textContent).toBe(`${daemon} service install`)
  })

  it("shows a refusal and an entry it will not touch", async () => {
    const refused = "~/.local/bin/domovoi is not a link Domovoi made, so it was left as it is."
    const { user } = await mount([report("absent"), { ...report("other"), refused }])
    await user.click(screen.getByRole("button", { name: "Link the commands" }))
    expect(await screen.findByText(refused)).toBeTruthy()
  })

  // Review P3-A: a domovoid that is not Domovoi's link must not strand the
  // domovoi link beside it. Linking would only refuse, so removing is what
  // is offered.
  it("offers to remove a link while another command is not Domovoi's", async () => {
    const partly = { report: { available: true, directory: "~/.local/bin", onPath: true, commands: [{ name: "domovoid", launcher: daemon, state: "other" }, { name: "domovoi", launcher: cli, state: "linked" }] } }
    const removed = { report: { available: true, directory: "~/.local/bin", onPath: true, commands: [{ name: "domovoid", launcher: daemon, state: "other" }, { name: "domovoi", launcher: cli, state: "absent" }] } }
    const { commandLinks, user } = await mount([partly, removed])
    expect(screen.getByText("domovoi is linked in ~/.local/bin. Commands here name the copy of domovoid inside this app by its full path.")).toBeTruthy()
    expect(screen.getByText("~/.local/bin/domovoid is not a link Domovoi made, so it was left as it is.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Link the commands" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Remove the links" }))
    expect(commandLinks).toHaveBeenLastCalledWith("unlink")
    expect(await screen.findByRole("button", { name: "Link the commands" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Remove the links" })).toBeNull()
  })

  // A command the runtime added since linking can be linked, and the one
  // already linked can still be removed.
  it("offers both actions while one command is linked and another is not", async () => {
    const partly = { report: { available: true, directory: "~/.local/bin", onPath: false, commands: [{ name: "domovoid", launcher: daemon, state: "linked" }, { name: "domovoi", launcher: cli, state: "absent" }] } }
    const { commandLinks, user } = await mount([partly, report("linked")])
    expect(screen.getByText("domovoid is linked in ~/.local/bin. Commands here name the copy of domovoi inside this app by its full path.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove the links" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Link the commands" }))
    expect(commandLinks).toHaveBeenLastCalledWith("link")
    expect(await screen.findByText("domovoid and domovoi are linked in ~/.local/bin. That directory is not on this app's PATH, so commands here name the links by their path.")).toBeTruthy()
  })

  it("says when the desktop's answer could not be read, and prints the plain command", async () => {
    await mount([{ nonsense: true }])
    expect(screen.getByText("Could not read the command links: Desktop returned an invalid command link answer")).toBeTruthy()
    expect(screen.getByTestId("printed").textContent).toBe("domovoid service install")
  })

  it("draws nothing without a desktop that can link", () => {
    render(<CommandLinksRow />)
    expect(screen.queryByRole("region")).toBeNull()
    expect(document.body.textContent).toBe("")
  })
})
