import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const PROJECT_PATH = 'packages/habicron'
const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const repositoryUrl = /^https:\/\/github\.com\/thecodeorigin\/ecosystem(?:\.git)?$/

export function parseBootstrapEnvironment(operation, environment = process.env) {
  if (!['build', 'deploy'].includes(operation))
    throw new Error('Operation must be build or deploy')
  if (!sha.test(environment.ECOSYSTEM_SHA ?? ''))
    throw new Error('ECOSYSTEM_SHA must be a full Git commit SHA')
  if (!environment.ECOSYSTEM_CHECKOUT_TOKEN || /[\r\n\0]/.test(environment.ECOSYSTEM_CHECKOUT_TOKEN))
    throw new Error('ECOSYSTEM_CHECKOUT_TOKEN is required')
  const repository = environment.ECOSYSTEM_REPOSITORY ?? 'https://github.com/thecodeorigin/ecosystem.git'
  if (!repositoryUrl.test(repository))
    throw new Error('Expected the GitHub ecosystem repository')
  return { operation, ecosystemSha: environment.ECOSYSTEM_SHA, repository, token: environment.ECOSYSTEM_CHECKOUT_TOKEN }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    throw new Error(`${command} failed with exit code ${result.status}`)
}

function output(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, ...options })
  if (result.error || result.status !== 0)
    throw new Error(`${command} ${args[0]} failed`)
  return result.stdout.trim()
}

export async function bootstrap(operation, environment = process.env) {
  const config = parseBootstrapEnvironment(operation, environment)
  const childRoot = process.cwd()
  const childSha = output('git', ['rev-parse', '--verify', 'HEAD'], { cwd: childRoot })
  if (!sha.test(childSha))
    throw new Error('Current child HEAD is not a full Git commit')
  if (output('git', ['status', '--porcelain'], { cwd: childRoot }))
    throw new Error('The child checkout must be clean before an ecosystem build')
  const temporary = await mkdtemp(join(tmpdir(), 'ecosystem-build-'))
  try {
    await chmod(temporary, 0o700)
    const workspace = join(temporary, 'workspace')
    const askpass = join(temporary, 'askpass.sh')
    await mkdir(workspace)
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' x-access-token ;;\n  *Password*) printf \'%s\\n\' "$ECOSYSTEM_CHECKOUT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o700 })
    const checkoutEnvironment = {
      PATH: environment.PATH,
      HOME: environment.HOME,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: askpass,
      ECOSYSTEM_CHECKOUT_TOKEN: config.token,
    }
    run('git', ['init', '--quiet'], { cwd: workspace, env: checkoutEnvironment })
    run('git', ['remote', 'add', 'origin', config.repository], { cwd: workspace, env: checkoutEnvironment })
    run('git', ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', 'fetch', '--quiet', '--depth=1', '--no-tags', 'origin', config.ecosystemSha], { cwd: workspace, env: checkoutEnvironment })
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: workspace, env: checkoutEnvironment })
    run('node', ['.github/scripts/checkout-projects.mjs'], {
      cwd: workspace,
      env: {
        ...checkoutEnvironment,
        GITHUB_SHA: config.ecosystemSha,
        EXPECTED_PROJECT_PATH: PROJECT_PATH,
        EXPECTED_PROJECT_COMMIT: childSha,
      },
    })
    const buildEnvironment = { ...environment }
    delete buildEnvironment.ECOSYSTEM_CHECKOUT_TOKEN
    const pnpm = environment.PNPM_EXECUTABLE ?? 'pnpm'
    if (output(pnpm, ['--version'], { cwd: workspace, env: buildEnvironment }) !== '12.8.1')
      throw new Error('pnpm 12.8.1 is required')
    run(pnpm, ['install', '--frozen-lockfile'], { cwd: workspace, env: buildEnvironment })
    run(pnpm, ['--dir', resolve(workspace, PROJECT_PATH), `run`, `${config.operation}:workspace`], { cwd: workspace, env: buildEnvironment })
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  bootstrap(process.argv[2]).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
