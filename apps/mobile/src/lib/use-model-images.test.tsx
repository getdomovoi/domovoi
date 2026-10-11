import { describe, expect, it, jest } from "@jest/globals"
import type { ProviderModel } from "@getdomovoi/protocol"
import { act, renderHook } from "@testing-library/react-native"

import type { DaemonCall, DaemonStatus } from "./daemon"
import { useModelImages } from "./use-model-images"

function model(provider: string, id: string, imageInput?: boolean): ProviderModel {
  return {
    provider, id, displayName: id, description: "", supportedReasoningEfforts: [], isDefault: false,
    ...(imageInput === undefined ? {} : { imageInput }),
  }
}

// One pending answer per call, settled by the test.
function daemon() {
  const answers: Array<{ resolve: (value: ProviderModel[]) => void, reject: (cause: Error) => void }> = []
  const call = jest.fn((method: string) => {
    if (method !== "runtime.models") return Promise.reject(new Error(`unexpected ${method}`))
    return new Promise<ProviderModel[]>((resolve, reject) => answers.push({ resolve, reject }))
  }) as unknown as DaemonCall & jest.Mock
  return { call, answers }
}

type Props = { status: DaemonStatus, runtime: { provider: string, model: string } | undefined }

function draw(call: DaemonCall, initial: Props) {
  return renderHook((props: Props) => useModelImages(call, props.status, "phone", props.runtime), { initialProps: initial })
}

const kilo = { provider: "kilo", model: "qwen3-coder-72b" }
const claude = { provider: "claude-code", model: "claude-sonnet-4.6" }

describe("useModelImages", () => {
  it("asks an open connection for the session provider's models", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "connecting", runtime: kilo })
    expect(call).not.toHaveBeenCalled()
    expect(hook.result.current).toEqual({ model: "qwen3-coder-72b", imageInput: undefined })

    await hook.rerender({ status: "open", runtime: kilo })
    expect(call).toHaveBeenCalledWith("runtime.models", { provider: "kilo", client: "phone" })
    await act(async () => answers[0]!.resolve([model("kilo", "qwen3-coder-72b", false)]))

    expect(hook.result.current).toEqual({ model: "qwen3-coder-72b", imageInput: false })
  })

  it("names nothing with no session open", async () => {
    const { call } = daemon()
    const hook = await draw(call, { status: "open", runtime: undefined })
    expect(call).not.toHaveBeenCalled()
    expect(hook.result.current).toBeUndefined()
  })

  it("stays not known when the daemon does not answer", async () => {
    const { call, answers } = daemon()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const hook = await draw(call, { status: "open", runtime: kilo })
    await act(async () => answers[0]!.reject(new Error("The daemon connection is not open")))

    expect(hook.result.current).toEqual({ model: "qwen3-coder-72b", imageInput: undefined })
    warn.mockRestore()
  })

  // Another session's provider asks again, and a late answer for the first
  // provider says nothing about the second session's model.
  it("asks again for another provider and drops a late answer for the old one", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "open", runtime: kilo })
    await hook.rerender({ status: "open", runtime: claude })
    expect(call).toHaveBeenLastCalledWith("runtime.models", { provider: "claude-code", client: "phone" })

    await act(async () => answers[1]!.resolve([model("claude-code", "claude-sonnet-4.6", true)]))
    await act(async () => answers[0]!.resolve([model("kilo", "qwen3-coder-72b", false)]))

    expect(hook.result.current).toEqual({ model: "claude-sonnet-4.6", imageInput: true })
  })

  // Codex review r1: an answer belongs to the connection and the provider it
  // was asked on. After a reconnect, or back on a provider asked before, the
  // old answer may no longer hold, so nothing is known until the new one lands
  // and nothing locks meanwhile.
  it("forgets an answer across a reconnect until the daemon answers again", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "open", runtime: kilo })
    await act(async () => answers[0]!.resolve([model("kilo", "qwen3-coder-72b", false)]))
    expect(hook.result.current?.imageInput).toBe(false)

    await hook.rerender({ status: "connecting", runtime: kilo })
    expect(hook.result.current?.imageInput).toBeUndefined()
    await hook.rerender({ status: "open", runtime: kilo })
    expect(hook.result.current?.imageInput).toBeUndefined()
    await act(async () => answers[1]!.resolve([model("kilo", "qwen3-coder-72b", true)]))
    expect(hook.result.current?.imageInput).toBe(true)
  })

  it("does not reuse an earlier provider's answer while asking it again", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "open", runtime: kilo })
    await act(async () => answers[0]!.resolve([model("kilo", "qwen3-coder-72b", false)]))
    await hook.rerender({ status: "open", runtime: claude })
    await hook.rerender({ status: "open", runtime: kilo })

    expect(hook.result.current).toEqual({ model: "qwen3-coder-72b", imageInput: undefined })
  })

  // A session on the same provider with another model reads the list it has.
  it("reads another model of the same provider from the answer it holds", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "open", runtime: kilo })
    await act(async () => answers[0]!.resolve([model("kilo", "qwen3-coder-72b", false), model("kilo", "kimi-vl", true)]))

    await hook.rerender({ status: "open", runtime: { provider: "kilo", model: "kimi-vl" } })
    expect(call).toHaveBeenCalledTimes(1)
    expect(hook.result.current).toEqual({ model: "kimi-vl", imageInput: true })
  })
})
