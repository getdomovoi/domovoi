import { commitShaSchema } from "@getdomovoi/protocol"

declare const __BUILD_SOURCE_COMMIT__: string | null | undefined

export function builtSourceCommit(): string | undefined {
  const commit = typeof __BUILD_SOURCE_COMMIT__ === "undefined" ? undefined : __BUILD_SOURCE_COMMIT__
  const parsed = commitShaSchema.safeParse(commit)
  return parsed.success ? parsed.data : undefined
}
