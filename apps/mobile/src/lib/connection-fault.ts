import {
  daemonAuthenticationErrorCode,
  protocolMismatchSchema,
  protocolVersionMismatchErrorCode,
} from "@getdomovoi/protocol"

import { DaemonError } from "./daemon"

export type ConnectionFault = {
  // Transient faults are retried forever, because a phone loses its connection
  // constantly and getting it back is the normal case. The rest are answers the
  // daemon will give identically to every retry, so retrying is a battery cost
  // that buys the person nothing and hides what is actually wrong.
  retriable: boolean
  headline: string
  detail: string
}

// The daemon returns invalid params when it cannot read the greeting at all,
// which for a fixed build means every greeting after it is unreadable too.
const invalidParamsErrorCode = -32602

const credential: ConnectionFault = {
  retriable: false,
  headline: "The daemon refused this credential",
  detail: "The pairing token is wrong, or this device has been revoked. Pair again in Settings.",
}

export function connectionFault(cause: unknown): ConnectionFault {
  if (!(cause instanceof DaemonError)) {
    return {
      retriable: true,
      headline: "Cannot reach the daemon",
      detail: cause instanceof Error ? cause.message : "The connection did not open.",
    }
  }
  // Every credential the daemon rejects comes back under this code: an unknown
  // token, a revoked device, and a machine credential presented by a client.
  // The person's answer is the same for all three.
  if (cause.code === daemonAuthenticationErrorCode) return credential
  if (cause.code === protocolVersionMismatchErrorCode) {
    // The refusal's data names both versions. A daemon from before it carried
    // data names them in its sentence, which stays the fallback.
    const mismatch = protocolMismatchSchema.safeParse(cause.data)
    const versions = mismatch.success
      ? `This daemon speaks protocol ${mismatch.data.daemonProtocolVersion}; the client speaks ${mismatch.data.clientProtocolVersion}`
      : cause.message
    return {
      retriable: false,
      headline: "The phone and the daemon speak different protocols",
      detail: `${versions}. Update whichever of the two is older.`,
    }
  }
  if (cause.code === invalidParamsErrorCode) {
    return {
      retriable: false,
      headline: "The daemon could not read this phone's greeting",
      detail: "This is a fault in the app rather than the pairing. Update the phone app.",
    }
  }
  return {
    retriable: true,
    headline: "The daemon refused the connection",
    detail: cause.message,
  }
}
