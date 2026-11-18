/** Lease state machine, consent flow, holder release, and failsafe helpers. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseKey, keyTaken, luaSource, configBlock, quoteShell, normalizedKey, panicCommand, uninstallBind } from '../src/lease/bind.ts'
import { main, parseLeaseArgs } from '../src/lease/cli.ts'
import {
  cleanupStaleLease, holderEntry, holdLease, leaseStatus, releaseLease, renewLease, requestLease,
  submitDecision, LEASE_RECOVERY_MARGIN_MS,
} from '../src/lease/control.ts'
import {
  acquireLock, ensureLeaseDirectory, isActive, isTerminal, leasePaths, newLeaseState, readHeartbeat, readLock,
  readState, writeControl, writeJsonAtomic, writeState,
  type LeaseConfirmCard, type LeasePaths, type LeaseRenewal, type LeaseState,
} from '../src/lease/state.ts'
import { removeDir, sink, tempDir, writeScript } from './support.ts'

/** @param ms Delay in milliseconds. */
const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Poll a condition until it holds.
 * @param predicate Condition to satisfy.
 * @param label Description used in the timeout failure.
 * @param timeoutMs How long to keep polling.
 */
async function waitUntil(predicate: () => Promise<boolean>, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  assert.fail(`timed out waiting for ${label}`)
}

/**
 * Build an isolated environment for one test.
 * @param t Test context.
 * @returns Environment pointing at a disposable state directory.
 */
function leaseEnv(t: import('node:test').TestContext): NodeJS.ProcessEnv {
  const stateHome = tempDir('hyprlease-state-')
  t.after(() => { removeDir(stateHome) })
  return { ...process.env, XDG_STATE_HOME: stateHome, HYPRSCOPE_QUICKSHELL: '/bin/false' }
}

/**
 * Build a granted lease record with renewal bookkeeping.
 * @param now Time the lease was created and granted.
 * @param overrides Fields to replace.
 * @returns Granted state record.
 */
function grantedLease(now: Date, overrides: Partial<LeaseState> = {}): LeaseState {
  const state = newLeaseState({
    leaseId: 'renew-1', reason: 'renew', consentMs: 1_000, ttlMs: 120_000, now, planBound: true,
  })
  return {
    ...state,
    phase: 'granted',
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    ...overrides,
  }
}

/**
 * Persist one state record in a disposable lease directory.
 * @param paths Lease paths.
 * @param state State to write.
 */
async function seedState(paths: LeasePaths, state: LeaseState): Promise<void> {
  await ensureLeaseDirectory(paths)
  await writeState(paths, state)
}

/**
 * Build a predicate matching a coded failure and, optionally, its recorded reason.
 * @param code Expected error code.
 * @param reason Expected `details.reason`, when the failure records one.
 * @returns Predicate for `assert.rejects`.
 */
function failsWith(
  code: string,
  reason?: string,
): (error: Error & { code?: string; details?: Record<string, unknown> }) => boolean {
  return error => error.code === code && (reason === undefined || error.details?.reason === reason)
}

/** Fake overlay that never renders. */
const fakeOverlay = async (): Promise<{ pid: number | null; exited: Promise<void>; stop(): Promise<void> }> => ({
  pid: null,
  exited: Promise.resolve(),
  stop: async () => {},
})

test('newLeaseState starts in consent with both deadlines', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const state = newLeaseState({ leaseId: 'lease-1', reason: 'demo', consentMs: 30_000, ttlMs: 60_000, now })
  assert.equal(state.phase, 'consent')
  assert.equal(state.consentDeadline, '2026-01-01T00:00:30.000Z')
  assert.equal(state.grantedAt, null)
  assert.equal(state.expiresAt, null)
})

test('phase helpers agree on terminal phases', () => {
  assert.equal(isActive('consent'), true)
  assert.equal(isActive('granted'), true)
  assert.equal(isActive('released'), false)
  for (const phase of ['released', 'denied', 'expired', 'revoked'] as const) assert.equal(isTerminal(phase), true)
  assert.equal(isTerminal('granted'), false)
})

test('lease paths live under XDG_STATE_HOME', () => {
  const paths = leasePaths({ XDG_STATE_HOME: '/tmp/state' })
  assert.equal(paths.dir, '/tmp/state/hyprlease')
  assert.equal(paths.stateFile, join('/tmp/state/hyprlease', 'state.json'))
})

