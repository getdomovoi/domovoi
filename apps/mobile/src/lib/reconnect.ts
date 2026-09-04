// A phone loses its connection constantly: it sleeps, it changes network, the
// laptop moves between tailnets. Reconnecting has to be the normal case rather
// than an error, and it has to back off so a daemon that is genuinely gone is
// not hammered from a device on a battery.
export const firstRetryMs = 1_000
export const maxRetryMs = 30_000

export function retryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0
  return Math.min(maxRetryMs, firstRetryMs * 2 ** (attempt - 1))
}
