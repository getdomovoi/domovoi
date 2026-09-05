// Substitute release metadata only. The distributed CLI and socket stay real.
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  if (specifier !== "@getdomovoi/protocol") return result
  const source = `export * from ${JSON.stringify(result.url)}; export const buildVersion = "9.8.7-test";`
  return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
}
