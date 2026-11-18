/** The capability gate that rejects a plan before any consent card appears. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeState, effectiveCapabilities, emptyFingerprint } from '../src/compat/baseline.ts'
import { CAPABILITY_IDS, CAPABILITY_SPECS } from '../src/compat/catalog.ts'
import {
  assertControlAvailable, assertFreshBaseline, assertPlanCapabilities, CapabilityError, missingRequiredIssues,
  planCapabilityIssues,
} from '../src/compat/gate.ts'
import type { StalenessReport } from '../src/compat/staleness.ts'
import type {
  BaselineDocument, CapabilityCheck, CapabilityEntry, CapabilityId, CapabilityStatus, EvidenceLevel,
  LoadedBaseline,
} from '../src/compat/types.ts'
import { ErrorCode, HyprscopeError } from '../src/errors.ts'
import { OP_SPECS, type Plan } from '../src/plan/model.ts'
import { validatePlan } from '../src/plan/validate.ts'

const APPROVED_AT = '2026-11-17T22:00:00.000Z'
const WINDOW_ID = '0x55a1'

/** Verdict fields a fixture may replace for one capability. */
interface EntryOverrides {
  status?: CapabilityStatus
  evidence?: EvidenceLevel
}

/** Fields a fixture may omit or replace. */
interface BaselineOverrides {
  omit?: CapabilityId[]
  entries?: Record<string, CapabilityEntry>
}

/**
 * Build one successful round-trip record.
 * @returns Check record that a measured entry needs.
 */
function check(): CapabilityCheck {
  return { name: 'round-trip', at: '2026-11-17T21:00:10.000Z', ok: true }
}

/**
 * Build one capability verdict at its code level.
 * @param id Capability id.
 * @param overrides Verdict fields to replace.
 * @returns Entry record.
 */
function entry(id: CapabilityId, overrides: EntryOverrides = {}): CapabilityEntry {
  return {
    level: CAPABILITY_SPECS[id].level,
    status: overrides.status ?? 'supported',
    evidence: overrides.evidence ?? 'measured',
    checks: [check()],
    detail: null,
  }
}

/**
 * Build the baseline the gate sees, computing the state and the effective set
 * with the reader's own rules instead of hand-writing them.
 * @param overrides Capabilities to omit or replace.
 * @returns Loaded baseline for a healthy machine by default.
 */
function acceptedBaseline(overrides: BaselineOverrides = {}): LoadedBaseline {
  const capabilities: Record<string, CapabilityEntry> = {}
  for (const id of CAPABILITY_IDS) {
    if (overrides.omit?.includes(id) === true) continue
    capabilities[id] = entry(id)
  }
  Object.assign(capabilities, overrides.entries ?? {})
  const warnings: string[] = []
  const state = computeState(capabilities, warnings)
  const effective = effectiveCapabilities(capabilities, warnings)
  const document: BaselineDocument = {
    schema: 1,
    state,
    tool: { name: 'hyprscope', version: '0.2.0' },
    probe: {
      id: 'probe-1', mode: 'full', script: 'compat-gate-test-1',
      startedAt: '2026-11-17T21:00:00.000Z', finishedAt: '2026-11-17T21:00:30.000Z', durationMs: 30_000,
    },
    fingerprint: emptyFingerprint(),
    capabilities,
    evidence: null,
    approval: { approvedAt: APPROVED_AT, approvedBy: 'human', source: 'cli', evidenceSha256: null },
  }
  return { document, state, effective, warnings, approvedAt: APPROVED_AT }
}

/**
 * Validate a plan literal into a plan.
 * @param steps Plan steps.
 * @returns Validated plan.
 */
function planOf(steps: unknown[]): Plan {
  return validatePlan({ version: 1, reason: 'capability gate test', steps })
}

test('no baseline is one issue with no capability that names the baseline command', () => {
  const issues = planCapabilityIssues(planOf([{ op: 'assert' }]), null)
  assert.equal(issues.length, 1)
  const issue = issues[0]!
  assert.equal(issue.path, '$')
  assert.equal(issue.capability, null)
  assert.equal(issue.level, null)
  assert.match(issue.message, /No accepted capability baseline exists/)
  assert.match(issue.message, /hyprscope control baseline --probe/)
})

