/** Capability derivation from measure-plan facts and probe observations. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveMeasureEntries, KEY_F12_EVDEV, MEASURE_CAPABILITIES, type MeasureObservations } from '../src/compat/derive.ts'
import { buildProbePlan, PROBE_WINDOW, type ProbePlan } from '../src/compat/probeplan.ts'
import { CAPABILITY_SPECS } from '../src/compat/catalog.ts'
import type { CapabilityCheck, CapabilityEntry, CapabilityId } from '../src/compat/types.ts'
import type { MeasureStepFact, MeasureStage } from '../src/plan/executor.ts'
import { validatePlan } from '../src/plan/validate.ts'

const AT = '2026-11-18T10:00:00.000Z'

/** Facts the probe reads before the measure plan in every test. */
const INPUT = { workspace: 'dev', origin: { x: 0, y: 0 }, restoreWindow: '0xabc' }

/**
 * Build one successful check.
 * @param name Check name.
 * @param observed What was seen.
 * @returns Passing check record.
 */
function okCheck(name: string, observed: unknown = 'ok'): CapabilityCheck {
  return { name, at: AT, expected: 'ok', observed, ok: true }
}

/**
 * Build a synthetic step fact.
 * @param step Step index.
 * @param op Step op.
 * @param overrides Fields to replace.
 * @returns Fact record.
 */
function fact(step: number, op: MeasureStepFact['op'], overrides: Partial<MeasureStepFact> = {}): MeasureStepFact {
  return {
    step, op, at: AT, stage: 'done' as MeasureStage,
    effect: 'ok', violation: null, durationMs: 4,
    ...overrides,
  }
}

/**
 * Build facts for every step the plan's checks reference.
 * @param plan Measure plan.
 * @param overrides Facts to replace, keyed by step index.
 * @returns One fact per checked step.
 */
function factsFor(plan: ProbePlan, overrides: Record<number, MeasureStepFact> = {}): MeasureStepFact[] {
  const indexes = [...new Set(plan.checks.flatMap(check => check.steps))].sort((left, right) => left - right)
  return indexes.map(index => {
    const replaced = overrides[index]
    if (replaced !== undefined) return replaced
    const step = plan.plan.steps[index]!
    return fact(index, step.op)
  })
}

/**
 * Find the step index a named check owns.
 * @param plan Measure plan.
 * @param capability Capability the check belongs to.
 * @param name Check name.
 * @returns Step indexes of that check.
 */
function stepsOf(plan: ProbePlan, capability: CapabilityId, name: string): number[] {
  const spec = plan.checks.find(check => check.capability === capability && check.name === name)
  assert.ok(spec !== undefined, `no check ${capability}/${name}`)
  return spec.steps
}

/**
 * Build the observations of a healthy round trip.
 * @param overrides Fields to replace.
 * @returns Observation record.
 */
function observations(overrides: Partial<MeasureObservations> = {}): MeasureObservations {
  return {
    keyPressed: true,
    geometry: { x: 0, y: 0, width: 360, height: 240 },
    geometryChecks: [okCheck('client-geometry', { integer: true, insideLayout: true })],
    eventChecks: [okCheck('event-round-trip', { openwindow: true, closewindow: true, windowGone: true })],
    ...overrides,
  }
}

/**
 * Build one advertised seed entry.
 * @param id Capability id.
 * @returns Entry with advertised evidence.
 */
function seed(id: CapabilityId): CapabilityEntry {
  return {
    level: CAPABILITY_SPECS[id].level,
    status: 'unknown',
    evidence: 'advertised',
    checks: [okCheck('protocol-global')],
    detail: 'advertised by the read-only phase',
  }
}

/**
 * Derive entries for the standard plan and healthy observations.
 * @param overrides Facts to replace, keyed by step index.
 * @param observed Post-run observations.
 * @param advertised Advertised seeds.
 * @returns Derivation result.
 */
function derive(
  overrides: Record<number, MeasureStepFact> = {},
  observed: MeasureObservations = observations(),
  advertised: Record<string, CapabilityEntry> = {},
) {
  const plan = buildProbePlan(INPUT)
  return {
    plan,
    ...deriveMeasureEntries({
      measure: plan,
      facts: factsFor(plan, overrides),
      observations: observed,
      advertised,
    }),
  }
}

