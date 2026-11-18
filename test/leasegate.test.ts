/** Plan/lease binding: the executor's grant must still own a plan-bound lease. */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { ErrorCode } from '../src/errors.ts'
import { OP_SPECS } from '../src/plan/model.ts'
import { assertPlanGrant, requirePlanGrant } from '../src/plan/leasegate.ts'
import { leasePaths } from '../src/lease/state.ts'
import { tempDir } from './support.ts'

test('the retry loop only replays idempotent ops', () => {
  assert.equal(OP_SPECS.movePointer.idempotent, true)
  assert.equal(OP_SPECS.focusWindow.idempotent, true)
  assert.equal(OP_SPECS.click.idempotent, false)
  assert.equal(OP_SPECS.text.idempotent, false)
  assert.equal(OP_SPECS.click.requiresExpect, true)
  assert.equal(OP_SPECS.workspace.requiresDeclared, false)
})

/**
 * Write a lease state file for the binding tests.
 * @param directory State directory.
 * @param overrides State fields to replace.
 */
function writeLeaseState(directory: string, overrides: Record<string, unknown>): void {
  const paths = leasePaths({ XDG_STATE_HOME: directory })
  mkdirSync(paths.dir, { recursive: true })
  const now = new Date()
  const state = {
    version: 1,
    leaseId: 'lease-1',
    phase: 'granted',
    reason: 'test',
    planBound: true,
    planSummary: null,
    ttlMs: 60_000,
    createdAt: now.toISOString(),
    consentDeadline: new Date(now.getTime() + 30_000).toISOString(),
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    endedAt: null,
    endReason: null,
    requesterPid: process.pid,
    holderPid: null,
    overlayPid: null,
    ...overrides,
  }
  writeFileSync(paths.stateFile, JSON.stringify(state))
}

test('requirePlanGrant accepts a granted lease bound to a submitted plan', async (t) => {
  const stateHome = tempDir('hyprlease-bind-')
  t.after(() => { rmSync(stateHome, { recursive: true, force: true }) })
  writeLeaseState(stateHome, {})
  const env = { XDG_STATE_HOME: stateHome }
  const grant = await requirePlanGrant(env)
  assert.equal(grant.leaseId, 'lease-1')
  await assert.doesNotReject(assertPlanGrant(grant, env))
})

test('requirePlanGrant refuses a lease that approves no plan', async (t) => {
  const stateHome = tempDir('hyprlease-bind-')
  t.after(() => { rmSync(stateHome, { recursive: true, force: true }) })
  writeLeaseState(stateHome, { planBound: false })
  await assert.rejects(requirePlanGrant({ XDG_STATE_HOME: stateHome }), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && error.code === ErrorCode.LEASE_MISMATCH)
    return true
  })
})

test('requirePlanGrant refuses a lease that already ended', async (t) => {
  const stateHome = tempDir('hyprlease-bind-')
  t.after(() => { rmSync(stateHome, { recursive: true, force: true }) })
  writeLeaseState(stateHome, { phase: 'released', endedAt: new Date().toISOString(), endReason: 'done' })
  await assert.rejects(requirePlanGrant({ XDG_STATE_HOME: stateHome }), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && error.code === ErrorCode.NO_LEASE)
    return true
  })
})

test('assertPlanGrant notices expiry between steps', async (t) => {
  const stateHome = tempDir('hyprlease-bind-')
  t.after(() => { rmSync(stateHome, { recursive: true, force: true }) })
  writeLeaseState(stateHome, { expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const env = { XDG_STATE_HOME: stateHome }
  const grant = await requirePlanGrant(env)
  writeLeaseState(stateHome, { expiresAt: new Date(Date.now() - 1_000).toISOString() })
  await assert.rejects(assertPlanGrant(grant, env), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && error.code === ErrorCode.LEASE_MISMATCH)
    return true
  })
})