test('acquireLock rejects a second live lease', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const owner = { leaseId: 'one', pid: process.pid, at: new Date().toISOString() }
  await acquireLock(paths, owner)
  await assert.rejects(acquireLock(paths, { ...owner, leaseId: 'two' }),
    (error: Error & { code?: string }) => error.code === 'LEASE_ACTIVE')
})

test('requestLease returns after approval and leaves a holder', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const pending = requestLease({ reason: 'unit test', ttlMs: 5_000, consentMs: 5_000, env, spawnOverlay: fakeOverlay })
  await delay(80)
  assert.equal((await submitDecision({ action: 'allow', env })).ok, true)
  const outcome = await pending
  assert.equal(outcome.allowed, true)
  assert.equal(outcome.phase, 'granted')
  const granted = await readState(paths)
  assert.equal(granted?.phase, 'granted')
  assert.ok((granted?.holderPid ?? 0) > 0)
  const released = await releaseLease({ action: 'done', env, waitMs: 4_000 })
  assert.equal(released.ok, true)
  assert.equal((await readState(paths))?.phase, 'released')
})

test('requestLease reports a denial and clears the lock', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const pending = requestLease({ reason: 'deny me', ttlMs: 5_000, consentMs: 5_000, env, spawnOverlay: fakeOverlay })
  await delay(80)
  await submitDecision({ action: 'deny', env })
  const outcome = await pending
  assert.equal(outcome.allowed, false)
  assert.equal(outcome.phase, 'denied')
  assert.equal(await readState(paths).then(state => state?.phase), 'denied')
})

/** The card every confirmation test asks the host to answer. */
const confirmCard: LeaseConfirmCard = {
  title: 'hyprscope · test card',
  lines: ['line one', 'line two'],
  acceptLabel: 'accept',
  denyLabel: 'deny',
}

test('a confirmation records the answer without granting control', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const pending = requestLease({
    reason: 'confirm something', approvalOnly: true, consentMs: 5_000, env, spawnOverlay: fakeOverlay, card: confirmCard,
  })
  await delay(80)
  const consent = await readState(paths)
  assert.equal(consent?.phase, 'consent')
  assert.equal(consent?.ttlMs, 0)
  assert.equal(consent?.planBound, false)
  assert.equal(consent?.approvalOnly, true)
  assert.equal(consent?.card?.title, confirmCard.title)
  assert.deepEqual(consent?.card?.lines, confirmCard.lines)
  await submitDecision({ action: 'allow', source: 'overlay', env })
  const outcome = await pending
  assert.equal(outcome.allowed, true)
  assert.equal(outcome.phase, 'released')
  assert.equal(outcome.source, 'overlay')
  const finished = await readState(paths)
  assert.equal(finished?.phase, 'released')
  assert.equal(finished?.grantedBy, 'overlay')
  // A confirmation never reaches `granted` and starts no holder, so nothing may
  // inject under it: the answer leaves a terminal record with no control window.
  assert.equal(finished?.holderPid, null)
  assert.equal(finished?.expiresAt, null)
})

test('a plan lease keeps the card the host approved in state.json', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const card: LeaseConfirmCard = {
    title: 'Agent 请求执行计划',
    lines: ['计划 act：移动指针', '共 1 步 · 预算 8 秒', '1. movePointer · 移动指针到 (1280, 720)'],
    acceptLabel: '允许操控',
    denyLabel: '拒绝',
  }
  const pending = requestLease({
    reason: 'plan card', ttlMs: 5_000, consentMs: 5_000, env, spawnOverlay: fakeOverlay,
    planBound: true,
    planSummary: { steps: 1, ops: ['movePointer'], workspace: null, summary: null },
    card,
  })
  await delay(80)
  const consent = await readState(paths)
  assert.deepEqual(consent?.card, card)
  assert.equal(consent?.planBound, true)
  await submitDecision({ action: 'deny', env })
  const outcome = await pending
  assert.equal(outcome.allowed, false)
})

test('a denied confirmation records the refusal and grants nothing', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const pending = requestLease({
    reason: 'refuse me', approvalOnly: true, consentMs: 5_000, env, spawnOverlay: fakeOverlay, card: confirmCard,
  })
  await delay(80)
  await submitDecision({ action: 'deny', source: 'overlay', env })
  const outcome = await pending
  assert.equal(outcome.allowed, false)
  assert.equal(outcome.phase, 'denied')
  assert.equal((await readState(paths))?.phase, 'denied')
})

