import { callDaemonOnce } from "../src/cli-rpc.ts"
import { OperationDeadline, OperationDeadlineExceededError } from "../src/operation-deadline.ts"

// For refusal, the parent expires the real caller-owned deadline only after
// ClientHello. For success, it answers the call but withholds close. Startup
// speed does not decide which phase is tested.
const cancellation = new AbortController()
const deadline = OperationDeadline.start(30_000, { signal: cancellation.signal })
process.once("message", () => cancellation.abort(new OperationDeadlineExceededError()))
try {
  const result = await callDaemonOnce({ target: { host: "127.0.0.1", port: Number(process.argv[2]), tls: process.argv[3] !== "success" },
    token: "t".repeat(43), method: "device.issueCode", params: {}, deadline })
  process.send({ kind: "answered", result })
} catch (error) {
  process.send({ kind: "refused", name: error.name, message: error.message })
} finally {
  deadline.clear()
  // Disconnect only the test channel, never the socket under test. No explicit
  // process exit: a leaked native handle must keep this fixture alive.
  process.disconnect()
}
