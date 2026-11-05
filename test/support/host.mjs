/**
 * Import a module that depends on the dsh host packages, or skip the probe.
 *
 * `index.js` imports `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` — the
 * packages a dsh **profile** provides at runtime, not the plugin itself. A bare
 * checkout (a fresh clone, a CI runner) has none of them, so importing the host
 * half there fails with ERR_MODULE_NOT_FOUND before a single assertion runs.
 *
 * That is an environment fact, not a regression, so the probe exits 0 with a
 * notice instead of going red and hiding the probes that could have run. Only a
 * missing `@deepseek-ai/*` is tolerated: any other module-not-found error — a
 * renamed local file, say — is re-thrown, because that is a real breakage.
 *
 * To run the host probes, give the checkout the packages once:
 *   npm install --no-save @deepseek-ai/dsh   # hoists dsh-llm, dsh-tools, schemastery
 * or install the plugin into a profile and run the probe from there.
 * @param specifier module specifier to import; a relative one is resolved
 *   against `base`, i.e. the caller's `import.meta.url` — a bare `import()`
 *   inside this helper would resolve against this file's directory instead
 * @param base the caller's `import.meta.url`
 * @returns the imported module namespace
 */
export async function importHosted(specifier, base) {
  const target = specifier.startsWith('.') ? new URL(specifier, base).href : specifier
  try {
    return await import(target)
  } catch (error) {
    const missingHostPackage =
      error?.code === 'ERR_MODULE_NOT_FOUND' && /@deepseek-ai[\\/]/.test(String(error?.message ?? ''))
    if (!missingHostPackage) throw error
    console.log(`skip — ${specifier} needs the dsh host packages (@deepseek-ai/*), which this checkout does not have.`)
    console.log('       run: npm install --no-save @deepseek-ai/dsh   (or run this probe inside a dsh profile)')
    process.exit(0)
  }
}
