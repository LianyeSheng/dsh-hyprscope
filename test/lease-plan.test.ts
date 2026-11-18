/** Plan binding and transient notice plumbing for the consent lease. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { leaseStatus, releaseLease, requestLease, submitDecision } from '../src/lease/control.ts'
import { main, parseLeaseArgs } from '../src/lease/cli.ts'
import type { OverlayFactory } from '../src/lease/overlay.ts'
import {
  INTERFERENCE_DECISION_FILE, INTERFERENCE_FILE, NOTICE_FILE, clearInterference, clearInterferenceDecision,
  clearNotice, leasePaths, newLeaseState, readInterference, readInterferenceDecision, readNotice, readState,
  writeInterference, writeInterferenceDecision, writeNotice,
  type InterferenceDecision, type LeaseInterference, type LeaseNotice, type LeasePaths, type LeasePlanSummary,
  type LeaseState,
} from '../src/lease/state.ts'
import { writeProgress, readProgress, clearProgress } from '../src/lease/state.ts'
import { removeDir, sink, tempDir } from './support.ts'

const PLAN_SUMMARY: LeasePlanSummary = {
  steps: 5,
  ops: ['click', 'text', 'screenshot'],
  workspace: '2',
  summary: 'fill the login form',
}

/** @param ms Delay in milliseconds. */
const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Build an isolated environment for one test.
 * @param t Test context.
 * @returns Environment pointing at a disposable state directory.
 */
function leaseEnv(t: import('node:test').TestContext): NodeJS.ProcessEnv {
  const stateHome = tempDir('hyprlease-plan-state-')
  t.after(() => { removeDir(stateHome) })
  return { ...process.env, XDG_STATE_HOME: stateHome, HYPRSCOPE_QUICKSHELL: '/bin/false' }
}

/** Fake overlay that never renders. */
const fakeOverlay: OverlayFactory = async () => ({
  pid: null,
  exited: Promise.resolve(),
  stop: async () => {},
})

/**
 * Wait until the recorded lease reaches a phase.
 * @param paths Lease paths.
 * @param phase Expected phase.
 * @param timeoutMs How long to keep polling.
 * @returns State observed in that phase.
 */
async function waitForPhase(
  paths: LeasePaths,
  phase: LeaseState['phase'],
  timeoutMs = 2_000,
): Promise<LeaseState> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await readState(paths)
    if (state !== null && state.phase === phase) return state
    await delay(10)
  }
  assert.fail(`lease never reached phase ${phase}`)
}

/**
 * Poll a condition until it holds.
 * @param predicate Condition to satisfy.
 * @param label Description used in the timeout failure.
 * @param timeoutMs How long to keep polling.
 */