test('a confirmation that is never answered expires', async (t) => {
  const env = leaseEnv(t)
  const outcome = await requestLease({
    reason: 'nobody answers', approvalOnly: true, consentMs: 120, env, spawnOverlay: fakeOverlay, card: confirmCard,
  })
  assert.equal(outcome.allowed, false)
  assert.equal(outcome.phase, 'expired')
})

test('a programmatic confirmation records desktop consent without a card', async (t) => {
  const env = leaseEnv(t)
  const outcome = await requestLease({
    reason: 'managed desktop', approvalOnly: true, consent: 'programmatic', env, card: confirmCard,
  })
  assert.equal(outcome.allowed, true)
  assert.equal(outcome.phase, 'released')
  assert.equal(outcome.source, 'desktop')
  assert.equal((await readState(leasePaths(env)))?.phase, 'released')
})

test('panic during consent revokes the request', async (t) => {
  const env = leaseEnv(t)
  const pending = requestLease({ reason: 'panic early', ttlMs: 5_000, consentMs: 5_000, env, spawnOverlay: fakeOverlay })
  await delay(80)
  await submitDecision({ action: 'panic', env })
  const outcome = await pending
  assert.equal(outcome.allowed, false)
  assert.equal(outcome.phase, 'revoked')
})

test('consent deadline denies the request', async (t) => {
  const env = leaseEnv(t)
  const outcome = await requestLease({ reason: 'timeout', ttlMs: 5_000, consentMs: 150, env, spawnOverlay: fakeOverlay })
  assert.equal(outcome.allowed, false)
  assert.equal(outcome.phase, 'expired')
})

test('requestLease records the resume allowance and budget', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const pending = requestLease({
    reason: 'budgeted plan', ttlMs: 5_000, consentMs: 5_000, env, spawnOverlay: fakeOverlay,
    planBound: true, maxResumes: 2, totalBudgetMs: 90_000,
  })
  await delay(80)
  const consent = await readState(paths)
  assert.equal(consent?.planBound, true)
  assert.equal(consent?.attempt, 0)
  assert.equal(consent?.maxResumes, 2)
  assert.equal(consent?.totalBudgetMs, 90_000)
  assert.deepEqual(consent?.renewals, [])
  await submitDecision({ action: 'deny', env })
  assert.equal((await pending).allowed, false)
})

test('holder releases on done and removes the lock', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const now = new Date()
  const state = newLeaseState({ leaseId: 'holder-1', reason: 'holder', consentMs: 1_000, ttlMs: 5_000, now })
  const granted: LeaseState = {
    ...state,
    phase: 'granted',
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5_000).toISOString(),
  }
  await acquireLock(paths, { leaseId: granted.leaseId, pid: process.pid, at: now.toISOString() })
  await writeState(paths, granted)
  const holding = holdLease({ leaseId: granted.leaseId, env, pollMs: 40 })
  await delay(80)
  await writeControl(paths, { leaseId: granted.leaseId, action: 'done', at: new Date().toISOString(), source: 'test' })
  await holding
  assert.equal((await readState(paths))?.phase, 'released')
  assert.equal(await readLock(paths), null)
})

test('holder ignores a control record from another lease', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const now = new Date()
  const state = newLeaseState({ leaseId: 'current', reason: 'current', consentMs: 1_000, ttlMs: 2_000, now })
  const granted: LeaseState = {
    ...state,
    phase: 'granted',
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2_000).toISOString(),
  }
  await acquireLock(paths, { leaseId: granted.leaseId, pid: process.pid, at: now.toISOString() })
  await writeState(paths, granted)
  await writeControl(paths, { leaseId: 'stale', action: 'done', at: new Date().toISOString(), source: 'agent' })
  const holding = holdLease({ leaseId: granted.leaseId, env, pollMs: 40 })
  await delay(150)
  assert.equal((await readState(paths))?.phase, 'granted')
  await writeControl(paths, { leaseId: granted.leaseId, action: 'done', at: new Date().toISOString(), source: 'agent' })
  await holding
  assert.equal((await readState(paths))?.phase, 'released')
})

