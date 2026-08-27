type ServiceWorkerRegistrar = {
  register(scriptURL: string, options: { scope: string }): Promise<unknown>
}

export async function registerDomovoiServiceWorker(
  serviceWorkers: ServiceWorkerRegistrar,
  production: boolean,
): Promise<void> {
  if (!production) return
  await serviceWorkers.register("/sw.js", { scope: "/" })
}
