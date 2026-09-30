// Resolves the `.js` specifiers in src/ to their `.ts` files, so Node runs the CLI from source.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error
      return next(specifier.replace(/\.js$/, '.ts'), context)
    }
  },
})
