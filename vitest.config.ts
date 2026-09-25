import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Default to Node; Vue/React suites opt into jsdom via a file docblock:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['src/**/__test__/**/*.test.ts', 'test/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__test__/**'],
    },
  },
})
