import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { FreshSessionSheet } from "./fresh-session-sheet"

const a = demoWorkspace.project!
const b = { ...a, id: "project-b", name: "Project B" }
const props = {
  open: true, projects: [a, b], projectId: b.id, machine: demoWorkspace.machine.name,
  starting: false, problem: "", disabledReason: undefined,
  onChooseProject: jest.fn<(id: string) => void>(),
  onStart: jest.fn<(prompt: string) => void>(), onClose: jest.fn<() => void>(),
}

describe("fresh session project picker", () => {
  it("opens active projects with machine sub-lines and no project close action", async () => {
    await render(<FreshSessionSheet {...props} />)
    await fireEvent.press(screen.getByRole("button", { name: "Project Project B" }))
    expect(screen.getByText("Choose a project")).toBeOnTheScreen()
    expect(screen.getAllByText(demoWorkspace.machine.name)).toHaveLength(2)
    await fireEvent.press(screen.getByRole("radio", { name: a.name }))
    expect(props.onChooseProject).toHaveBeenCalledWith(a.id)
    expect(screen.queryByRole("button", { name: /Close project/ })).toBeNull()
  })

  it.each([
    ["folder-missing", "folder not found"],
    ["folder-check-failed", "could not check the project folder"],
  ] as const)("shows and disables a %s project", async (unavailableReason, state) => {
    const onChooseProject = jest.fn<(id: string) => void>()
    await render(<FreshSessionSheet {...props} projects={[a, { ...b, unavailableReason }]} onChooseProject={onChooseProject} disabledReason="Cannot start here" />)
    await fireEvent.changeText(screen.getByLabelText("What to do"), "Go")
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled()
    await fireEvent.press(screen.getByRole("button", { name: "Project Project B" }))
    expect(screen.getByText(state)).toBeOnTheScreen()
    expect(screen.getByRole("radio", { name: b.name })).toBeDisabled()
    await fireEvent.press(screen.getByRole("radio", { name: b.name }))
    expect(onChooseProject).not.toHaveBeenCalled()
  })

  it("names the sole project without offering a picker", async () => {
    await render(<FreshSessionSheet {...props} projects={[a]} projectId={a.id} />)
    expect(screen.getByText(`Starts in “${a.name}” using the machine provider's default runtime.`)).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: `Project ${a.name}` })).toBeNull()
  })
})
