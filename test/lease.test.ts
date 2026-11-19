/** Lease state machine, consent flow, holder release, and failsafe helpers. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  parseKey, keyTaken, luaSource, configBlock, quoteShell, normalizedKey, panicCommand, messageCommand,
  annotateCommand, annotateShortcutPath, installBind, uninstallBind,
} from '../src/lease/bind.ts'
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
  const install = parseLeaseArgs([
    'install-bind', '--key', 'SUPER + ALT + ESC', '--message-key', 'SUPER + ALT + M', '--annotate-key', 'SUPER + ALT + A',
  ])
  assert.equal(install.command, 'install-bind')
  assert.equal(install.options.key, 'SUPER + ALT + ESC')
  assert.equal(install.options.messageKey, 'SUPER + ALT + M')
  assert.equal(install.options.annotateKey, 'SUPER + ALT + A')
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
  assert.match(stdout.text, /--annotate-key/)
  assert.match(stdout.text, /desktop-annotate/)
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
  const stateDir = tempDir('hyprscope-bind-state-')
  t.after(() => removeDir(stateDir))
  const messageDir = join(stateDir, 'hyprscope', 'message')
  mkdirSync(messageDir, { recursive: true })
  writeFileSync(join(messageDir, 'shortcut.txt'), 'SUPER + ALT + M' + String.fromCharCode(10))
  writeFileSync(join(messageDir, 'annotate-shortcut.txt'), 'SUPER + ALT + A' + String.fromCharCode(10))
  writeScript(binDir, 'hyprctl', '#!/bin/sh\nexit 0\n')
  const result = await uninstallBind({
    env: {
      ...process.env, HYPR_CONFIG_DIR: configDir, XDG_STATE_HOME: stateDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    session: { runtimeDir: '/tmp', signature: 'sig' } as never,
  })
  assert.equal(result.removed, true)
  const text = readFileSync(join(configDir, 'hyprland.lua'), 'utf8')
  assert.doesNotMatch(text, /hyprlease failsafe/)
  assert.match(text, /before = true/)
  assert.match(text, /after = true/)
  assert.equal(existsSync(join(configDir, 'hyprlease.lua')), false)
  assert.equal(existsSync(join(messageDir, 'shortcut.txt')), false)
  assert.equal(existsSync(join(messageDir, 'annotate-shortcut.txt')), false)
  assert.ok(result.backupFile !== null && existsSync(result.backupFile))
})
test('messageCommand runs the desktop-message surface', () => {
  const command = messageCommand({ HYPRSCOPE_NODE: '/usr/bin/node' })
  assert.match(command, /bin\/hyprscope\.ts' 'message' 'open'/)
  assert.doesNotMatch(command, /'control'/)
})

test('annotateCommand runs the desktop-message surface in annotate mode', () => {
  const command = annotateCommand({ HYPRSCOPE_NODE: '/usr/bin/node' })
  assert.match(command, /bin\/hyprscope\.ts' 'message' 'annotate'/)
  assert.doesNotMatch(command, /'control'/)
})

test('luaSource and configBlock register all three managed binds', () => {
  const lua = luaSource(
    'SUPER + ALT + ESC', 'node panic', 'SUPER + ALT + M', 'node message', 'SUPER + ALT + A', 'node annotate',
  )
  assert.match(lua, /hl\.bind\("SUPER \+ ALT \+ ESC"/)
  assert.match(lua, /hl\.bind\("SUPER \+ ALT \+ M"/)
  assert.match(lua, /hl\.bind\("SUPER \+ ALT \+ A"/)
  assert.match(lua, /hyprscope message: open the desktop composer/)
  assert.match(lua, /hyprscope: desktop annotate/)
  const block = configBlock(
    'SUPER + ALT + ESC', 'node panic', 'SUPER + ALT + M', 'node message', 'SUPER + ALT + A', 'node annotate',
  )
  assert.match(block, /hl\.bind\("SUPER \+ ALT \+ M"/)
  assert.match(block, /hl\.bind\("SUPER \+ ALT \+ A"/)
  assert.match(block, /hyprscope message: open the desktop composer/)
  assert.match(block, /hyprscope: desktop annotate/)
})

/** Fake `hyprctl` used by the install tests: two `binds` reads around one reload. */
const FAKE_HYPRCTL = [
  '#!/bin/sh',
  'count_file="$(dirname "$0")/binds-count"',
  'cmd="$2"',
  'if [ "$cmd" = "binds" ]; then',
  '  count=0',
  '  [ -f "$count_file" ] && count=$(cat "$count_file")',
  '  count=$((count + 1))',
  '  printf "%s" "$count" > "$count_file"',
  '  if [ "$count" -ge 2 ]; then cat "$(dirname "$0")/binds-after.json"; else cat "$(dirname "$0")/binds-before.json"; fi',
  '  exit 0',
  'fi',
  'if [ "$cmd" = "configerrors" ]; then cat "$(dirname "$0")/config-errors.json"; exit 0; fi',
  'exit 0',
  '',
].join(String.fromCharCode(10))

