import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { createServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import type { DaemonServiceRuntime, DaemonServiceRuntimeReader } from "./desktop-service.js"
import { serviceProgram } from "./install.js"
import { launchdPlist, systemdUnit } from "./units.js"

// #635: runtime copies and a fake service manager on this host's own paths,
// so the cleanup's checks run against real directories on every platform.

export function copyLayout(copy: string): DaemonServiceRuntime {
  return {
    nodePath: process.platform === "win32" ? join(copy, "node", "node.exe") : join(copy, "node", "bin", "node"),
    daemonEntryPath: join(copy, "daemon", "dist", "index.js"),
  }
}

// A copy as the desktop publishes it: <profile>/runtime/<version>/<id>.
export async function publishCopy(profile: string, version: string, id: string): Promise<string> {
  const copy = join(profile, "runtime", version, id)
  const { nodePath, daemonEntryPath } = copyLayout(copy)
  for (const file of [nodePath, daemonEntryPath]) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, "")
  }
  return copy
}

// What the service manager reports for a service that runs this copy: the
// plist or unit an install writes, or the Windows task's one action.
export function serviceDefinition(copy: string, configurationPath: string): string {
  const { nodePath, daemonEntryPath } = copyLayout(copy)
  if (process.platform === "win32") {
    return `<Task><Actions><Exec><Command>"${nodePath}"</Command><Arguments>"${daemonEntryPath}" --service-config "${configurationPath}"</Arguments></Exec></Actions></Task>`
  }
  const { program, args } = serviceProgram(daemonEntryPath, nodePath, configurationPath)
  return process.platform === "darwin" ? launchdPlist({ execPath: program, args }) : systemdUnit({ execPath: program, args })
}

// The user's one login service. Registering a copy replaces its definition,
// as an install or an update does; crafting sets any text at all.
export function fakeServiceManager(home: string, profile?: string) {
  const configuration = createServiceConfiguration(profile === undefined ? {} : { DOMOVOI_PROFILE_DIR: profile }, { platform: process.platform, homeDirectory: home, workingDirectory: home })
  const configurationPath = serviceConfigurationPath(home, process.platform)
  const state: { definition: string | undefined } = { definition: undefined }
  const reader: DaemonServiceRuntimeReader = {
    platform: process.platform,
    home,
    readDefinition: async () => state.definition,
    capture: async () => state.definition === undefined
      ? { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
      : { code: 0, stdout: state.definition },
    readConfiguration: () => configuration,
  }
  return {
    reader,
    configurationPath,
    register: (copy: string) => { state.definition = serviceDefinition(copy, configurationPath) },
    craft: (definition: string) => { state.definition = definition },
  }
}
