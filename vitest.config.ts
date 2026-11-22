import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: { AWAYWORK_PROFILE: 'default' },
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 15_000,
  },
})
