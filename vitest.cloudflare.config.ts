import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.cloudflare-test.jsonc' },
  })],
  test: {
    include: ['test/cloudflare/**/*.test.ts'],
    clearMocks: true,
  },
})