/** Directories and environment one bind install runs against. */
interface BindFixture {
  configDir: string
  stateDir: string
  messageDir: string
  env: NodeJS.ProcessEnv
}

/**
 * Build a disposable Hyprland config and a fake `hyprctl` that answers the
 * conflict read, the post-reload read and `configerrors`.
 * @param t Test context.
 * @param before Bind records reported before the install.
 * @param after Bind records reported after the reload.
 * @param configErrors Configuration errors reported after the reload.
 * @returns Fixture.
 */
function bindFixture(
  t: import('node:test').TestContext,
  before: unknown[],
  after: unknown[],
  configErrors: string[] = [],
): BindFixture {
  const configDir = tempDir('hyprscope-bind-config-')
  const binDir = tempDir('hyprscope-bind-bin-')
  const stateDir = tempDir('hyprscope-bind-state-')
  t.after(() => { removeDir(configDir); removeDir(binDir); removeDir(stateDir) })
  writeFileSync(join(configDir, 'hyprland.lua'), 'existing = true' + String.fromCharCode(10))
  writeFileSync(join(binDir, 'binds-before.json'), JSON.stringify(before))
  writeFileSync(join(binDir, 'binds-after.json'), JSON.stringify(after))
  writeFileSync(join(binDir, 'config-errors.json'), JSON.stringify(configErrors))
  writeScript(binDir, 'hyprctl', FAKE_HYPRCTL)
  const oldPath = process.env.PATH
  process.env.PATH = binDir + ':' + (oldPath ?? '')
  t.after(() => { process.env.PATH = oldPath })
  const messageDir = join(stateDir, 'hyprscope', 'message')
  return {
    configDir,
    stateDir,
    messageDir,
    env: {
      ...process.env,
      HYPR_CONFIG_DIR: configDir,
      XDG_STATE_HOME: stateDir,
      HYPRSCOPE_MESSAGE_DIR: messageDir,
      PATH: binDir + ':' + (oldPath ?? ''),
    },
  }
}

/** Bind descriptions the fake `hyprctl` reports after a successful reload. */
const INSTALLED_BINDS = [
  { description: 'hyprscope failsafe: revoke desktop control' },
  { description: 'hyprscope message: open the desktop composer' },
  { description: 'hyprscope: desktop annotate' },
]

/** Session stand-in the bind tests hand to the functions. */
const bindSession = { runtimeDir: '/tmp', signature: 'sig' } as never