test('an incomplete baseline reports only the unmeasured required capabilities', () => {
  const baseline = acceptedBaseline({
    entries: {
      'observe.cursor': entry('observe.cursor', { evidence: 'advertised' }),
      'observe.window.modes': entry('observe.window.modes', { evidence: 'unknown' }),
    },
  })
  assert.equal(baseline.state, 'incomplete')
  // The plan also uses optional capabilities the machine lacks; the incomplete
  // state must short-circuit before those are considered.
  const plan = planOf([{
    op: 'assert',
    requires: [{ kind: 'window.state', target: { id: WINDOW_ID }, floating: true }],
  }])
  const issues = planCapabilityIssues(plan, baseline)
  assert.deepEqual(issues.map(issue => issue.capability), ['observe.cursor'])
  assert.equal(issues[0]?.path, '$')
  assert.equal(issues[0]?.level, 'required')
  assert.match(issues[0]?.message ?? '', /required capability "observe\.cursor" is not measured as supported/)
  assert.doesNotMatch(JSON.stringify(issues), /observe\.window\.modes/)
  assert.doesNotMatch(JSON.stringify(issues), /window\.state/)
})

test('a moveWindow step names the missing capability and its step path', () => {
  const baseline = acceptedBaseline({ omit: ['dispatch.window.move'] })
  assert.equal(baseline.effective.has('dispatch.window.move'), false)
  const plan = planOf([{
    op: 'moveWindow',
    target: { id: WINDOW_ID },
    x: 10,
    y: 20,
    requires: [{ kind: 'window.exists', target: { id: WINDOW_ID } }],
  }])
  const issues = planCapabilityIssues(plan, baseline)
  assert.equal(issues.length, 1)
  const issue = issues[0]!
  assert.equal(issue.path, '$.steps[0]')
  assert.equal(issue.capability, 'dispatch.window.move')
  assert.equal(issue.level, 'optional')
  assert.match(issue.message, /step 1 "moveWindow" needs capability "dispatch\.window\.move" \(optional\)/)
})

test('a predicate dependency is reported even when the op itself needs nothing', () => {
  const baseline = acceptedBaseline({ omit: ['dispatch.focus.window'] })
  assert.deepEqual([...OP_SPECS.assert.requires], [])
  const plan = planOf([{
    op: 'assert',
    requires: [{ kind: 'window.focused', target: { id: WINDOW_ID } }],
  }])
  const issues = planCapabilityIssues(plan, baseline)
  assert.equal(issues.length, 1)
  const issue = issues[0]!
  assert.equal(issue.path, '$.steps[0]')
  assert.equal(issue.capability, 'dispatch.focus.window')
  assert.equal(issue.level, 'optional')
  assert.match(issue.message, /step 1 predicate "window\.focused" needs capability "dispatch\.focus\.window"/)
})

test('a degraded baseline still allows a plan whose capabilities are effective', () => {
  const baseline = acceptedBaseline({ omit: ['safety.failsafe-bind'] })
  assert.equal(baseline.state, 'degraded')
  assert.equal(baseline.effective.has('safety.failsafe-bind'), false)
  const plan = planOf([{ op: 'workspace', name: 'agent' }, { op: 'assert' }])
  assert.deepEqual(planCapabilityIssues(plan, baseline), [])
  assert.doesNotThrow(() => assertPlanCapabilities(plan, baseline))
})

test('assertPlanCapabilities throws CapabilityError carrying every issue', () => {
  const baseline = acceptedBaseline({ omit: ['capture.grim'] })
  const plan = planOf([{ op: 'screenshot', label: 'before' }])
  const expected = planCapabilityIssues(plan, baseline)
  assert.equal(expected.length, 1)
  assert.throws(() => assertPlanCapabilities(plan, baseline), (error: unknown) => {
    assert.ok(error instanceof CapabilityError)
    assert.ok(error instanceof HyprscopeError)
    assert.equal(error.name, 'CapabilityError')
    assert.equal(error.code, 'CAPABILITY')
    assert.equal(error.code, ErrorCode.CAPABILITY)
    assert.equal(error.details.state, 'usable')
    assert.deepEqual(error.details.issues, expected)
    assert.deepEqual(error.issues, expected)
    assert.equal(error.issues[0]?.capability, 'capture.grim')
    return true
  })
})

test('assertControlAvailable refuses a missing baseline but accepts usable and degraded ones', () => {
  assert.throws(() => assertControlAvailable(null), (error: unknown) => {
    assert.ok(error instanceof CapabilityError)
    assert.equal(error.code, ErrorCode.CAPABILITY)
    assert.equal(error.details.state, null)
    assert.equal(error.issues.length, 1)
    assert.equal(error.issues[0]?.capability, null)
    assert.match(error.issues[0]?.message ?? '', /hyprscope control baseline --probe/)
    return true
  })
  const usable = acceptedBaseline()
  assert.equal(usable.state, 'usable')
  assert.doesNotThrow(() => assertControlAvailable(usable))
  const degraded = acceptedBaseline({ omit: ['safety.failsafe-bind'] })
  assert.equal(degraded.state, 'degraded')
  // Degradation removes one safety path, not control itself.
  assert.doesNotThrow(() => assertControlAvailable(degraded))
})