test('holder expires a lease at its TTL', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const now = new Date()
  const state = newLeaseState({ leaseId: 'ttl-1', reason: 'ttl', consentMs: 1_000, ttlMs: 5_000, now })
  const granted: LeaseState = {
    ...state,
    phase: 'granted',
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 150).toISOString(),
  }
  await acquireLock(paths, { leaseId: granted.leaseId, pid: process.pid, at: now.toISOString() })
  await writeState(paths, granted)
  await holdLease({ leaseId: granted.leaseId, env, pollMs: 40 })
  assert.equal((await readState(paths))?.phase, 'expired')
})

test('renewLease extends a granted lease and records the resume', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const now = new Date('2026-01-01T00:00:30.000Z')
  await seedState(paths, grantedLease(createdAt, { maxResumes: 2, totalBudgetMs: 90_000 }))
  const renewed = await renewLease({
    leaseId: 'renew-1', ttlMs: 60_000, attempt: 1, env, now,
  })
  const expectedExpiry = '2026-01-01T00:01:30.000Z'
  assert.equal(renewed.phase, 'granted')
  assert.equal(renewed.leaseId, 'renew-1')
  assert.equal(renewed.planBound, true)
  assert.equal(renewed.attempt, 1)
  assert.equal(renewed.maxResumes, 2)
  assert.equal(renewed.totalBudgetMs, 90_000)
  // The lease TTL field keeps the originally requested value; each renewal only
  // records its own ttlMs in the lineage.
  assert.equal(renewed.ttlMs, 120_000)
  assert.equal(renewed.expiresAt, expectedExpiry)
  assert.deepEqual(renewed.renewals, [{
    at: now.toISOString(), attempt: 1, ttlMs: 60_000, expiresAt: expectedExpiry,
  }])
  assert.deepEqual(await readState(paths), renewed)
  assert.equal((await readHeartbeat(paths))?.pid, process.pid)
})

test('renewLease rejects a different lease id and leaves state alone', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const now = new Date('2026-01-01T00:00:10.000Z')
  await seedState(paths, grantedLease(createdAt, { leaseId: 'current' }))
  await assert.rejects(
    renewLease({ leaseId: 'stale', ttlMs: 60_000, attempt: 1, env, now }),
    failsWith('LEASE_MISMATCH', 'lease-id'),
  )
  const persisted = await readState(paths)
  assert.equal(persisted?.leaseId, 'current')
  assert.equal(persisted?.planBound, true)
  assert.equal(persisted?.attempt, 0)
})

test('renewLease requires a granted lease', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const now = new Date('2026-01-01T00:00:10.000Z')
  await assert.rejects(
    renewLease({ leaseId: 'renew-1', ttlMs: 60_000, attempt: 1, env, now }),
    failsWith('NO_LEASE'),
  )
  await seedState(paths, newLeaseState({
    leaseId: 'renew-1', reason: 'consent', consentMs: 30_000, ttlMs: 120_000, now, planBound: true,
  }))
  await assert.rejects(
    renewLease({ leaseId: 'renew-1', ttlMs: 60_000, attempt: 1, env, now }),
    failsWith('NO_LEASE'),
  )
})

test('renewLease rejects an expired lease', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const now = new Date('2026-01-01T00:02:05.000Z')
  await seedState(paths, grantedLease(createdAt))
  await assert.rejects(
    renewLease({ leaseId: 'renew-1', ttlMs: 60_000, attempt: 1, env, now }),
    failsWith('LEASE_MISMATCH', 'expired'),
  )
})

test('renewLease rejects a skipped attempt', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const now = new Date('2026-01-01T00:00:10.000Z')
  await seedState(paths, grantedLease(createdAt, { maxResumes: 3 }))
  await assert.rejects(
    renewLease({ leaseId: 'renew-1', ttlMs: 60_000, attempt: 2, env, now }),
    failsWith('LEASE_MISMATCH', 'attempt-skip'),
  )
})

test('renewLease rejects an attempt beyond maxResumes', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const now = new Date('2026-01-01T00:00:10.000Z')
  await seedState(paths, grantedLease(createdAt, { attempt: 1, maxResumes: 1 }))
  await assert.rejects(
    renewLease({ leaseId: 'renew-1', ttlMs: 60_000, attempt: 2, env, now }),
    failsWith('LEASE_MISMATCH', 'attempt-limit'),
  )
})

