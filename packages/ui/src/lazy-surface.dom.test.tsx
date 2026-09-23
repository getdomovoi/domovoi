import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Component, type ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { lazySurface, prefetchWhenIdle, SurfaceCodeReload } from "./lazy-surface"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

class Outer extends Component<{ children: ReactNode }, { error: Error | undefined }> {
  override state = { error: undefined as Error | undefined }
  static getDerivedStateFromError(error: Error) { return { error } }
  override render() { return this.state.error ? <p>outer caught: {this.state.error.message}</p> : this.props.children }
}

it("leaves a surface that loaded and then failed to draw to the boundary above, not the load frame", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  function Broken(): ReactNode { throw new Error("a row had no id") }
  const { Surface } = lazySurface("Skills", async () => Broken)
  await act(async () => { render(<Outer><Surface /></Outer>) })

  expect(await screen.findByText("outer caught: a row had no id")).toBeTruthy()
  expect(screen.queryByText(/did not load in this window/)).toBeNull()
})

it("fetches every surface when the scheduler runs, and not before", () => {
  const runs: Array<() => void> = []
  const surfaces = [{ prefetch: vi.fn() }, { prefetch: vi.fn() }]
  prefetchWhenIdle(surfaces, (run) => { runs.push(run); return () => {} })
  expect(surfaces[0]!.prefetch).not.toHaveBeenCalled()
  runs[0]!()
  expect(surfaces[0]!.prefetch).toHaveBeenCalledOnce()
  expect(surfaces[1]!.prefetch).toHaveBeenCalledOnce()
})

// On the web a failed chunk cannot be fetched again in the same page, so Try
// again reloads the page. It is the person's click that reloads, never the
// failure itself, so a build that keeps failing cannot reload in a loop.
it("reloads for new code on Try again where the host offers it, and only on Try again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const reload = vi.fn()
  const load = vi.fn(async (): Promise<() => ReactNode> => { throw new TypeError("Failed to fetch dynamically imported module") })
  const { Surface } = lazySurface("Skills", load)
  await act(async () => { render(<SurfaceCodeReload.Provider value={reload}><Surface /></SurfaceCodeReload.Provider>) })

  expect(await screen.findByText("Skills did not load in this window. Nothing on the machine changed.")).toBeTruthy()
  expect(reload).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  expect(reload).toHaveBeenCalledOnce()
  expect(load).toHaveBeenCalledOnce()
})

it("loads again on Try again where the host offers no reload", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  let failures = 1
  function Loaded(): ReactNode { return <h1>Machines</h1> }
  const load = vi.fn(async () => {
    if (failures-- > 0) throw new TypeError("Failed to fetch dynamically imported module")
    return Loaded
  })
  const { Surface } = lazySurface("Machines", load)
  await act(async () => { render(<Surface />) })

  await screen.findByText("Machines did not load in this window. Nothing on the machine changed.")
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })) })
  expect(await screen.findByRole("heading", { name: "Machines" })).toBeTruthy()
  expect(load).toHaveBeenCalledTimes(2)
})
