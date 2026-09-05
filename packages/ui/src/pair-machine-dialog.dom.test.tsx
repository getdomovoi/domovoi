import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { PairMachineDialog } from "./pair-machine-dialog.js"
import type { PairedMachine } from "./pair-machine.js"

afterEach(cleanup)

const paired: PairedMachine = {
  outcome: "enrolled",
  machineId: `machine-${"c".repeat(32)}`,
  label: "workshop",
  fleet: { entries: [] },
}

async function openDialog(onClaim = vi.fn(async () => paired)) {
  const user = userEvent.setup()
  const onPaired = vi.fn()
  render(<PairMachineDialog open onOpenChange={vi.fn()} onClaim={onClaim} onPaired={onPaired} />)
  return { user, onClaim, onPaired }
}

it("asks for the machine address, the code, and a name for this device", async () => {
  await openDialog()

  expect(screen.getByLabelText(/machine address/i)).toBeTruthy()
  expect(screen.getByLabelText(/pairing code/i)).toBeTruthy()
  expect(screen.getByLabelText(/name for this device/i)).toBeTruthy()
})

it("pairs with what was entered", async () => {
  const { user, onClaim, onPaired } = await openDialog()

  await user.type(screen.getByLabelText(/machine address/i), "wss://workshop.tailnet:47831/rpc")
  await user.type(screen.getByLabelText(/pairing code/i), "hearth-quiet-ember-42")
  await user.type(screen.getByLabelText(/name for this device/i), "studio-ipad")
  await user.click(screen.getByRole("button", { name: /pair machine/i }))

  await waitFor(() => expect(onClaim).toHaveBeenCalledWith({
    endpoint: "wss://workshop.tailnet:47831/rpc",
    code: "hearth-quiet-ember-42",
    label: "studio-ipad",
  }))
  await waitFor(() => expect(onPaired).toHaveBeenCalledWith(paired))
})

it("keeps no pairing code once the machine is paired", async () => {
  const { user } = await openDialog()

  await user.type(screen.getByLabelText(/machine address/i), "wss://workshop.tailnet:47831/rpc")
  await user.type(screen.getByLabelText(/pairing code/i), "hearth-quiet-ember-42")
  await user.type(screen.getByLabelText(/name for this device/i), "studio-ipad")
  await user.click(screen.getByRole("button", { name: /pair machine/i }))

  await waitFor(() => expect((screen.getByLabelText(/pairing code/i) as HTMLInputElement).value).toBe(""))
})

it("will not pair until every field is filled", async () => {
  const { user, onClaim } = await openDialog()

  await user.type(screen.getByLabelText(/machine address/i), "wss://workshop.tailnet:47831/rpc")
  await user.click(screen.getByRole("button", { name: /pair machine/i }))

  expect(onClaim).not.toHaveBeenCalled()
})

it("shows why a pairing was refused", async () => {
  const onClaim = vi.fn(async () => {
    throw new Error("Pairing was refused")
  })
  const { user } = await openDialog(onClaim)

  await user.type(screen.getByLabelText(/machine address/i), "wss://workshop.tailnet:47831/rpc")
  await user.type(screen.getByLabelText(/pairing code/i), "hearth-quiet-ember-42")
  await user.type(screen.getByLabelText(/name for this device/i), "studio-ipad")
  await user.click(screen.getByRole("button", { name: /pair machine/i }))

  expect(await screen.findByText("Pairing was refused")).toBeTruthy()
})

it("forgets the code when the parent closes it", async () => {
  const user = userEvent.setup()
  const view = render(
    <PairMachineDialog
      open
      onOpenChange={vi.fn()}
      onClaim={vi.fn(async () => paired)}
      onPaired={vi.fn()}
    />,
  )
  await user.type(screen.getByLabelText(/pairing code/i), "hearth-quiet-ember-42")

  view.rerender(
    <PairMachineDialog
      open={false}
      onOpenChange={vi.fn()}
      onClaim={vi.fn(async () => paired)}
      onPaired={vi.fn()}
    />,
  )
  view.rerender(
    <PairMachineDialog
      open
      onOpenChange={vi.fn()}
      onClaim={vi.fn(async () => paired)}
      onPaired={vi.fn()}
    />,
  )

  await waitFor(() => expect(
    (screen.getByLabelText(/pairing code/i) as HTMLInputElement).value,
  ).toBe(""))
})

it("says a code is used once and lasts minutes", async () => {
  await openDialog()

  expect(screen.getByText(/works once/i)).toBeTruthy()
})
