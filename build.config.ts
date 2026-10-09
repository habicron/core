import { defineBuildConfig } from 'unbuild'

/**
 * habicron is published as a built package: each entry is emitted as both ESM
 * (`.mjs`) and CommonJS (`.cjs`) with hand-checked `.d.ts` declarations.
 *
 * `vue` / `react` are externalised — they are optional peer dependencies and
 * must never be bundled into the output.
 */
export default defineBuildConfig({
  entries: [
    'src/core/index',
    'src/node/index',
    'src/browser/index',
    'src/vue/index',
    'src/react/index',
    'src/cli/index',
  ],
  declaration: true,
  clean: true,
  rollup: {
    emitCJS: true,
    inlineDependencies: true,
    esbuild: {
      target: 'node18',
      minify: true,
    },
  },
  externals: ['vue', 'react', 'react-dom'],
})
