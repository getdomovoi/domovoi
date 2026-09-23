import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { WebConnectPage } from "./web-connect-page"

afterEach(cleanup)

const base = { host: "mac-mini-m4.tail4c2e.ts.net", secure: true, pending: false, onPair: vi.fn(), onOpenLimits: vi.fn() }

it("asks for the daemon's word code and locks Pair until the code is complete", async () => {
  const user = userEvent.setup()
  const onPair = vi.fn()
  render(<WebConnectPage {...base} onPair={onPair} />)
  expect(screen.getByText("Connect this browser to")).toBeTruthy()
  expect(screen.getByText("mac-mini-m4.tail4c2e.ts.net")).toBeTruthy()
  expect(screen.getByText("Type the web code shown on the machine, in Settings under Phone and tablet.")).toBeTruthy()
  expect(screen.getByText("Works once, for 180 seconds")).toBeTruthy()
  const field = screen.getByRole("textbox", { name: "Web code" })
  expect(field.getAttribute("placeholder")).toBe("word-word-word-00")
  const pair = screen.getByRole("button", { name: "Pair this browser" })
  expect(pair.hasAttribute("disabled")).toBe(true)
  expect(screen.getByText("Locked until the code is complete")).toBeTruthy()
  await user.type(field, "hearth-quiet-ember-42")
  expect(screen.getByText("Pairs this tab only")).toBeTruthy()
  await user.click(pair)
  expect(onPair).toHaveBeenCalledWith("hearth-quiet-ember-42")
})

it("says how this tab is trusted, and that the credential lives in the tab", () => {
  render(<WebConnectPage {...base} />)
  const facts = screen.getByRole("list", { name: "HOW THIS TAB IS TRUSTED" })
  expect(within(facts).getByText("This page came from the daemon at mac-mini-m4.tail4c2e.ts.net. No Domovoi server is in the path.")).toBeTruthy()
  expect(within(facts).getByText("The credential lives in this tab only. Close the tab and you pair again.")).toBeTruthy()
  expect(within(facts).getByText("Previews open in a sandboxed frame that cannot reach this page.")).toBeTruthy()
  expect(within(facts).getByText("This page and the daemon must speak the same protocol version. After a daemon update, reload.")).toBeTruthy()
})

it("names a reopened tab and a code filled from the address bar", () => {
  render(<WebConnectPage {...base} reopened initialCode="hearth-quiet-ember-42" fromUrl />)
  expect(screen.getByText("Pair this browser again with")).toBeTruthy()
  expect(screen.getByText("This tab has no credential")).toBeTruthy()
  expect(screen.getByText("sessionStorage · cleared when the last tab closed")).toBeTruthy()
  expect(screen.getByText("Domovoi keeps a browser credential for one tab session, so a reopened tab pairs again. Nothing on the machine stopped.")).toBeTruthy()
  expect(screen.getByText("Filled from the QR on the machine. Removed from the address bar when this page loaded.")).toBeTruthy()
  expect((screen.getByRole("textbox", { name: "Web code" }) as HTMLInputElement).value).toBe("hearth-quiet-ember-42")
})

it("draws the outcome the daemon gave, with its own action", async () => {
  const user = userEvent.setup()
  const act = vi.fn()
  render(<WebConnectPage {...base} outcome={{ tone: "danger", pill: "refused", title: "That code was refused", mono: "pair.refused · works once", body: "Show another on the machine.", action: { label: "Type a new code", run: act } }} />)
  expect(screen.getByText("That code was refused")).toBeTruthy()
  expect(screen.getByText("pair.refused · works once")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Type a new code" }))
  expect(act).toHaveBeenCalledOnce()
})