test('installBind writes all three binds, verifies them and records both shortcuts', async (t) => {
  const fixture = bindFixture(t, [], INSTALLED_BINDS)
  const result = await installBind({
    env: fixture.env,
    session: bindSession,
    now: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(result.key, 'SUPER + ALT + Escape')
  assert.equal(result.messageKey, 'SUPER + ALT + M')
  assert.equal(result.annotateKey, 'SUPER + ALT + A')
  assert.match(result.messageCommand, /'message' 'open'/)
  assert.match(result.annotateCommand, /'message' 'annotate'/)
  assert.equal(result.verified, true)
  assert.equal(result.messageVerified, true)
  assert.equal(result.annotateVerified, true)
  const config = readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8')
  assert.match(config, /existing = true/)
  assert.equal((config.match(/hl\.bind\(/g) ?? []).length, 3)
  assert.match(config, /hl\.bind\("SUPER \+ ALT \+ Escape"/)
  assert.match(config, /hl\.bind\("SUPER \+ ALT \+ M"/)
  assert.match(config, /hl\.bind\("SUPER \+ ALT \+ A"/)
  assert.match(config, /description = "hyprscope: desktop annotate"/)
  assert.equal((config.match(/>>> hyprscope failsafe >>>/g) ?? []).length, 1)
  // The annotate record lives beside shortcut.txt, the path the overlay reads.
  assert.equal(result.annotateShortcutFile, join(fixture.messageDir, 'annotate-shortcut.txt'))
  assert.equal(result.annotateShortcutFile, annotateShortcutPath(fixture.env))
  assert.equal(readFileSync(result.shortcutFile, 'utf8').trim(), 'SUPER + ALT + M')
  assert.equal(readFileSync(result.annotateShortcutFile, 'utf8').trim(), 'SUPER + ALT + A')
  assert.ok(result.backupFile !== null && existsSync(result.backupFile))
  assert.equal(existsSync(join(fixture.configDir, 'hyprscope.lua')), true)
})

test('installBind records an --annotate-key override in the config and the overlay file', async (t) => {
  const fixture = bindFixture(t, [], INSTALLED_BINDS)
  const result = await installBind({
    annotateKey: 'super + shift + a',
    env: fixture.env,
    session: bindSession,
  })
  assert.equal(result.annotateKey, 'SUPER + SHIFT + A')
  assert.match(result.annotateCommand, /'message' 'annotate'/)
  const config = readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8')
  assert.match(config, /hl\.bind\("SUPER \+ SHIFT \+ A", .*hyprscope: desktop annotate/)
  assert.doesNotMatch(config, /hl\.bind\("SUPER \+ ALT \+ A"/)
  assert.equal(readFileSync(result.annotateShortcutFile, 'utf8').trim(), 'SUPER + SHIFT + A')
  assert.equal(readFileSync(result.shortcutFile, 'utf8').trim(), 'SUPER + ALT + M')
})

test('installBind refuses a message key that is already bound', async (t) => {
  const fixture = bindFixture(t, [{ modmask: 72, key: 'M', description: 'foreign bind' }], INSTALLED_BINDS)
  await assert.rejects(
    installBind({ env: fixture.env, session: bindSession }),
    (error: Error & { code?: string }) => error.code === 'BIND_FAILED' && /SUPER \+ ALT \+ M/.test(error.message),
  )
  assert.doesNotMatch(readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8'), /hl\.bind/)
})

test('installBind refuses an annotate key that is already bound', async (t) => {
  const fixture = bindFixture(t, [{ modmask: 72, key: 'A', description: 'foreign bind' }], INSTALLED_BINDS)
  await assert.rejects(
    installBind({ env: fixture.env, session: bindSession }),
    (error: Error & { code?: string }) => error.code === 'BIND_FAILED' && /SUPER \+ ALT \+ A/.test(error.message),
  )
  assert.doesNotMatch(readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8'), /hl\.bind/)
})

test('installBind refuses to bind the same key twice', async (t) => {
  const configDir = tempDir('hyprscope-bind-same-config-')
  const stateDir = tempDir('hyprscope-bind-same-state-')
  t.after(() => { removeDir(configDir); removeDir(stateDir) })
  writeFileSync(join(configDir, 'hyprland.lua'), 'existing = true' + String.fromCharCode(10))
  await assert.rejects(
    installBind({
      key: 'SUPER + ALT + M',
      messageKey: 'SUPER + ALT + M',
      env: { ...process.env, HYPR_CONFIG_DIR: configDir, XDG_STATE_HOME: stateDir },
      session: bindSession,
    }),
    (error: Error & { code?: string }) => error.code === 'BIND_FAILED' && /must differ/.test(error.message),
  )
})

test('installBind refuses an annotate key that duplicates a managed key', async (t) => {
  const fixture = bindFixture(t, [], INSTALLED_BINDS)
  await assert.rejects(
    installBind({
      annotateKey: 'super+alt+m',
      env: fixture.env,
      session: bindSession,
    }),
    (error: Error & { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'BIND_FAILED'
      && /must differ/.test(error.message)
      && Array.isArray(error.details?.duplicated)
      && (error.details?.duplicated as string[]).includes('SUPER + ALT + M'),
  )
  assert.doesNotMatch(readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8'), /hl\.bind/)
})

test('a reinstall replaces all three managed binds instead of treating them as conflicts', async (t) => {
  const fixture = bindFixture(t, [
    { modmask: 72, key: 'Escape', description: 'hyprscope failsafe: revoke desktop control' },
    { modmask: 72, key: 'M', description: 'hyprscope message: open the desktop composer' },
    { modmask: 72, key: 'A', description: 'hyprscope: desktop annotate' },
  ], INSTALLED_BINDS)
  const result = await installBind({ env: fixture.env, session: bindSession })
  assert.equal(result.verified, true)
  assert.equal(result.messageVerified, true)
  assert.equal(result.annotateVerified, true)
  const config = readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8')
  assert.equal((config.match(/>>> hyprscope failsafe >>>/g) ?? []).length, 1)
  assert.equal((config.match(/hl\.bind\(/g) ?? []).length, 3)
  assert.equal(readFileSync(result.annotateShortcutFile, 'utf8').trim(), 'SUPER + ALT + A')
})

test('a failed reload verification restores the config, the Lua file and both shortcut records', async (t) => {
  // The reload reports the failsafe and message binds but not the annotate one.
  const fixture = bindFixture(t, [], INSTALLED_BINDS.slice(0, 2))
  const original = readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8')
  mkdirSync(fixture.messageDir, { recursive: true })
  writeFileSync(join(fixture.messageDir, 'shortcut.txt'), 'OLD MESSAGE' + String.fromCharCode(10))
  writeFileSync(join(fixture.messageDir, 'annotate-shortcut.txt'), 'OLD ANNOTATE' + String.fromCharCode(10))
  await assert.rejects(
    installBind({ env: fixture.env, session: bindSession }),
    (error: Error & { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'BIND_FAILED'
      && error.details?.annotateVerified === false
      && error.details?.verified === true
      && error.details?.messageVerified === true,
  )
  assert.equal(readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8'), original)
  assert.equal(existsSync(join(fixture.configDir, 'hyprscope.lua')), false)
  assert.equal(readFileSync(join(fixture.messageDir, 'shortcut.txt'), 'utf8'), 'OLD MESSAGE' + String.fromCharCode(10))
  assert.equal(readFileSync(join(fixture.messageDir, 'annotate-shortcut.txt'), 'utf8'),
    'OLD ANNOTATE' + String.fromCharCode(10))
})

test('a partial verification leaves no shortcut records behind', async (t) => {
  const fixture = bindFixture(t, [], INSTALLED_BINDS.slice(0, 2))
  const original = readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8')
  await assert.rejects(
    installBind({ env: fixture.env, session: bindSession }),
    (error: Error & { code?: string }) => error.code === 'BIND_FAILED',
  )
  assert.equal(readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8'), original)
  assert.equal(existsSync(join(fixture.configDir, 'hyprscope.lua')), false)
  assert.equal(existsSync(join(fixture.messageDir, 'shortcut.txt')), false)
  assert.equal(existsSync(join(fixture.messageDir, 'annotate-shortcut.txt')), false)
})

test('a broken configuration restores the config and both shortcut records', async (t) => {
  const fixture = bindFixture(t, [], INSTALLED_BINDS, ['hl.bind(...) failed in hyprscope.lua'])
  mkdirSync(fixture.messageDir, { recursive: true })
  writeFileSync(join(fixture.messageDir, 'shortcut.txt'), 'OLD MESSAGE' + String.fromCharCode(10))
  const original = readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8')
  await assert.rejects(
    installBind({ env: fixture.env, session: bindSession }),
    (error: Error & { code?: string }) => error.code === 'BIND_FAILED' && /broke the Hyprland configuration/.test(error.message),
  )
  assert.equal(readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8'), original)
  assert.equal(existsSync(join(fixture.configDir, 'hyprscope.lua')), false)
  assert.equal(readFileSync(join(fixture.messageDir, 'shortcut.txt'), 'utf8'), 'OLD MESSAGE' + String.fromCharCode(10))
  assert.equal(existsSync(join(fixture.messageDir, 'annotate-shortcut.txt')), false)
})

test('uninstallBind removes the managed block, the Lua file and both shortcut records', async (t) => {
  const fixture = bindFixture(t, [], INSTALLED_BINDS)
  writeFileSync(join(fixture.configDir, 'hyprland.lua'), [
    'before = true',
    configBlock('SUPER + ALT + ESC', 'node panic', 'SUPER + ALT + M', 'node message', 'SUPER + ALT + A', 'node annotate'),
    'after = true',
    '',
  ].join('\n'))
  writeFileSync(join(fixture.configDir, 'hyprscope.lua'), 'generated = true' + String.fromCharCode(10))
  mkdirSync(fixture.messageDir, { recursive: true })
  writeFileSync(join(fixture.messageDir, 'shortcut.txt'), 'SUPER + ALT + M' + String.fromCharCode(10))
  writeFileSync(join(fixture.messageDir, 'annotate-shortcut.txt'), 'SUPER + ALT + A' + String.fromCharCode(10))
  const result = await uninstallBind({ env: fixture.env, session: bindSession })
  assert.equal(result.removed, true)
  const text = readFileSync(join(fixture.configDir, 'hyprland.lua'), 'utf8')
  assert.doesNotMatch(text, />>> hyprscope failsafe >>>/)
  assert.match(text, /before = true/)
  assert.match(text, /after = true/)
  assert.equal(existsSync(join(fixture.configDir, 'hyprscope.lua')), false)
  assert.equal(existsSync(join(fixture.messageDir, 'shortcut.txt')), false)
  assert.equal(existsSync(join(fixture.messageDir, 'annotate-shortcut.txt')), false)
  assert.ok(result.backupFile !== null && existsSync(result.backupFile))
})
