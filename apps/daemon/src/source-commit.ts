import { commitShaSchema } from "@getdomovoi/protocol"

declare const __DOMOVOI_SOURCE_COMMIT__: string | null | undefined

export function builtSourceCommit(): string | undefined {
  const commit = typeof __DOMOVOI_SOURCE_COMMIT__ === "undefined" ? undefined : __DOMOVOI_SOURCE_COMMIT__
  const parsed = commitShaSchema.safeParse(commit)
  return parsed.success ? parsed.data : undefined
}
