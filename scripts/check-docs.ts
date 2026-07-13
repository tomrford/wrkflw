import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { workflowExample } from '../src/skill.js'

const [readme, example, architecture] = await Promise.all([
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../examples/basic.workflow.ts', import.meta.url), 'utf8'),
  readFile(new URL('../docs/architecture.md', import.meta.url), 'utf8'),
])

assert.equal(example, `${workflowExample}\n`, 'canonical workflow example has drifted')
assert.ok(
  readme.includes(`\`\`\`ts\n${workflowExample}\n\`\`\``),
  'README must embed the canonical workflow example',
)
assert.ok(readme.includes('docs/architecture.md'), 'README must link architecture')
assert.match(architecture, /no permanent central daemon/i)
assert.match(architecture, /jj\s+workspace forget/)
