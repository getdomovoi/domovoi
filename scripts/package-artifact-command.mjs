export function pnpmInvocation(platform = process.platform) {
  return {
    command: "pnpm",
    shell: platform === "win32",
  }
}
