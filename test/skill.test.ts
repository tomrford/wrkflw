import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSkill, skillTopics, workflowExample } from '../src/skill.js'

test('skill exposes the agent-facing contract', () => {
  assert.deepEqual(skillTopics, [
    'overview',
    'workflow',
    'run',
    'locations',
    'workspaces',
    'context',
    'preflight',
    'monitoring',
  ])
  assert.match(renderSkill('run'), /model: string.*exact model ID/s)
  assert.match(renderSkill('locations'), /Location.*reusable plain value/s)
  assert.match(renderSkill('workspaces'), /3 independent/)
  assert.match(renderSkill('context'), /typed session handle.*resolved location/s)
  assert.match(renderSkill('preflight'), /starts no harnesses/)
  assert.ok(renderSkill('workflow').includes(workflowExample))
})

test('skill rejects unknown topics', () => {
  assert.throws(() => renderSkill('missing'), /Unknown skill topic/)
})
