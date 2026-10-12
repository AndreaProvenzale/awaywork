import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Pacing counts window openings in local time.
  test: { include: ['test/**/*.test.ts'], env: { TZ: 'UTC' } },
})