test('renewLease enforces the total budget with a margin per attempt', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const firstAt = new Date('2026-01-01T00:00:55.000Z')
  await seedState(paths, grantedLease(createdAt, { maxResumes: 2, totalBudgetMs: 60_000 }))
  const firstTtlMs = 60_000 + LEASE_RECOVERY_MARGIN_MS
  await assert.rejects(
    renewLease({ leaseId: 'renew-1', ttlMs: firstTtlMs + 1, attempt: 1, env, now: firstAt }),
    failsWith('LEASE_MISMATCH', 'budget'),
  )
  const first = await renewLease({
    leaseId: 'renew-1', ttlMs: firstTtlMs, attempt: 1, env, now: firstAt,
  })
  assert.equal(first.expiresAt, new Date(firstAt.getTime() + firstTtlMs).toISOString())
  // Attempt 2 may add one more margin: sum(ttl) <= totalBudget + attempts * margin.
  const secondAt = new Date('2026-01-01T00:01:00.000Z')
  const secondTtlMs = 60_000 + 2 * LEASE_RECOVERY_MARGIN_MS - firstTtlMs
  await assert.rejects(
    renewLease({ leaseId: 'renew-1', ttlMs: secondTtlMs + 1, attempt: 2, env, now: secondAt }),
    failsWith('LEASE_MISMATCH', 'budget'),
  )
  const second = await renewLease({
    leaseId: 'renew-1', ttlMs: secondTtlMs, attempt: 2, env, now: secondAt,
  })
  assert.equal(second.attempt, 2)
  assert.equal(second.renewals.length, 2)
})

test('renewLease tolerates a state file without renewal fields', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const now = new Date('2026-01-01T00:00:30.000Z')
  await ensureLeaseDirectory(paths)
  await writeJsonAtomic(paths.stateFile, {
    version: 1,
    leaseId: 'legacy',
    phase: 'granted',
    reason: 'legacy lease',
    planSummary: null,
    ttlMs: 120_000,
    createdAt: createdAt.toISOString(),
    consentDeadline: new Date(createdAt.getTime() + 1_000).toISOString(),
    grantedAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 120_000).toISOString(),
    endedAt: null,
    endReason: null,
    requesterPid: process.pid,
    holderPid: null,
    overlayPid: null,
    grantedBy: 'host',
  })
  const renewed = await renewLease({
    leaseId: 'legacy', ttlMs: 60_000, attempt: 1, env, now,
  })
  assert.equal(renewed.attempt, 1)
  assert.equal(renewed.maxResumes, 1)
  assert.equal(renewed.totalBudgetMs, null)
  assert.equal(renewed.renewals.length, 1)
})

test('renewLease appends each renewal to state.json', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const firstAt = new Date('2026-01-01T00:00:20.000Z')
  const secondAt = new Date('2026-01-01T00:00:40.000Z')
  await seedState(paths, grantedLease(createdAt, { maxResumes: 2 }))
  await renewLease({ leaseId: 'renew-1', ttlMs: 60_000, attempt: 1, env, now: firstAt })
  await renewLease({ leaseId: 'renew-1', ttlMs: 30_000, attempt: 2, env, now: secondAt })
  const persisted = await readState(paths)
  assert.equal(persisted?.attempt, 2)
  assert.deepEqual(persisted?.renewals.map(renewal => renewal.attempt), [1, 2])
  assert.deepEqual(persisted?.renewals.map(renewal => renewal.ttlMs), [60_000, 30_000])
  assert.equal(persisted?.renewals[1]?.expiresAt, new Date(secondAt.getTime() + 30_000).toISOString())
})

test('cleanupStaleLease revokes a lease whose owner is gone', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const now = new Date()
  const state = newLeaseState({ leaseId: 'stale-1', reason: 'stale', consentMs: 1_000, ttlMs: 5_000, now, requesterPid: 999_999 })
  await acquireLock(paths, { leaseId: state.leaseId, pid: 999_999, at: now.toISOString() })
  await writeState(paths, state)
  assert.equal(await cleanupStaleLease(paths), true)
  assert.equal((await readState(paths))?.phase, 'revoked')
})

