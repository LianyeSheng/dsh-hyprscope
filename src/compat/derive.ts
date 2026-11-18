/**
 * Capability entries derived from one measure-plan run.
 *
 * The probe no longer injects by itself: it submits a measure plan and the plan
 * executor reports what every step did. This module turns those step facts, plus
 * the observations only the probe can make (the scratch client's key events, its
 * geometry after the run, the event-socket round trip), into the baseline's
 * capability evidence.
 *
 * Three outcomes are distinguished, because a baseline verdict must not overstate
 * what was measured:
 *
 * - committed with its read-back held: `supported` with `measured` evidence;
 * - the round trip ran and the dispatch or the read-back failed: `unsupported`
 *   with `measured` evidence;
 * - a step did not run because its own premise failed (the scratch window was not
 *   floating yet, focus had moved, ...): the capability is not evidence against
 *   the machine, so it falls back to the read-only `advertised` seed or `unknown`.
 */
import type { MeasureStepFact } from '../plan/executor.ts'
import type { PlanStep } from '../plan/model.ts'
import { capabilityLevel } from './catalog.ts'
import type { ProbeCheckSpec, ProbePlan } from './probeplan.ts'
import type { CapabilityCheck, CapabilityEntry, CapabilityId } from './types.ts'

/** KEY_F12 from linux/input-event-codes.h; `tools/inject/keys.h` maps F12 to it. */
export const KEY_F12_EVDEV = 88

/** Capabilities the measure plan and its observations are expected to measure. */
export const MEASURE_CAPABILITIES: readonly CapabilityId[] = [
  'dispatch.lua',
  'dispatch.focus.window',
  'dispatch.focus.workspace',
  'dispatch.window.move',
  'dispatch.window.resize',
  'dispatch.window.float',
  'dispatch.window.pin',
  'dispatch.window.fullscreen-state',
  'observe.geometry',
  'inject.pointer',
  'inject.keyboard',
  'events.socket',
]

/** What the probe observed outside the plan. */
export interface MeasureObservations {
  /** Whether the scratch client reported the injected F12 key press. */
  keyPressed: boolean
  /** Scratch window geometry read back after the plan, when it could be read. */
  geometry: { x: number; y: number; width: number; height: number } | null
  /** Whether the scratch window's reported geometry is integral and inside the layout. */
  geometryChecks: CapabilityCheck[]
  /** The event-socket round trip (openwindow, closewindow, window gone). */
  eventChecks: CapabilityCheck[]
}

/** Inputs for {@link deriveMeasureEntries}. */
export interface DeriveInput {
  /** The measure plan the probe submitted. */
  measure: ProbePlan
  /** Facts the executor reported, one per attempted step. */
  facts: MeasureStepFact[]
  observations: MeasureObservations
  /** Advertised entries the read-only phase produced. */
  advertised: Readonly<Record<string, CapabilityEntry>>
}

/** What one derivation produced. */
export interface DeriveResult {
  entries: Record<string, CapabilityEntry>
  /** Facts that explain capabilities left unknown or unsupported. */
  warnings: string[]
}

/** One check either measured or blocked before it could measure. */
type CheckOutcome =
  | { kind: 'measured'; check: CapabilityCheck }
  | { kind: 'blocked'; detail: string }

/**
 * @param fact Recorded step that failed.
 * @returns One sentence describing the failure.
 */
function failureOf(fact: MeasureStepFact): string {
  return fact.violation?.detail ?? 'the step did not read back as expected'
}

/**
 * Describe what one step asked the desktop for, for the check record.
 * @param step Validated step the check belongs to.
 * @returns A small JSON-friendly description.
 */
function expectedForStep(step: PlanStep): unknown {
  switch (step.op) {
    case 'workspace':
      return { workspace: step.name ?? null }
    case 'focusWindow':
      return { window: step.target ?? null }
    case 'movePointer':
      return { at: step.at ?? null }
    case 'chord':
      return { keys: step.keys ?? [] }
    case 'floatWindow':
      return { floating: step.floating ?? null, pinned: step.pinned ?? null }
    case 'fullscreenWindow':
      return { internal: step.internal ?? 0, client: step.client ?? 0 }
    case 'moveWindow':
      return { x: step.x ?? null, y: step.y ?? null }
    case 'resizeWindow':
      return { width: step.width ?? null, height: step.height ?? null }
    case 'assert':
      return { asserted: (step.requires ?? []).map(predicate => predicate.kind) }
    default:
      return { op: step.op }
  }
}

