import type { ClientAccess, RpcMethod, RpcParams } from "@getdomovoi/protocol"

export const watchingReason = "Watching only. This phone can read the session but cannot change it."

// Params are checked against the protocol when this compiles. Each caller
// reads the answer with the schema it needs.
export type MutationCall = <M extends RpcMethod>(method: M, params: RpcParams<M>) => Promise<unknown>

export function mutationCall<M extends RpcMethod>(
  access: ClientAccess,
  call: MutationCall,
  method: M,
  params: RpcParams<M>,
): Promise<unknown> {
  if (access === "watching") return Promise.reject(new Error(watchingReason))
  return call(method, params)
}