/**
 * Read one derived entry, asserting it exists.
 * @param entries Derived entries.
 * @param id Capability id.
 * @returns The entry.
 */
function entryOf(entries: Record<string, CapabilityEntry>, id: CapabilityId): CapabilityEntry {
  const entry = entries[id]
  assert.ok(entry !== undefined, `no derived entry for ${id}`)
  return entry
}

test('a healthy measure run marks every measured capability supported with measured evidence', () => {
  const { entries, warnings } = derive()
  for (const id of MEASURE_CAPABILITIES) {
    const entry = entryOf(entries, id)
    assert.equal(entry.level, CAPABILITY_SPECS[id].level, `${id} level`)
    assert.equal(entry.status, 'supported', `${id} status`)
    assert.equal(entry.evidence, 'measured', `${id} evidence`)
    assert.ok(entry.checks.length > 0, `${id} carries checks`)
  }
  assert.deepEqual(warnings, [])
  // The plan's own read-back checks are recorded per direction.
  assert.ok(entryOf(entries, 'dispatch.window.float').checks.some(check => check.name === 'float-on'))
  assert.ok(entryOf(entries, 'dispatch.window.float').checks.some(check => check.name === 'float-off'))
  assert.ok(entryOf(entries, 'inject.pointer').checks.some(check => check.name === 'pointer-move'))
  assert.ok(entryOf(entries, 'inject.keyboard').checks.some(check => check.name === 'key-f12'))
  const move = entryOf(entries, 'dispatch.window.move').checks[0]!
  assert.deepEqual(move.expected, { x: 0, y: 0 })
  assert.deepEqual(move.observed, { x: 0, y: 0 })
  const resize = entryOf(entries, 'dispatch.window.resize').checks[0]!
  assert.deepEqual(resize.expected, { width: 360, height: 240 })
  const windowCapture = entryOf(entries, 'capture.window').checks[0]!
  assert.equal(windowCapture.name, 'window-capture')
  assert.deepEqual(windowCapture.expected, { window: PROBE_WINDOW, region: null })
  // observe.geometry combines the framework check with both read-backs.
  const geometryNames = entryOf(entries, 'observe.geometry').checks.map(check => check.name)
  assert.ok(geometryNames.includes('client-geometry'))
  assert.ok(geometryNames.includes('move-readback'))
  assert.ok(geometryNames.includes('resize-readback'))
})

test('a rejected dispatch is a measured failure, not a missing measurement', () => {
  const plan = buildProbePlan(INPUT)
  const workspaceStep = stepsOf(plan, 'dispatch.lua', 'idempotent-workspace-dispatch')[0]!
  const { entries, warnings } = derive({
    [workspaceStep]: fact(workspaceStep, 'workspace', {
      stage: 'commit',
      violation: { kind: 'postcondition', detail: 'dispatch workspace failed', expected: null, observed: null },
    }),
  })
  for (const id of ['dispatch.lua', 'dispatch.focus.workspace'] as const) {
    const entry = entryOf(entries, id)
    assert.equal(entry.status, 'unsupported', `${id} status`)
    assert.equal(entry.evidence, 'measured', `${id} evidence`)
    assert.match(entry.detail ?? '', /dispatch workspace failed/)
  }
  assert.ok(warnings.some(warning => warning.startsWith('dispatch.lua: dispatch workspace failed')))
})

test('a window capture the compositor refuses is a measured unsupported capability', () => {
  const plan = buildProbePlan(INPUT)
  const captureStep = stepsOf(plan, 'capture.window', 'window-capture')[0]!
  const { entries, warnings } = derive({
    [captureStep]: fact(captureStep, 'screenshot', {
      stage: 'commit',
      violation: {
        kind: 'postcondition', detail: 'the compositor could not capture this window',
        expected: 'a PNG of the window', observed: null,
      },
    }),
  })
  const entry = entryOf(entries, 'capture.window')
  assert.equal(entry.status, 'unsupported')
  assert.equal(entry.evidence, 'measured')
  assert.match(entry.detail ?? '', /could not capture this window/)
  assert.ok(warnings.some(warning => warning.startsWith('capture.window:')))
})

