import { describe, expect, it, jest } from "@jest/globals"
import { deviceCurrentResultSchema, type DeviceCurrent } from "@getdomovoi/protocol"
import { act, renderHook } from "@testing-library/react-native"

import type { DaemonCall, DaemonStatus } from "./daemon"
import { useDeviceIdentity } from "./use-device-identity"

const machineId = `machine-${"a".repeat(32)}`
const deviceId = "device-0123456789abcdef0123456789abcdef"

function paired(id = deviceId): DeviceCurrent {
  return deviceCurrentResultSchema.parse({ kind: "client", machineId, deviceId: id, client: "phone", clientAccess: "full" })
}

// One pending answer per call, settled by the test, so the order of answers
// and credential changes is the test's to choose.
function daemon() {
  const answers: Array<{ resolve: (value: DeviceCurrent) => void, reject: (cause: Error) => void }> = []
  const call = jest.fn((method: string) => {
    if (method !== "device.current") return Promise.reject(new Error(`unexpected ${method}`))
    return new Promise<DeviceCurrent>((resolve, reject) => answers.push({ resolve, reject }))
  }) as unknown as DaemonCall & jest.Mock
  return { call, answers }
}

type Props = { status: DaemonStatus, credential: string | undefined }

function draw(call: DaemonCall, initial: Props) {
  return renderHook((props: Props) => useDeviceIdentity(call, props.status, props.credential), { initialProps: initial })
}

describe("useDeviceIdentity", () => {
  it("asks only an open connection which device it is", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "connecting", credential: "token-a" })
    expect(call).not.toHaveBeenCalled()

    await hook.rerender({ status: "open", credential: "token-a" })
    expect(call).toHaveBeenCalledWith("device.current", {})
    await act(async () => answers[0]!.resolve(paired()))

    expect(hook.result.current).toBe(deviceId)
  })

  it("has no device id for a credential that is not a paired device's", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "open", credential: "token-a" })
    await act(async () => answers[0]!.resolve(deviceCurrentResultSchema.parse({ kind: "daemon", machineId })))

    expect(hook.result.current).toBeUndefined()
  })

  it("stays unknown when the daemon does not answer", async () => {
    const { call, answers } = daemon()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const hook = await draw(call, { status: "open", credential: "token-a" })
    await act(async () => answers[0]!.reject(new Error("The daemon connection is not open")))

    expect(hook.result.current).toBeUndefined()
    warn.mockRestore()
  })

  // A new credential may be another machine's pairing. Until that machine
  // answers, the old id says nothing about this connection.
  it("forgets the id when the credential changes, and ignores a late answer for the old one", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "open", credential: "token-a" })
    await act(async () => answers[0]!.resolve(paired()))
    expect(hook.result.current).toBe(deviceId)

    await hook.rerender({ status: "connecting", credential: "token-b" })
    expect(hook.result.current).toBeUndefined()
    await hook.rerender({ status: "open", credential: "token-b" })
    await hook.rerender({ status: "open", credential: "token-c" })
    // token-c's answer lands first; token-b's arrives late and must not
    // replace it (review r1: the old order let a dropped guard pass).
    const deviceC = "device-cccccccccccccccccccccccccccccccc"
    await act(async () => answers[2]!.resolve(paired(deviceC)))
    expect(hook.result.current).toBe(deviceC)
    await act(async () => answers[1]!.resolve(paired("device-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")))

    expect(hook.result.current).toBe(deviceC)
  })

  // A reconnect on the same credential is the same device, so the id it
  // already has stays while the connection comes back.
  it("keeps the id across a reconnect on the same credential", async () => {
    const { call, answers } = daemon()
    const hook = await draw(call, { status: "open", credential: "token-a" })
    await act(async () => answers[0]!.resolve(paired()))

    await hook.rerender({ status: "connecting", credential: "token-a" })
    expect(hook.result.current).toBe(deviceId)
    await hook.rerender({ status: "open", credential: "token-a" })
    expect(call).toHaveBeenCalledTimes(2)
    await act(async () => answers[1]!.resolve(paired()))

    expect(hook.result.current).toBe(deviceId)
  })
})
