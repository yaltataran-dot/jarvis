import { registerHooks } from 'node:module'

/**
 * Loaded with `node --import` into a bridge started by a test: every import
 * of the Agent SDK resolves to the stand-in (fakeSdk.mjs) instead — except the
 * stand-in's own, which gets the real package for everything but `query`.
 * Nothing in bridge/ knows about this; the bridge runs as it does in use.
 */
const FAKE = new URL('./fakeSdk.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@anthropic-ai/claude-agent-sdk' && context.parentURL !== FAKE) {
      return { url: FAKE, format: 'module', shortCircuit: true }
    }
    return next(specifier, context)
  },
})
