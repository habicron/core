// @ts-check
import antfu, { react, vue } from '@antfu/eslint-config'

/**
 * habicron lint setup — @antfu/eslint-config, strict.
 *
 * The repo ships a Vue adapter and a React adapter side-by-side. To keep their
 * rules from bleeding into each other, framework auto-detection is turned OFF
 * and each framework config is scoped explicitly:
 *
 *   - React rules (react-hooks, @eslint-react) → src/react/** — these matter on
 *     plain `.ts` hook files, so they're scoped to the directory.
 *   - Vue rules (eslint-plugin-vue) → **\/*.vue SFCs. The current Vue adapter is
 *     a plain `.ts` composable, so it's covered by the strict type-aware TS
 *     ruleset (via @typescript-eslint/parser); the Vue plugin is wired up for
 *     any single-file components added later. Routing `.ts` through
 *     vue-eslint-parser would disable type-aware linting, so we don't.
 *
 * The core, node and cli code is framework-free and only sees the strict
 * TypeScript ruleset.
 */
export default antfu(
  {
    type: 'lib',
    // Type-aware linting = the strict lever (no-floating-promises,
    // no-misused-promises, strict boolean expressions, …).
    typescript: {
      tsconfigPath: 'tsconfig.json',
    },
    stylistic: {
      indent: 2,
      quotes: 'single',
      semi: false,
    },
    // Frameworks are scoped per-directory below — never globally.
    vue: false,
    react: false,
    ignores: [
      'dist',
      'coverage',
      // README code samples are illustrative fragments, not standalone modules.
      '**/*.md',
    ],
  },
  {
    // A couple of strict, intentional sharpenings on top of the preset.
    rules: {
      'no-console': 'error',
      'ts/explicit-function-return-type': 'off',
      'antfu/no-top-level-await': 'off',
    },
  },
  {
    // Type-strict: no casting, no non-null assertions, no `any`. The only
    // allowed assertion is the JSON-deserialization boundary in cli/store.ts,
    // which carries an inline eslint-disable explaining why.
    files: ['src/**/*.ts'],
    rules: {
      'ts/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      'ts/no-non-null-assertion': 'error',
      'ts/no-explicit-any': 'error',
    },
  },
)
  // Vue single-file components only (the `.ts` composable uses the strict TS
  // rules instead — see the file header).
  .append(
    vue({
      files: ['src/**/*.vue'],
    }),
  )
  // React adapter only.
  .append(
    react({
      files: ['src/react/**/*.{ts,tsx}'],
      tsconfigPath: 'tsconfig.json',
    }),
  )
  // The CLI is the one place a process may write to stdout/stderr.
  .append({
    files: ['src/cli/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  })
