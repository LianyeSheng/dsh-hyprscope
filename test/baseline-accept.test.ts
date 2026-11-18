/** Acceptance binds the evidence bytes, not the hash recorded in the draft. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { baselinePaths, computeState, emptyFingerprint } from '../src/compat/baseline.ts'
import { CAPABILITY_IDS, CAPABILITY_SPECS } from '../src/compat/catalog.ts'
import type { BaselineDocument, CapabilityEntry, CapabilityId } from '../src/compat/types.ts'
import { ErrorCode } from '../src/errors.ts'
import {
  acceptBaseline, type BaselineConfirmation, type BaselineConfirmRequest,
} from '../src/lease/baseline.ts'

/**
 * Build one healthy verdict at its code level.
 * @param id Capability id.
 * @returns Entry record with a successful round trip.
 */
function entry(id: CapabilityId): CapabilityEntry {
  return {
    level: CAPABILITY_SPECS[id].level,
    status: 'supported',
    evidence: 'measured',
    checks: [{ name: 'round-trip', at: '2026-11-17T21:00:10.000Z', ok: true }],
    detail: null,
  }
}

/**
 * Build a complete draft for a healthy machine.
 * @param evidence Evidence record the draft claims.
 * @returns Draft document with no approval.
 */
function draft(evidence: BaselineDocument['evidence']): BaselineDocument {
  const capabilities: Record<string, CapabilityEntry> = {}
  for (const id of CAPABILITY_IDS) capabilities[id] = entry(id)
  return {
    schema: 1,
    state: computeState(capabilities),
    tool: { name: 'hyprscope', version: '0.2.0' },
    probe: {
      id: 'probe-accept', mode: 'full', script: 'baseline-accept-test',
      startedAt: '2026-11-17T21:00:00.000Z', finishedAt: '2026-11-17T21:00:30.000Z', durationMs: 30_000,
    },
    fingerprint: emptyFingerprint(),
    capabilities,
    evidence,
    approval: null,
  }
}

/** Confirmation that answers the card without a desktop. */
function approve(): Promise<BaselineConfirmation> {
  return Promise.resolve({ approved: true, source: 'cli', phase: 'released' })
}

/** Confirmation that refuses the card. */
function deny(phase = 'denied'): () => Promise<BaselineConfirmation> {
  return async () => ({ approved: false, source: 'overlay', phase })
}

/**
 * Create a state directory with one pending draft and an evidence file.
 * @param body Bytes the evidence file holds.
 * @param claimedSha Hash the draft claims, defaulting to the body's real hash.
 * @returns Environment, evidence path, and scratch directory.
 */
async function pendingState(body: string, claimedSha?: string): Promise<{ env: NodeJS.ProcessEnv; evidenceFile: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hyprscope-accept-'))
  const env = { ...process.env, XDG_STATE_HOME: dir }
  const evidenceFile = join(dir, 'evidence.txt')
  await writeFile(evidenceFile, body)
  const sha = claimedSha ?? createHash('sha256').update(body).digest('hex')
  const paths = baselinePaths(env)
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.pendingFile, JSON.stringify(draft({ file: evidenceFile, sha256: sha }), null, 2))
  return { env, evidenceFile, dir }
}

test('accept refuses a draft whose evidence bytes changed', async (t) => {
  const { env, dir } = await pendingState('facts\n', '0'.repeat(64))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await assert.rejects(acceptBaseline({ env, now: () => new Date('2026-11-17T22:00:00.000Z'), confirm: approve }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal((error as { code?: string }).code, ErrorCode.COMMAND_FAILED)
    assert.match(error.message, /evidence file changed after the probe/)
    return true
  })
})

test('accept records the hash of the reviewed evidence', async (t) => {
  const body = 'facts\n'
  const sha = createHash('sha256').update(body).digest('hex')
  const { env, dir } = await pendingState(body)
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const report = await acceptBaseline({ env, now: () => new Date('2026-11-17T22:00:00.000Z'), confirm: approve })
  assert.equal(report.accepted, true)
  assert.equal(report.source, 'cli')
  assert.equal(report.state, 'usable')
  const written = JSON.parse(await readFile(baselinePaths(env).baselineFile, 'utf8')) as BaselineDocument
  assert.equal(written.approval?.approvedBy, 'human')
  assert.equal(written.approval?.evidenceSha256, sha)
  assert.equal(written.revisions?.[0]?.kind, 'accept')
})

test('accept tolerates an evidence file that was cleaned up', async (t) => {
  const { env, evidenceFile, dir } = await pendingState('facts\n')
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await rm(evidenceFile, { force: true })
  const report = await acceptBaseline({ env, now: () => new Date('2026-11-17T22:00:00.000Z'), confirm: approve })
  assert.equal(report.accepted, true)
  assert.equal(report.source, 'cli')
  assert.match(report.warnings.join('\n'), /evidence file recorded by the draft is gone/)
})

test('accept asks the host to confirm the exact draft before writing', async (t) => {
  const { env, dir } = await pendingState('facts\n')
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const requests: BaselineConfirmRequest[] = []
  const report = await acceptBaseline({
    env,
    now: () => new Date('2026-11-17T22:00:00.000Z'),
    confirm: async (request) => {
      requests.push(request)
      return { approved: true, source: 'overlay', phase: 'released' }
    },
  })
  assert.equal(report.source, 'overlay')
  const seen = requests[0]
  assert.ok(seen !== undefined)
  assert.equal(seen.consent, 'card')
  assert.match(seen.card.title, /能力基线/)
  assert.match(seen.card.lines.join('\n'), /状态：usable/)
  assert.match(seen.card.lines.join('\n'), /必需能力：7\/7/)
  assert.match(seen.card.lines.join('\n'), /sha256 d{1}/)
})

test('the confirmation card renders in the language the caller chose', async (t) => {
  const { env, dir } = await pendingState('facts\n')
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const requests: BaselineConfirmRequest[] = []
  await acceptBaseline({
    env,
    lang: 'en',
    confirm: async (request) => {
      requests.push(request)
      return { approved: true, source: 'overlay', phase: 'released' }
    },
  })
  const seen = requests[0]
  assert.ok(seen !== undefined)
  assert.match(seen.card.title, /Accept the capability baseline/)
  assert.match(seen.card.acceptLabel, /Allow and accept/)
  assert.match(seen.card.denyLabel, /Deny/)
  assert.match(seen.card.lines.join('\n'), /Status: usable/)
  assert.match(seen.card.lines.join('\n'), /Required capabilities: 7\/7 measured/)
  assert.match(seen.reason, /accept the measured capability baseline of this machine/)
})

test('a denied confirmation leaves the draft unaccepted', async (t) => {
  const { env, dir } = await pendingState('facts\n')
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await assert.rejects(acceptBaseline({ env, confirm: deny() }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal((error as { code?: string }).code, ErrorCode.DENIED)
    assert.match(error.message, /did not confirm the baseline/)
    return true
  })
  await assert.rejects(readFile(baselinePaths(env).baselineFile, 'utf8'), /ENOENT/)
  // The draft stays so the host can probe again and reconsider.
  assert.ok((await readFile(baselinePaths(env).pendingFile, 'utf8')).length > 0)
})

test('an expired confirmation card reports the timeout, not a refusal', async (t) => {
  const { env, dir } = await pendingState('facts\n')
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await assert.rejects(acceptBaseline({ env, confirm: deny('expired') }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, ErrorCode.DENIED)
    assert.match((error as Error).message, /confirmation card expired/)
    return true
  })
})