test('a broken premise is not evidence against the machine: it falls back to advertised or unknown', () => {
  const plan = buildProbePlan(INPUT)
  const focusStep = stepsOf(plan, 'dispatch.focus.window', 'focus-scratch')[0]!
  const blocked = fact(focusStep, 'focusWindow', {
    stage: 'preflight',
    violation: {
      kind: 'target.missing', detail: 'target window is not present', expected: 'present', observed: 'absent',
    },
  })
  const withoutSeed = derive({ [focusStep]: blocked })
  const unknown = entryOf(withoutSeed.entries, 'dispatch.focus.window')
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.evidence, 'unknown')
  assert.match(unknown.detail ?? '', /target window is not present/)

  const withSeed = derive({ [focusStep]: blocked }, observations(), { 'dispatch.focus.window': seed('dispatch.focus.window') })
  const advertised = entryOf(withSeed.entries, 'dispatch.focus.window')
  // dispatch.focus.window is optional, so its advertisement keeps it usable.
  assert.equal(advertised.status, 'supported')
  assert.equal(advertised.evidence, 'advertised')
  assert.equal(advertised.checks.length, 1)
})

test('a required capability that only has an advertisement stays unknown', () => {
  const plan = buildProbePlan(INPUT)
  const chordStep = stepsOf(plan, 'inject.keyboard', 'key-f12')[0]!
  const blocked = fact(chordStep, 'chord', {
    stage: 'preflight',
    violation: { kind: 'window.focused', detail: 'the declared window does not hold focus', expected: '0x1', observed: '0x2' },
  })
  const { entries } = derive({ [chordStep]: blocked }, observations(), { 'inject.keyboard': seed('inject.keyboard') })
  const entry = entryOf(entries, 'inject.keyboard')
  assert.equal(entry.level, 'required')
  assert.equal(entry.status, 'unknown')
  assert.equal(entry.evidence, 'advertised')
})

test('a failed assertion is a measured failure even though asserts do not commit', () => {
  const plan = buildProbePlan(INPUT)
  const assertStep = stepsOf(plan, 'inject.pointer', 'pointer-move')[1]!
  const { entries } = derive({
    [assertStep]: fact(assertStep, 'assert', {
      stage: 'preflight',
      violation: {
        kind: 'pointer.position', detail: 'pointer is not where the step expects it',
        expected: { x: 640, y: 360 }, observed: { x: 0, y: 0 },
      },
    }),
  })
  const entry = entryOf(entries, 'inject.pointer')
  assert.equal(entry.status, 'unsupported')
  assert.equal(entry.evidence, 'measured')
  assert.match(entry.detail ?? '', /pointer is not where/)
})

test('a chord whose key never reaches the scratch client is unsupported', () => {
  const { entries } = derive({}, observations({ keyPressed: false }))
  const entry = entryOf(entries, 'inject.keyboard')
  assert.equal(entry.status, 'unsupported')
  assert.match(entry.detail ?? '', /did not report the injected F12/)
})

test('a move that does not read back at the destination is unsupported, while geometry stays supported', () => {
  const { entries } = derive({}, observations({ geometry: { x: 50, y: 0, width: 360, height: 240 } }))
  const move = entryOf(entries, 'dispatch.window.move')
  assert.equal(move.status, 'unsupported')
  assert.match(move.detail ?? '', /did not read back at the requested position/)
  // The scratch window still reported integer geometry inside the layout, so
  // the coordinate system itself remains supported; the failed read-back is a
  // capability failure for the dispatcher, not for observation.
  const geometry = entryOf(entries, 'observe.geometry')
  assert.equal(geometry.status, 'supported')
  assert.ok(geometry.checks.some(check => check.name === 'move-readback' && !check.ok))
})

test('a resize that lands at another size is unsupported', () => {
  const { entries } = derive({}, observations({ geometry: { x: 0, y: 0, width: 320, height: 200 } }))
  const entry = entryOf(entries, 'dispatch.window.resize')
  assert.equal(entry.status, 'unsupported')
  assert.match(entry.detail ?? '', /did not read back at the requested size/)
})