test('status reports an idle system without a state file', async (t) => {
  const env = leaseEnv(t)
  const status = await leaseStatus(env)
  assert.equal(status.active, false)
  assert.equal(status.phase, null)
  assert.equal(status.planBound, false)
  assert.equal(status.attempt, 0)
  assert.equal(status.maxResumes, 0)
  assert.equal(status.totalBudgetMs, null)
  assert.equal(status.renewals, 0)
})

test('status exposes the renewal lineage of a resumed lease', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  const now = new Date('2026-01-01T00:01:00.000Z')
  const renewal: LeaseRenewal = {
    at: now.toISOString(),
    attempt: 1,
    ttlMs: 60_000,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  }
  await seedState(paths, {
    ...grantedLease(createdAt, { maxResumes: 3, totalBudgetMs: 120_000 }),
    attempt: 1,
    renewals: [renewal],
  })
  const status = await leaseStatus(env)
  assert.equal(status.planBound, true)
  assert.equal(status.attempt, 1)
  assert.equal(status.maxResumes, 3)
  assert.equal(status.totalBudgetMs, 120_000)
  assert.equal(status.renewals, 1)
})

test('releaseLease reports NO_LEASE when nothing is held', async (t) => {
  const env = leaseEnv(t)
  const outcome = await releaseLease({ action: 'panic', env })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.phase, null)
})

test('parseLeaseArgs keeps the exposed agent workflow commands', () => {
  const run = parseLeaseArgs(['run', 'plan.json', '--dry-run', '--consent', '10', '--json'])
  assert.equal(run.command, 'run')
  assert.deepEqual(run.args, ['plan.json'])
  assert.equal(run.options.dryRun, true)
  assert.equal(run.options.consentSec, 10)
  assert.equal(run.options.json, true)
  const status = parseLeaseArgs(['status', '--json'])
  assert.equal(status.command, 'status')
  assert.equal(status.options.json, true)
  const panic = parseLeaseArgs(['panic', '--source', 'shortcut'])
  assert.equal(panic.command, 'panic')
  assert.equal(panic.options.source, 'shortcut')
})

test('control rejects request, done and __hold as unknown commands', async () => {
  for (const command of ['request', 'done', '__hold']) {
    const stderr = sink()
    assert.equal(await main([command], { stdout: sink(), stderr }), 2, command)
    assert.match(stderr.text, /USAGE/, command)
    assert.match(stderr.text, /Unknown command/, command)
  }
})

test('control help advertises only the exposed commands', async () => {
  const stdout = sink()
  assert.equal(await main(['--help'], { stdout, stderr: sink() }), 0)
  assert.match(stdout.text, /^  status\s/m)
  assert.match(stdout.text, /^  panic\s/m)
  assert.doesNotMatch(stdout.text, /__hold/)
  assert.doesNotMatch(stdout.text, /^  request\s/m)
  assert.doesNotMatch(stdout.text, /^  done\s/m)
})

test('the internal holder entry keeps a lease and releases it on a done record', async (t) => {
  const env = leaseEnv(t)
  const paths = leasePaths(env)
  const now = new Date()
  await seedState(paths, grantedLease(now, { leaseId: 'hold-entry' }))
  const child = spawn(process.execPath, [holderEntry(), '--lease', 'hold-entry'], { env, stdio: 'ignore' })
  t.after(() => { child.kill() })
  try {
    await waitUntil(async () => (await readState(paths))?.holderPid === child.pid,
      'the internal holder to record its pid')
    assert.ok((await readHeartbeat(paths))?.pid === child.pid, 'the holder refreshes the heartbeat')
    await writeControl(paths, { leaseId: 'hold-entry', action: 'done', at: new Date().toISOString(), source: 'test' })
    await waitUntil(async () => (await readState(paths))?.phase === 'released',
      'the internal holder to release the lease')
  } finally {
    child.kill()
  }
})

test('parseLeaseArgs reads the desktop options', () => {
  const parsed = parseLeaseArgs([
    'desktop', 'start', '--size', '900x700', '--consent-source', 'card',
    '--desktop', 'agent', '--runtime-dir', '/tmp/hs', '--signature', 'sig', '--json',
  ])
  assert.equal(parsed.command, 'desktop')
  assert.deepEqual(parsed.args, ['start'])
  assert.equal(parsed.options.size, '900x700')
  assert.equal(parsed.options.consentSource, 'card')
  assert.equal(parsed.options.desktop, 'agent')
  assert.equal(parsed.options.runtimeDir, '/tmp/hs')
  assert.equal(parsed.options.signature, 'sig')
})

