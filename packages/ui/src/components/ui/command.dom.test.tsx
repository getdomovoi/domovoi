import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { Command, CommandInput } from "./command"

afterEach(cleanup)

// The shared input keeps its shadcn markup for every caller that does not ask
// for anything else; the snapshot holds it to the byte.
it("draws the default command input unchanged", () => {
  const { container } = render(<Command label="Commands"><CommandInput aria-label="Search" placeholder="Search" /></Command>)
  expect(container.querySelector("[data-slot=command-input-wrapper]")?.outerHTML.replace(/id="[^"]*"/gu, 'id=""').replace(/aria-controls="[^"]*"/gu, 'aria-controls=""').replace(/aria-labelledby="[^"]*"/gu, 'aria-labelledby=""')).toMatchInlineSnapshot(`"<div data-slot="command-input-wrapper" class="p-1 pb-0"><div data-slot="input-group" role="group" class="group/input-group relative flex h-8 w-full min-w-0 items-center rounded-lg border transition-colors outline-none in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 has-disabled:bg-input/50 has-disabled:opacity-50 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-3 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto has-[>[data-align=block-end]]:[&amp;>input]:pt-3 has-[>[data-align=block-start]]:[&amp;>input]:pb-3 has-[>[data-align=inline-end]]:[&amp;>input]:pr-1.5 has-[>[data-align=inline-start]]:[&amp;>input]:pl-1.5 h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!"><input data-slot="input-group-control" class="w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50" aria-label="Search" placeholder="Search" cmdk-input="" autocomplete="off" autocorrect="off" spellcheck="false" aria-autocomplete="list" role="combobox" aria-expanded="true" aria-controls="" aria-labelledby="" id="" type="text" value=""><div role="group" data-slot="input-group-addon" data-align="inline-start" class="flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&amp;>kbd]:rounded-[calc(var(--radius)-5px)] [&amp;>svg:not([class*='size-'])]:size-4 order-first pl-2 has-[>button]:ml-[-0.3rem] has-[>kbd]:ml-[-0.15rem]"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg></div></div></div>"`)
})

// The plain variant is Desktop V2's query row: a search mark and the field on
// the caller's own row, with no input-group fill or frame of its own.
it("draws the plain variant as a bare mark and field for the caller's row", () => {
  render(<Command label="Commands"><div data-testid="row"><CommandInput variant="plain" aria-label="Search" placeholder="Search" className="text-[14px]" /></div></Command>)
  const row = screen.getByTestId("row")
  expect(row.querySelector("[data-slot=command-input-wrapper]")).toBeNull()
  expect(row.querySelector("[data-slot=input-group]")).toBeNull()
  const field = screen.getByRole("combobox")
  expect(field.parentElement).toBe(row)
  expect(field.className).toContain("text-[14px]")
  expect(row.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
})
