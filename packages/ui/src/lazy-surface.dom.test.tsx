import { act, cleanup, render, screen } from "@testing-library/react"
import { Component, type ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { lazySurface, prefetchWhenIdle } from "./lazy-surface"

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
