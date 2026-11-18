/** One-shot plan submission: reading the plan from stdin and its error paths. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/lease/cli.ts'
import { loadPlanText } from '../src/plan/run.ts'
import { sink } from './support.ts'

const VALID_PLAN = JSON.stringify({
  version: 1,
  reason: 'stdin test',
  steps: [{ op: 'movePointer', at: { x: 10, y: 20 } }],
})

/**
 * Build io targets whose stdin returns one fixed body.
 * @param text Body to read, or a thunk that resolves it.
 * @returns Output sinks and the stdin reader.
 */
function inputIo(text: string | (() => Promise<string>)): {
  stdout: ReturnType<typeof sink>
  stderr: ReturnType<typeof sink>
  readStdin: () => Promise<string>
} {
  return {
    stdout: sink(),
    stderr: sink(),
    readStdin: typeof text === 'string' ? (): Promise<string> => Promise.resolve(text) : text,
  }
}

test('loadPlanText defaults the fields a one-step submission may omit', () => {
  const plan = loadPlanText(VALID_PLAN, 'Plan input')
  assert.equal(plan.version, 1)
  assert.equal(plan.id, 'plan')
  assert.equal(plan.reason, 'stdin test')
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0]?.op, 'movePointer')
})

test('loadPlanText rejects non-JSON with PLAN_INVALID', () => {
  assert.throws(() => loadPlanText('{', 'Plan input'), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'PLAN_INVALID')
    assert.match(error.message, /Plan input is not JSON/)
    return true
  })
})

test('run - without an argument reports usage', async () => {
  const io = inputIo(VALID_PLAN)
  const code = await main(['run'], io)
  assert.equal(code, 2)
  assert.match(io.stderr.text, /plan file or - for stdin/)
})

test('run - refuses an empty stdin body before any plan work', async () => {
  const io = inputIo('   \n')
  const code = await main(['run', '-', '--json'], io)
  assert.equal(code, 2)
  assert.match(io.stderr.text, /needs a plan document on stdin/)
})

test('run - reports invalid JSON as PLAN_INVALID', async () => {
  const io = inputIo('{')
  const code = await main(['run', '-', '--json'], io)
  assert.equal(code, 1)
  const failure = JSON.parse(io.stderr.text) as { error: { code: string; message: string } }
  assert.equal(failure.error.code, 'PLAN_INVALID')
  assert.match(failure.error.message, /Plan input is not JSON/)
})

test('run - caps the stdin body at one megabyte', async () => {
  const oversized = `{"version":1,"reason":"${'x'.repeat(1024 * 1024)}"}`
  const io = inputIo(oversized)
  const code = await main(['run', '-', '--json'], io)
  assert.equal(code, 2)
  assert.match(io.stderr.text, /under 1048576 bytes/)
})

test('run - surfaces a stdin read failure as COMMAND_FAILED', async () => {
  const io = inputIo((): Promise<string> => Promise.reject(new Error('boom')))
  const code = await main(['run', '-', '--json'], io)
  assert.equal(code, 1)
  const failure = JSON.parse(io.stderr.text) as { error: { code: string; message: string } }
  assert.equal(failure.error.code, 'COMMAND_FAILED')
  assert.match(failure.error.message, /boom/)
})