test('parseLeaseArgs rejects malformed input and removed command flags', () => {
  assert.throws(() => parseLeaseArgs(['run', '--consent', '0']), (error: Error & { code?: string }) => error.code === 'USAGE')
  assert.throws(() => parseLeaseArgs(['status', '--bogus']), (error: Error & { code?: string }) => error.code === 'USAGE')
  for (const flag of ['--reason', '--ttl', '--lease']) {
    assert.throws(() => parseLeaseArgs(['status', flag, 'x']), (error: Error & { code?: string }) => error.code === 'USAGE', flag)
  }
})

test('parseKey decodes modifiers and key', () => {
  assert.deepEqual(parseKey('SUPER + ALT + ESC'), { modmask: 72, name: 'Escape' })
  assert.deepEqual(parseKey('super+shift+f12'), { modmask: 65, name: 'F12' })
  assert.throws(() => parseKey('SUPER + ALT'), (error: Error & { code?: string }) => error.code === 'USAGE')
})

test('keyTaken detects an existing bind on the same combination', () => {
  const binds = [{ modmask: 72, key: 'Escape', arg: 'something' }, { modmask: 64, key: 'Q' }]
  assert.equal(keyTaken(binds, 'SUPER + ALT + ESC'), true)
  assert.equal(keyTaken(binds, 'SUPER + ALT + F12'), false)
})

test('luaSource and configBlock carry the managed markers', () => {
  const lua = luaSource('SUPER + ALT + ESC', quoteShell('/usr/bin/node') + ' panic')
  assert.match(lua, /hyprscope failsafe/)
  assert.match(lua, /hl\.bind\("SUPER \+ ALT \+ ESC"/)
  assert.match(lua, /description = "hyprscope failsafe/)
  const block = configBlock('SUPER + ALT + ESC', 'node panic')
  assert.match(block, /hl\.bind\("SUPER \+ ALT \+ Escape"/)
  assert.match(block, /description = "hyprscope failsafe/)
  assert.match(block, /hyprscope failsafe/)
})

test('normalizedKey uses the bind spelling Hyprland reports', () => {
  assert.equal(normalizedKey('SUPER + ALT + ESC'), 'SUPER + ALT + Escape')
  assert.equal(normalizedKey('super+shift+f12'), 'SUPER + SHIFT + F12')
})

test('quoteShell escapes single quotes', () => {
  assert.equal(quoteShell("it's"), `'it'\\''s'`)
})
test('panicCommand invokes the unified control surface', () => {
  const command = panicCommand({ HYPRSCOPE_NODE: '/usr/bin/node' })
  assert.match(command, /bin\/hyprscope\.ts/)
  assert.match(command, /'control' 'panic' '--source' 'shortcut'/)
  assert.doesNotMatch(command, /hyprlease/)
})
test('uninstallBind removes a legacy hyprlease block', async (t) => {
  const configDir = tempDir('hyprscope-bind-config-')
  const binDir = tempDir('hyprscope-bind-bin-')
  t.after(() => { removeDir(configDir); removeDir(binDir) })
  writeFileSync(join(configDir, 'hyprland.lua'), [
    'before = true',
    '-- >>> hyprlease failsafe >>>',
    '-- old generated block',
    '-- <<< hyprlease failsafe <<<',
    'after = true',
    '',
  ].join('\n'))
  writeFileSync(join(configDir, 'hyprlease.lua'), 'old = true\n')
  writeScript(binDir, 'hyprctl', '#!/bin/sh\nexit 0\n')
  const result = await uninstallBind({
    env: { ...process.env, HYPR_CONFIG_DIR: configDir, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    session: { runtimeDir: '/tmp', signature: 'sig' } as never,
  })
  assert.equal(result.removed, true)
  const text = readFileSync(join(configDir, 'hyprland.lua'), 'utf8')
  assert.doesNotMatch(text, /hyprlease failsafe/)
  assert.match(text, /before = true/)
  assert.match(text, /after = true/)
  assert.equal(existsSync(join(configDir, 'hyprlease.lua')), false)
  assert.ok(result.backupFile !== null && existsSync(result.backupFile))
})
