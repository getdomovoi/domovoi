import { createHash } from "node:crypto"
import { posix } from "node:path"
import { z } from "zod"

import { wslTaskPlan } from "./wsl-task.js"

const text = z.string().min(1).max(4096).refine((value) => [...value].every((character) => character >= " " && character !== "\x7f"))
const guestPath = text.refine(posix.isAbsolute)
export const wslInstallationSchema = z.object({
  distribution: text.max(128).regex(/^[^\s"]+$/),
  linuxUser: text.max(256).regex(/^[^\s"]+$/),
  powershell: guestPath,
  wsl: text.regex(/^[A-Za-z]:[\\/]/),
  executable: guestPath,
  args: z.array(text).max(16),
}).strict()

export type WslInstallation = z.infer<typeof wslInstallationSchema>

export function installedWslTask(installation: WslInstallation, registrationId: string, configurationPath: string) {
  const saved = wslInstallationSchema.parse(installation)
  const identity = createHash("sha256").update(JSON.stringify([saved.distribution, saved.linuxUser])).digest("hex")
  return wslTaskPlan({ ...saved, name: "Domovoi-WSL-" + identity.slice(0, 32), registrationId,
    args: [...saved.args, "--service-supervise", configurationPath] })
}