test('missingRequiredIssues names every required capability the baseline did not measure', () => {
  const baseline = acceptedBaseline({
    entries: {
      'dispatch.lua': entry('dispatch.lua', { status: 'unsupported', evidence: 'unknown' }),
      'inject.keyboard': entry('inject.keyboard', { evidence: 'advertised' }),
    },
  })
  assert.equal(baseline.state, 'incomplete')
  const issues = missingRequiredIssues(baseline)
  assert.deepEqual(issues.map(issue => issue.capability), ['dispatch.lua', 'inject.keyboard'])
  for (const issue of issues) {
    assert.equal(issue.path, '$')
    assert.equal(issue.level, 'required')
    assert.match(issue.message, /is not measured as supported, so this machine cannot take control/)
  }
})
test('floatWindow only requires the halves the step actually sets', () => {
  const floatOnly = planOf([{
    op: 'floatWindow', target: { id: WINDOW_ID }, floating: true,
    requires: [{ kind: 'window.exists', target: { id: WINDOW_ID } }],
  }])
  const withoutPin = acceptedBaseline({ omit: ['dispatch.window.pin'] })
  assert.equal(withoutPin.state, 'usable')
  assert.deepEqual(planCapabilityIssues(floatOnly, withoutPin), [])

  const withoutFloat = acceptedBaseline({ omit: ['dispatch.window.float'] })
  const issues = planCapabilityIssues(floatOnly, withoutFloat)
  assert.deepEqual(issues.map(issue => issue.capability), ['dispatch.window.float'])
})

test('floatWindow still refuses a pinned step when the machine cannot pin', () => {
  const pinned = planOf([{
    op: 'floatWindow', target: { id: WINDOW_ID }, pinned: true,
    requires: [{ kind: 'window.exists', target: { id: WINDOW_ID } }],
  }])
  const withoutPin = acceptedBaseline({ omit: ['dispatch.window.pin'] })
  const issues = planCapabilityIssues(pinned, withoutPin)
  assert.deepEqual(issues.map(issue => issue.capability), ['dispatch.window.pin'])
  assert.match(issues[0]?.message ?? '', /step 1 "floatWindow"/)
})

test('window.state only requires the modes the predicate asserts', () => {
  const floatingOnly = planOf([{
    op: 'assert',
    requires: [{ kind: 'window.state', target: { id: WINDOW_ID }, floating: true }],
  }])
  assert.deepEqual(planCapabilityIssues(floatingOnly, acceptedBaseline({ omit: ['dispatch.window.pin'] })), [])
  assert.deepEqual(planCapabilityIssues(floatingOnly, acceptedBaseline({ omit: ['dispatch.window.float'] })), [{
    path: '$.steps[0]',
    capability: 'dispatch.window.float',
    level: 'optional',
    message: 'step 1 predicate "window.state" needs capability "dispatch.window.float" (optional), '
      + "which this machine's baseline does not support",
  }])
})

/** One staleness report for the freshness tests. */
function staleness(overrides: Partial<StalenessReport> = {}): StalenessReport {
  return {
    verdict: 'fresh',
    reasons: [],
    differences: [],
    measuredAt: '2026-11-17T22:00:00.000Z',
    recorded: true,
    ...overrides,
  }
}

test('a fresh baseline passes the freshness gate', () => {
  assert.doesNotThrow(() => assertFreshBaseline(staleness()))
})

test('a stale baseline is refused before any consent card', () => {
  assert.throws(
    () => assertFreshBaseline(staleness({
      verdict: 'stale',
      differences: [{ field: 'configHash', recorded: 'a', observed: 'b' }],
    })),
    (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY'
      && error.issues[0]?.message.includes('configHash') === true,
  )
})

test('an unverified baseline is refused and names the re-probe command', () => {
  assert.throws(
    () => assertFreshBaseline(staleness({ verdict: 'unverified', recorded: false, reasons: ['no effective values'] })),
    (error: unknown) => error instanceof CapabilityError
      && error.issues[0]?.message.includes('hyprscope control baseline --probe') === true,
  )
})

test('a missing comparison fails closed', () => {
  assert.throws(() => assertFreshBaseline(null), (error: unknown) => error instanceof CapabilityError)
})

test('the gate reports one issue per missing capability, not one per step', () => {
  const twoMoves = planOf([
    {
      op: 'moveWindow', target: { id: WINDOW_ID }, x: 10, y: 20,
      requires: [{ kind: 'window.exists', target: { id: WINDOW_ID } }],
    },
    {
      op: 'moveWindow', target: { id: WINDOW_ID }, x: 30, y: 40,
      requires: [{ kind: 'window.exists', target: { id: WINDOW_ID } }],
    },
  ])
  const issues = planCapabilityIssues(twoMoves, acceptedBaseline({ omit: ['dispatch.window.move'] }))
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.path, '$.steps[0]')
  assert.equal(issues[0]?.capability, 'dispatch.window.move')
})
