import type { ClientAccess } from "@getdomovoi/protocol"

export const watchingReason = "Watching only. This phone can read the session but cannot change it."

type RpcCall = (method: string, params: unknown) => Promise<unknown>

export function mutationCall(
  access: ClientAccess,
  call: RpcCall,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (access === "watching") return Promise.reject(new Error(watchingReason))
  return call(method, params)
}