test('a failed client-geometry check makes observe.geometry unsupported', () => {
  const plan = buildProbePlan(INPUT)
  const moveStep = stepsOf(plan, 'dispatch.window.move', 'move-scratch')[0]!
  const resizeStep = stepsOf(plan, 'dispatch.window.resize', 'resize-scratch')[0]!
  const blocked = (index: number): MeasureStepFact => fact(index, plan.plan.steps[index]!.op, {
    stage: 'preflight',
    violation: { kind: 'target.missing', detail: 'target window is not present', expected: 'present', observed: 'absent' },
  })
  const { entries } = derive(
    { [moveStep]: blocked(moveStep), [resizeStep]: blocked(resizeStep) },
    observations({ geometryChecks: [{ name: 'client-geometry', at: AT, observed: null, ok: false, detail: 'no integer geometry' }] }),
  )
  const entry = entryOf(entries, 'observe.geometry')
  assert.equal(entry.status, 'unsupported')
  assert.equal(entry.evidence, 'measured')
})

test('a failed event round trip is an unsupported event socket, not a missing measurement', () => {
  const { entries } = derive({}, observations({
    eventChecks: [{
      name: 'event-round-trip', at: AT,
      expected: { app: 'hyprscope-scratch' },
      observed: { openwindow: true, closewindow: false, windowGone: false },
      ok: false,
      detail: 'the closewindow event for the scratch window did not arrive',
    }],
  }))
  const entry = entryOf(entries, 'events.socket')
  assert.equal(entry.status, 'unsupported')
  assert.equal(entry.evidence, 'measured')
  assert.match(entry.detail ?? '', /closewindow event/)
})

test('a plan limitation names why a capability was not measured', () => {
  const plan = buildProbePlan({ workspace: 'dev', origin: null, restoreWindow: null })
  const indexes = [...new Set(plan.checks.flatMap(check => check.steps))]
  const facts = indexes.map(index => fact(index, plan.plan.steps[index]!.op))
  const { entries } = deriveMeasureEntries({ measure: plan, facts, observations: observations(), advertised: {} })
  const move = entryOf(entries, 'dispatch.window.move')
  assert.equal(move.status, 'unknown')
  assert.equal(move.evidence, 'unknown')
  assert.match(move.detail ?? '', /no monitor layout was read/)
  // The resize round trip does not need the layout origin, so it stays measured.
  assert.equal(entryOf(entries, 'dispatch.window.resize').status, 'supported')
})

test('a plan that never ran leaves required capabilities unknown and optional ones advertised', () => {
  const plan = buildProbePlan(INPUT)
  const advertised = {
    'inject.pointer': seed('inject.pointer'),
    'inject.keyboard': seed('inject.keyboard'),
    'dispatch.window.move': seed('dispatch.window.move'),
  }
  const { entries, warnings } = deriveMeasureEntries({
    measure: plan,
    facts: [],
    observations: observations({ geometryChecks: [], eventChecks: [] }),
    advertised,
  })
  // required: stays unknown, never becomes usable on an advertisement
  assert.equal(entryOf(entries, 'inject.pointer').status, 'unknown')
  assert.equal(entryOf(entries, 'inject.pointer').evidence, 'advertised')
  assert.equal(entryOf(entries, 'inject.keyboard').status, 'unknown')
  // optional: keeps its advertisement, as the probe always did
  assert.equal(entryOf(entries, 'dispatch.window.move').status, 'supported')
  assert.equal(entryOf(entries, 'dispatch.window.move').evidence, 'advertised')
  // no seed at all: unknown with the reason
  const noSeed = entryOf(entries, 'dispatch.window.resize')
  assert.equal(noSeed.status, 'unknown')
  assert.equal(noSeed.evidence, 'unknown')
  assert.ok(warnings.some(warning => warning.startsWith('inject.pointer:')))
})

test('the derived checks use the code catalog levels and the F12 evdev code', () => {
  assert.equal(KEY_F12_EVDEV, 88)
  const { entries } = derive()
  for (const [id, entry] of Object.entries(entries)) {
    assert.equal(entry.level, CAPABILITY_SPECS[id as CapabilityId].level, `${id} level`)
  }
  // The measure plan is a real plan the executor/validator accept.
  const plan = buildProbePlan(INPUT)
  assert.doesNotThrow(() => validatePlan(plan.plan))
})