/**
 * Describe what a check expected, using the plan and the requested effects.
 * @param spec Check specification.
 * @param measure Measure plan the spec belongs to.
 * @returns Expected value for the check record.
 */
function expectedFor(spec: ProbeCheckSpec, measure: ProbePlan): unknown {
  switch (spec.verify) {
    case 'geometry-position':
      return measure.moveTarget
    case 'geometry-size':
      return measure.resizeTarget
    case 'key-pressed':
      return { code: KEY_F12_EVDEV, state: 'pressed' }
    default: {
      const step = measure.plan.steps[spec.steps[0] ?? 0]
      return step === undefined ? null : expectedForStep(step)
    }
  }
}

/**
 * Evaluate the post-run observation that proves an effect landed.
 * @param spec Check specification.
 * @param measure Measure plan carrying the requested effects.
 * @param observations What the probe observed outside the plan.
 * @returns Whether the effect was observed, and what was seen.
 */
function verifyFor(
  spec: ProbeCheckSpec,
  measure: ProbePlan,
  observations: MeasureObservations,
): { ok: boolean; observed: unknown; detail: string | null } {
  switch (spec.verify) {
    case undefined:
      return { ok: true, observed: null, detail: null }
    case 'key-pressed':
      return observations.keyPressed
        ? { ok: true, observed: { code: KEY_F12_EVDEV, state: 'pressed' }, detail: null }
        : {
            ok: false,
            observed: { code: KEY_F12_EVDEV, state: 'absent' },
            detail: 'the scratch client did not report the injected F12 key press',
          }
    case 'geometry-position': {
      const target = measure.moveTarget
      const geometry = observations.geometry
      if (target === null) return { ok: false, observed: null, detail: 'the measure plan carried no move destination' }
      if (geometry === null) {
        return { ok: false, observed: null, detail: 'the scratch window geometry could not be read back' }
      }
      const ok = Math.abs(geometry.x - target.x) <= 1 && Math.abs(geometry.y - target.y) <= 1
      return {
        ok,
        observed: { x: geometry.x, y: geometry.y },
        detail: ok ? null : 'the scratch window did not read back at the requested position',
      }
    }
    case 'geometry-size': {
      const target = measure.resizeTarget
      const geometry = observations.geometry
      if (target === null) return { ok: false, observed: null, detail: 'the measure plan carried no resize target' }
      if (geometry === null) {
        return { ok: false, observed: null, detail: 'the scratch window geometry could not be read back' }
      }
      const ok = geometry.width === target.width && geometry.height === target.height
      return {
        ok,
        observed: { width: geometry.width, height: geometry.height },
        detail: ok ? null : 'the scratch window did not read back at the requested size',
      }
    }
    default:
      return { ok: false, observed: null, detail: `unknown verification ${String(spec.verify)}` }
  }
}

/**
 * Turn one check specification into evidence.
 *
 * A premise failure on a measurement step is reported as "blocked": the round
 * trip never ran, so it is not evidence that the machine cannot do it. A failed
 * `assert` step is different: the assertion is the read-back, so its failure is
 * a measured failure.
 * @param spec Check specification.
 * @param measure Measure plan the spec belongs to.
 * @param facts Step facts keyed by step index.
 * @param observations Post-run observations.
 * @returns Measured check or the reason it could not run.
 */
function buildCheck(
  spec: ProbeCheckSpec,
  measure: ProbePlan,
  facts: ReadonlyMap<number, MeasureStepFact>,
  observations: MeasureObservations,
): CheckOutcome {
  const recorded: MeasureStepFact[] = []
  for (const index of spec.steps) {
    const fact = facts.get(index)
    if (fact === undefined) {
      return { kind: 'blocked', detail: 'the measure plan did not reach this step' }
    }
    recorded.push(fact)
  }
  const failed = recorded.find(fact => fact.stage !== 'done')
  if (failed !== undefined) {
    if (failed.stage === 'preflight' && failed.op !== 'assert') {
      return { kind: 'blocked', detail: failureOf(failed) }
    }
    return {
      kind: 'measured',
      check: {
        name: spec.name,
        at: failed.at,
        expected: expectedFor(spec, measure),
        observed: { stage: failed.stage, violation: failed.violation },
        ok: false,
        detail: failureOf(failed),
      },
    }
  }
  const verify = verifyFor(spec, measure, observations)
  const last = recorded[recorded.length - 1]!
  return {
    kind: 'measured',
    check: {
      name: spec.name,
      at: last.at,
      expected: expectedFor(spec, measure),
      observed: verify.observed ?? { effects: recorded.map(fact => fact.effect) },
      ok: verify.ok,
      ...(verify.detail === null ? {} : { detail: verify.detail }),
    },
  }
}