async function waitUntil(predicate: () => Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${label}`)
}

/**
 * Build a valid notice record.
 * @param leaseId Lease the notice belongs to.
 * @param text Notice text.
 * @returns Notice record.
 */
function noticeFor(leaseId: string, text = '外部操作 · 正在恢复 1/2'): LeaseNotice {
  const at = new Date()
  return { leaseId, text, at: at.toISOString(), expiresAt: new Date(at.getTime() + 5_000).toISOString() }
}

/**
 * Build a valid blocking interference prompt.
 * @param leaseId Lease that owns the prompt.
 * @param id Unique prompt id.
 * @param overrides Fields to replace.
 * @returns Prompt record.
 */
function interferenceFor(
  leaseId: string,
  id = 'prompt-1',
  overrides: Partial<LeaseInterference> = {},
): LeaseInterference {
  const at = new Date()
  return {
    leaseId,
    runId: 'run-1',
    id,
    step: 2,
    total: 5,
    kind: 'workspace.active',
    detail: 'foreign workspace event',
    at: at.toISOString(),
    expiresAt: new Date(at.getTime() + 12_000).toISOString(),
    ...overrides,
  }
}

/**
 * Point `process.env.XDG_STATE_HOME` at a disposable directory for a CLI test.
 * @param t Test context.
 * @returns Paths inside that directory, restored/removed afterwards.
 */
function useStateHome(t: import('node:test').TestContext): LeasePaths {
  const stateHome = tempDir('hyprlease-interference-')
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    removeDir(stateHome)
  })
  return leasePaths()
}

test('newLeaseState defaults the plan binding to false', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const state = newLeaseState({ leaseId: 'lease-1', reason: 'demo', consentMs: 30_000, ttlMs: 60_000, now })
  assert.equal(state.planBound, false)
  assert.equal(state.planSummary, null)
})

test('newLeaseState keeps the plan binding and summary it was given', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const state = newLeaseState({
    leaseId: 'lease-1', reason: 'plan', consentMs: 30_000, ttlMs: 60_000, now,
    planBound: true, planSummary: PLAN_SUMMARY,
  })
  assert.equal(state.phase, 'consent')
  assert.equal(state.planBound, true)
  assert.deepEqual(state.planSummary, PLAN_SUMMARY)
})

test('leasePaths exposes the notice file next to the other records', () => {
  const paths = leasePaths({ XDG_STATE_HOME: '/tmp/state' })
  assert.equal(NOTICE_FILE, 'notice.json')
  assert.equal(paths.noticeFile, join('/tmp/state/hyprlease', NOTICE_FILE))
})

test('notice write, read, overwrite, and clear round-trip through the state directory', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const first = noticeFor('lease-1')
  // writeNotice creates the state directory, so a notice can be published
  // before the lease owner writes its first state record.
  await writeNotice(paths, first)
  assert.deepEqual(await readNotice(paths), first)

  const second = { ...first, text: '外部操作 · 正在恢复 2/2' }
  await writeNotice(paths, second)
  assert.equal((await readNotice(paths))?.text, '外部操作 · 正在恢复 2/2')

  await clearNotice(paths)
  assert.equal(await readNotice(paths), null)
  // Clearing twice is safe, like clearing every other record.
  await clearNotice(paths)
})

test('requestLease persists the plan binding and exposes it through status', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const seen: LeaseState[] = []
  const spawnOverlay: OverlayFactory = async (overlayPaths, state) => {
    seen.push(state)
    return fakeOverlay(overlayPaths, state)
  }
  const pending = requestLease({
    reason: 'run the plan', ttlMs: 5_000, consentMs: 5_000, env, spawnOverlay,
    planBound: true, planSummary: PLAN_SUMMARY,
  })
  try {
    await waitForPhase(paths, 'consent')
    await submitDecision({ action: 'allow', env })
    const outcome = await pending
    assert.equal(outcome.allowed, true)

    const consentState = seen[0]
    assert.ok(consentState !== undefined)
    assert.equal(consentState.planBound, true)
    assert.deepEqual(consentState.planSummary, PLAN_SUMMARY)

    const granted = await waitForPhase(paths, 'granted')
    assert.equal(granted.planBound, true)
    assert.deepEqual(granted.planSummary, PLAN_SUMMARY)

    const status = await leaseStatus(env)
    assert.equal(status.phase, 'granted')
    assert.equal(status.planBound, true)
    assert.deepEqual(status.planSummary, PLAN_SUMMARY)
  } finally {
    const released = await releaseLease({ action: 'done', env, waitMs: 4_000 })
    assert.equal(released.ok, true)
  }
})

test('a new request removes the previous lease notice', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  await writeNotice(paths, noticeFor('previous-lease'))
  assert.notEqual(await readNotice(paths), null)

  const pending = requestLease({
    reason: 'next plan', ttlMs: 5_000, consentMs: 2_000, env, spawnOverlay: fakeOverlay,
    planBound: true, planSummary: PLAN_SUMMARY,
  })
  try {
    await waitForPhase(paths, 'consent')
    assert.equal(await readNotice(paths), null)
  } finally {
    await submitDecision({ action: 'deny', env })
    const outcome = await pending
    assert.equal(outcome.allowed, false)
    assert.equal(outcome.phase, 'denied')
  }
})

test('finalize clears the notice when the granted lease ends', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const pending = requestLease({
    reason: 'finish the plan', ttlMs: 5_000, consentMs: 5_000, env, spawnOverlay: fakeOverlay,
    planBound: true, planSummary: PLAN_SUMMARY,
  })
  try {
    await waitForPhase(paths, 'consent')
    await submitDecision({ action: 'allow', env })
    const outcome = await pending
    assert.equal(outcome.allowed, true)

    await writeNotice(paths, noticeFor(outcome.leaseId))
    assert.notEqual(await readNotice(paths), null)

    const released = await releaseLease({ action: 'done', env, waitMs: 4_000 })
    assert.equal(released.ok, true)
    await waitUntil(async () => (await readNotice(paths)) === null, 'the finalize notice cleanup')
  } finally {
    await releaseLease({ action: 'done', env, waitMs: 1_000 })
  }
})

test('status reports no plan binding when no lease exists', async (t) => {
  const env = leaseEnv(t)
  const status = await leaseStatus(env)
  assert.equal(status.active, false)
  assert.equal(status.planBound, false)
  assert.equal(status.planSummary, null)
})

test('execution progress round-trips and clears', async (t) => {
  const stateHome = tempDir('hyprlease-progress-')
  t.after(() => { removeDir(stateHome) })
  const paths = leasePaths({ XDG_STATE_HOME: stateHome })
  assert.equal(paths.progressFile.endsWith('progress.json'), true)
  assert.equal(await readProgress(paths), null)
  await writeProgress(paths, {
    leaseId: 'lease-1', runId: 'run-1', status: 'running', step: 2, total: 5,
    op: 'text', reason: null, at: new Date().toISOString(),
  })
  const running = await readProgress(paths)
  assert.equal(running?.step, 2)
  assert.equal(running?.op, 'text')
  await clearProgress(paths)
  assert.equal(await readProgress(paths), null)
})

test('leasePaths exposes the interference prompt and answer files', () => {
  const paths = leasePaths({ XDG_STATE_HOME: '/tmp/state' })
  assert.equal(INTERFERENCE_FILE, 'interference.json')
  assert.equal(INTERFERENCE_DECISION_FILE, 'interference-decision.json')
  assert.equal(paths.interferenceFile, join('/tmp/state/hyprlease', INTERFERENCE_FILE))
  assert.equal(paths.interferenceDecisionFile, join('/tmp/state/hyprlease', INTERFERENCE_DECISION_FILE))
})

test('interference prompt and answer round-trip through the state directory', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  assert.equal(await readInterference(paths), null)
  assert.equal(await readInterferenceDecision(paths), null)

  // writeInterference creates the state directory, so the executor can publish
  // a prompt even though the lease owner created no record in this directory.
  const prompt = interferenceFor('lease-1', 'prompt-1')
  await writeInterference(paths, prompt)
  assert.deepEqual(await readInterference(paths), prompt)

  const updated = { ...prompt, id: 'prompt-2', detail: 'foreign focus event' }
  await writeInterference(paths, updated)
  assert.equal((await readInterference(paths))?.id, 'prompt-2')
  assert.equal((await readInterference(paths))?.detail, 'foreign focus event')

  const decision: InterferenceDecision = {
    id: 'prompt-2', decision: 'continue', at: new Date().toISOString(), source: 'overlay',
  }
  await writeInterferenceDecision(paths, decision)
  assert.deepEqual(await readInterferenceDecision(paths), decision)

  await clearInterference(paths)
  assert.equal(await readInterference(paths), null)
  await clearInterferenceDecision(paths)
  assert.equal(await readInterferenceDecision(paths), null)
  // Clearing again is safe, like every other record.
  await clearInterference(paths)
  await clearInterferenceDecision(paths)
})

test('a new request clears stale interference prompt and answer', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const stale = interferenceFor('previous-lease')
  await writeInterference(paths, stale)
  await writeInterferenceDecision(paths, {
    id: stale.id, decision: 'abort', at: new Date().toISOString(), source: 'overlay',
  })
  assert.notEqual(await readInterference(paths), null)

  const pending = requestLease({
    reason: 'next run', ttlMs: 5_000, consentMs: 2_000, env, spawnOverlay: fakeOverlay,
  })
  try {
    await waitForPhase(paths, 'consent')
    assert.equal(await readInterference(paths), null)
    assert.equal(await readInterferenceDecision(paths), null)
  } finally {
    await submitDecision({ action: 'deny', env })
    const outcome = await pending
    assert.equal(outcome.allowed, false)
  }
})

test('finalize clears the interference prompt and answer', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const pending = requestLease({ reason: 'finish the run', ttlMs: 5_000, consentMs: 5_000, env, spawnOverlay: fakeOverlay })
  try {
    await waitForPhase(paths, 'consent')
    await submitDecision({ action: 'allow', env })
    const outcome = await pending
    assert.equal(outcome.allowed, true)
    await writeInterference(paths, interferenceFor(outcome.leaseId))
    await writeInterferenceDecision(paths, {
      id: 'prompt-1', decision: 'abort', at: new Date().toISOString(), source: 'overlay',
    })
    assert.notEqual(await readInterference(paths), null)

    const released = await releaseLease({ action: 'done', env, waitMs: 4_000 })
    assert.equal(released.ok, true)
    await waitUntil(async () => (await readInterference(paths)) === null
      && (await readInterferenceDecision(paths)) === null, 'the finalize interference cleanup')
  } finally {
    await releaseLease({ action: 'done', env, waitMs: 1_000 })
  }
})

test('parseLeaseArgs reads __interference options', () => {
  const parsed = parseLeaseArgs(['__interference', 'continue', '--id', 'prompt-1', '--source', 'overlay', '--json'])
  assert.equal(parsed.command, '__interference')
  assert.deepEqual(parsed.args, ['continue'])
  assert.equal(parsed.options.id, 'prompt-1')
  assert.equal(parsed.options.source, 'overlay')
  assert.equal(parsed.options.json, true)
})

test('__interference records the answer and prints {ok, id, decision}', async (t) => {
  const paths = useStateHome(t)
  const prompt = interferenceFor('lease-cli', 'prompt-1')
  await writeInterference(paths, prompt)
  const stdout = sink()
  const stderr = sink()
  const code = await main(['__interference', 'continue', '--id', 'prompt-1', '--source', 'overlay', '--json'],
    { stdout, stderr })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout.text), { ok: true, id: 'prompt-1', decision: 'continue' })
  const decision = await readInterferenceDecision(paths)
  assert.equal(decision?.id, 'prompt-1')
  assert.equal(decision?.decision, 'continue')
  assert.equal(decision?.source, 'overlay')
  assert.equal(typeof decision?.at, 'string')
})

test('__interference defaults the answer source to cli', async (t) => {
  const paths = useStateHome(t)
  await writeInterference(paths, interferenceFor('lease-cli', 'prompt-2'))
  const code = await main(['__interference', 'abort', '--id', 'prompt-2', '--json'], { stdout: sink(), stderr: sink() })
  assert.equal(code, 0)
  const decision = await readInterferenceDecision(paths)
  assert.equal(decision?.decision, 'abort')
  assert.equal(decision?.source, 'cli')
})

test('__interference fails without a prompt, on a stale id, and after expiry', async (t) => {
  const paths = useStateHome(t)

  const missing = sink()
  assert.equal(await main(['__interference', 'continue', '--id', 'prompt-1', '--json'],
    { stdout: sink(), stderr: missing }), 1)
  assert.equal((JSON.parse(missing.text) as { error: { code: string } }).error.code, 'NO_LEASE')

  await writeInterference(paths, interferenceFor('lease-cli', 'prompt-1'))
  const stale = sink()
  assert.equal(await main(['__interference', 'continue', '--id', 'prompt-9', '--json'],
    { stdout: sink(), stderr: stale }), 1)
  assert.equal((JSON.parse(stale.text) as { error: { code: string } }).error.code, 'LEASE_MISMATCH')
  assert.equal(await readInterferenceDecision(paths), null)

  await writeInterference(paths, interferenceFor('lease-cli', 'prompt-1', {
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  }))
  const expired = sink()
  assert.equal(await main(['__interference', 'abort', '--id', 'prompt-1', '--json'],
    { stdout: sink(), stderr: expired }), 1)
  assert.equal((JSON.parse(expired.text) as { error: { code: string } }).error.code, 'TIMEOUT')
  assert.equal(await readInterferenceDecision(paths), null)
})

test('__interference rejects malformed arguments with USAGE', async (t) => {
  useStateHome(t)
  const badAction = sink()
  assert.equal(await main(['__interference', 'maybe', '--id', 'prompt-1'], { stdout: sink(), stderr: badAction }), 2)
  assert.match(badAction.text, /USAGE/)
  const missingId = sink()
  assert.equal(await main(['__interference', 'continue'], { stdout: sink(), stderr: missingId }), 2)
  assert.match(missingId.text, /USAGE/)
  const unknownOption = sink()
  assert.equal(await main(['__interference', 'continue', '--bogus'], { stdout: sink(), stderr: unknownOption }), 2)
})
