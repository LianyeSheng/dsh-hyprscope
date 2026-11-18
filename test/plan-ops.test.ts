/** `hyprscope control ops` reports the operation catalog without drift. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/lease/cli.ts'
import { OP_FIELDS, OP_SPECS, type StepOp } from '../src/plan/model.ts'
import { listOps, renderOpsLine } from '../src/plan/ops.ts'
import { sink } from './support.ts'

/**
 * Run one control command against in-memory output sinks.
 * @param argv Arguments after the control word.
 * @returns Exit code and captured streams.
 */
async function control(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = sink()
  const stderr = sink()
  const code = await main(argv, { stdout, stderr })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

test('ops --json is the stable catalog shape the docs promise', async () => {
  const result = await control(['ops', '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  const catalog = JSON.parse(result.stdout) as Record<string, unknown>[]
  assert.deepEqual(catalog.map(entry => entry.op), Object.keys(OP_SPECS))
  for (const entry of catalog) {
    assert.deepEqual(Object.keys(entry), ['op', 'mutating', 'idempotent', 'needsTarget', 'requires', 'fields'])
    const spec = OP_SPECS[entry.op as StepOp]
    assert.equal(entry.mutating, spec.mutating)
    assert.equal(entry.idempotent, spec.idempotent)
    assert.equal(entry.needsTarget, spec.needsTarget)
    assert.deepEqual(entry.requires, [...spec.requires])
    const fields = entry.fields as Record<string, unknown>[]
    assert.deepEqual(fields.map(field => field.name), OP_FIELDS[entry.op as StepOp].map(field => field.name))
    for (const [index, field] of fields.entries()) {
      assert.deepEqual(Object.keys(field), ['name', 'required', 'shape'])
      const catalogField = OP_FIELDS[entry.op as StepOp][index]!
      assert.equal(field.required, catalogField.required)
      assert.equal(field.shape, catalogField.shape)
    }
  }
})

test('ops --json is deterministic output', async () => {
  const first = await control(['ops', '--json'])
  const second = await control(['ops', '--json'])
  assert.equal(first.stdout, second.stdout)
})

test('human ops output is one reference line per op', async () => {
  const result = await control(['ops'])
  assert.equal(result.code, 0)
  const lines = result.stdout.trimEnd().split('\n')
  assert.equal(lines.length, Object.keys(OP_SPECS).length)
  const ops = Object.keys(OP_SPECS) as StepOp[]
  for (const [index, op] of ops.entries()) {
    assert.ok(lines[index]!.startsWith(`${op} · needs `), `line ${index} must start with the op name: ${lines[index]}`)
    assert.equal(lines[index], renderOpsLine(listOps()[index]!))
  }
})

test('the movePointer line shows needs, capabilities, fields, and clauses', async () => {
  const result = await control(['ops'])
  const line = result.stdout.split('\n').find(entry => entry.startsWith('movePointer '))
  assert.ok(line !== undefined)
  assert.equal(line, 'movePointer · needs none · requires inject.pointer · at:{x,y}|{window,point} [requires?, expect?]')
})

test('the assert line marks expect as forbidden', async () => {
  const assertLine = listOps().find(entry => entry.op === 'assert')
  assert.ok(assertLine !== undefined)
  assert.equal(renderOpsLine(assertLine), 'assert · needs none · requires none · [requires?, expect:forbidden]')
})

test('the command is listed in control help', async () => {
  const result = await control(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^  ops\s+List the supported ops and their fields/m)
})

test('ops rejects extra positional arguments as usage', async () => {
  const result = await control(['ops', 'extra'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /USAGE/)
  assert.match(result.stderr, /ops takes no arguments/)
})
