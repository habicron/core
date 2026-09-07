import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('loads only Cloudflare credentials from the dedicated library production scope', () => {
  const workflow = readFileSync(new URL('../workflows/deploy.yml', import.meta.url), 'utf8')
  assert.match(workflow, /project: habicron-library\n\s+environment: production\n\s+deployment-kind: production/)
  assert.match(workflow, /keys: '\["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"\]'/)
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['THECODEORIGIN_VAULT_TOKEN'])
  assert.match(workflow, /apiToken: \$\{\{ env\.CLOUDFLARE_API_TOKEN \}\}/)
  assert.match(workflow, /accountId: \$\{\{ env\.CLOUDFLARE_ACCOUNT_ID \}\}/)
  assert.doesNotMatch(workflow, /doppler (?:run|secrets)|dopplerhq\/cli-action/)
})