/**
 * Choose the strongest detail among failed checks.
 * @param checks Recorded checks.
 * @returns One sentence.
 */
function failureDetail(checks: CapabilityCheck[]): string | null {
  const failed = [...checks].reverse().find(check => !check.ok && typeof check.detail === 'string')
  return failed?.detail ?? null
}

/**
 * Derive the capability entries one measure plan and its observations support.
 *
 * The aggregation rule is deliberately the old probe's: a capability with at
 * least one held round trip is supported even when another direction failed
 * (a float-off that timed out does not invalidate a float-on that read back),
 * and a capability whose every recorded check failed is unsupported. A
 * capability with no measured check falls back to the read-only advertisement,
 * so a required capability still ends up `unknown` rather than silently granted.
 * @param input Measure plan, step facts, observations, and advertised seeds.
 * @returns Entries for the capabilities the measure plan covers, and warnings.
 */
export function deriveMeasureEntries(input: DeriveInput): DeriveResult {
  const facts = new Map(input.facts.map(fact => [fact.step, fact]))
  const warnings: string[] = []
  const checks = new Map<CapabilityId, CapabilityCheck[]>()
  const blocked = new Map<CapabilityId, string>()
  const add = (id: CapabilityId, check: CapabilityCheck): void => {
    const list = checks.get(id) ?? []
    list.push(check)
    checks.set(id, list)
  }
  for (const spec of input.measure.checks) {
    const outcome = buildCheck(spec, input.measure, facts, input.observations)
    if (outcome.kind === 'blocked') {
      if (!blocked.has(spec.capability)) blocked.set(spec.capability, outcome.detail)
      continue
    }
    add(spec.capability, outcome.check)
    // A move or resize read-back also proves the coordinate system is readable.
    if (spec.verify === 'geometry-position' || spec.verify === 'geometry-size') {
      add('observe.geometry', {
        ...outcome.check,
        name: spec.verify === 'geometry-position' ? 'move-readback' : 'resize-readback',
      })
    }
  }
  for (const check of input.observations.geometryChecks) add('observe.geometry', check)
  for (const check of input.observations.eventChecks) add('events.socket', check)

  const entries: Record<string, CapabilityEntry> = {}
  for (const id of MEASURE_CAPABILITIES) {
    const level = capabilityLevel(id)
    const recorded = checks.get(id) ?? []
    const hasOk = recorded.some(check => check.ok)
    if (hasOk) {
      entries[id] = { level, status: 'supported', evidence: 'measured', checks: recorded, detail: null }
      const failedNames = recorded.filter(check => !check.ok).map(check => check.name)
      if (failedNames.length > 0) warnings.push(`${id}: recorded checks failed: ${failedNames.join(', ')}`)
      continue
    }
    if (recorded.length > 0) {
      const detail = failureDetail(recorded) ?? 'the recorded round trip did not read back as expected'
      entries[id] = { level, status: 'unsupported', evidence: 'measured', checks: recorded, detail }
      warnings.push(`${id}: ${detail}`)
      continue
    }
    const limitation = input.measure.limitations.find(entry => entry.capability === id)
    const detail = limitation?.detail
      ?? blocked.get(id)
      ?? 'the measure plan did not reach this step'
    const seed = input.advertised[id]
    const advertised = seed !== undefined && seed.evidence === 'advertised'
    if (advertised) {
      // A required capability that was only advertised must stay unknown; an
      // optional one may stay usable on its advertisement, as before.
      entries[id] = level === 'required'
        ? { level, status: 'unknown', evidence: 'advertised', checks: seed.checks ?? [], detail }
        : { level, status: 'supported', evidence: 'advertised', checks: seed.checks ?? [], detail: null }
      warnings.push(`${id}: ${detail}`)
      continue
    }
    entries[id] = { level, status: 'unknown', evidence: 'unknown', checks: [], detail }
    warnings.push(`${id}: ${detail}`)
  }
  return { entries, warnings: [...new Set(warnings)] }
}
